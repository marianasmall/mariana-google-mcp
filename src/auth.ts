import { google } from "googleapis";
import { OAuth2Client, Credentials } from "google-auth-library";
import * as http from "http";
import * as fs from "fs/promises";
import open from "open";
import {
  ensureDirs,
  getTokenPath,
  hashEmail,
  addAccount,
  loadConfig,
  resolveAccount,
} from "./config.js";

const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
];

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required."
    );
  }
  return { clientId, clientSecret };
}

function createOAuth2Client(redirectUri: string): OAuth2Client {
  const { clientId, clientSecret } = getClientCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function saveToken(emailHash: string, tokens: Credentials): Promise<void> {
  await ensureDirs();
  const tokenPath = getTokenPath(emailHash);
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
}

async function loadToken(emailHash: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(getTokenPath(emailHash), "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Run interactive OAuth flow: start local HTTP server, open browser,
 * wait for callback, exchange code for tokens.
 * Returns the authenticated email address.
 */
/**
 * Start the OAuth consent flow WITHOUT blocking on completion.
 * Returns the consent URL immediately; the token is saved in the background
 * when the user finishes in the browser. The local callback server times out
 * after 15 minutes. `completion` resolves with the authenticated email.
 */
export async function startOAuthFlow(
  accountName: string
): Promise<{ authUrl: string; completion: Promise<string> }> {
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const urlReady = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });

  const completion = new Promise<string>((resolve, reject) => {
    const server = http.createServer();
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 15 minutes without consent"));
    }, 15 * 60 * 1000);

    server.listen(0, async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        const err = new Error("Failed to start local server");
        rejectUrl(err);
        reject(err);
        return;
      }
      const port = address.port;
      const redirectUri = `http://localhost:${port}`;
      const oauth2Client = createOAuth2Client(redirectUri);

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
      });
      resolveUrl(authUrl);

      server.on("request", async (req, res) => {
        try {
          const url = new URL(req.url || "", `http://localhost:${port}`);
          const code = url.searchParams.get("code");

          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<h1>Error: No authorization code received</h1>");
            return;
          }

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          // Get the email address for this account
          const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
          const userInfo = await oauth2.userinfo.get();
          const email = userInfo.data.email;

          if (!email) {
            throw new Error("Could not retrieve email from Google account");
          }

          const emailHash = hashEmail(email);
          await saveToken(emailHash, tokens);
          await addAccount(accountName, email);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<h1>Authorization successful!</h1><p>Account "${accountName}" (${email}) connected. You can close this tab.</p>`
          );

          clearTimeout(timeout);
          server.close();
          resolve(email);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><pre>${err}</pre>`);
          clearTimeout(timeout);
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // Best effort: open the default browser. The URL is also returned to the
      // caller, so a missed/wrong-profile browser window is recoverable.
      try {
        await open(authUrl);
      } catch {
        /* URL returned to caller regardless */
      }
    });
  });

  const authUrl = await urlReady;
  return { authUrl, completion };
}

/** Blocking variant kept for compatibility: waits for the user to finish consent. */
export async function runOAuthFlow(accountName: string): Promise<string> {
  const { completion } = await startOAuthFlow(accountName);
  return completion;
}

/**
 * Get an authenticated OAuth2Client for a specific account.
 * Auto-refreshes tokens if expired.
 */
export async function getAuthClient(accountParam?: string): Promise<{
  client: OAuth2Client;
  accountName: string;
}> {
  const resolved = await resolveAccount(accountParam);
  if (!resolved) {
    throw new Error(
      accountParam
        ? `Account "${accountParam}" not found. Run google_auth to add it.`
        : "No accounts configured. Run google_auth to set up your first account."
    );
  }

  const tokens = await loadToken(resolved.emailHash);
  if (!tokens) {
    throw new Error(
      `No token found for account "${resolved.name}". Run google_auth to re-authenticate.`
    );
  }

  const oauth2Client = createOAuth2Client("http://localhost");
  oauth2Client.setCredentials(tokens);

  // Auto-refresh: listen for new tokens and save them
  oauth2Client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveToken(resolved.emailHash, merged);
  });

  return { client: oauth2Client, accountName: resolved.name };
}

/**
 * Check token health with a LIVE credential check, not just local file inspection.
 * Attempts a token refresh against Google: a revoked/expired refresh token
 * (invalid_grant) reports "needs_reauth" instead of falsely claiming "valid".
 * A successful refresh is persisted, so the check also heals stale access tokens.
 */
export async function checkTokenHealth(
  emailHash: string
): Promise<"valid" | "needs_reauth" | "missing"> {
  const tokens = await loadToken(emailHash);
  if (!tokens) return "missing";

  const client = createOAuth2Client("http://localhost");
  client.setCredentials(tokens);
  try {
    const res = await client.getAccessToken();
    if (!res.token) return "needs_reauth";
    await saveToken(emailHash, { ...tokens, ...client.credentials });
    return "valid";
  } catch {
    return "needs_reauth";
  }
}
