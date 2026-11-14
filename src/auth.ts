import { google } from "googleapis";
import { OAuth2Client, Credentials, CodeChallengeMethod } from "google-auth-library";
import * as http from "http";
import * as crypto from "crypto";
import { escapeHtml } from "./guards.js";
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
  "https://www.googleapis.com/auth/gmail.modify",
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

/**
 * Pure decision for an OAuth callback request: wrong/missing state or missing
 * code -> 400 (no token exchange); already handled -> 410; otherwise proceed.
 */
export function decideCallback(
  params: { state: string | null; code: string | null },
  expectedState: string,
  alreadyHandled: boolean
): { status: 200 | 400 | 410; proceed: boolean } {
  if (alreadyHandled) return { status: 410, proceed: false };
  if (params.state !== expectedState || !params.code) return { status: 400, proceed: false };
  return { status: 200, proceed: true };
}

async function saveToken(emailHash: string, tokens: Credentials): Promise<void> {
  await ensureDirs();
  const tokenPath = getTokenPath(emailHash);
  // Owner-only: these are live credentials. mode applies on creation; chmod
  // covers files that already existed with looser permissions.
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
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

    // Loopback only: never reachable from other machines on the network.
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        const err = new Error("Failed to start local server");
        rejectUrl(err);
        reject(err);
        return;
      }
      const port = address.port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const oauth2Client = createOAuth2Client(redirectUri);

      // state defends against forged callbacks (CSRF); PKCE binds the code
      // exchange to this process.
      const state = crypto.randomBytes(32).toString("hex");
      const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
      resolveUrl(authUrl);

      let handled = false;

      server.on("request", async (req, res) => {
        try {
          const url = new URL(req.url || "", `http://127.0.0.1:${port}`);
          const code = url.searchParams.get("code");
          const decision = decideCallback(
            { state: url.searchParams.get("state"), code },
            state,
            handled
          );

          if (!decision.proceed) {
            res.writeHead(decision.status, { "Content-Type": "text/html" });
            res.end(
              decision.status === 410
                ? "<h1>This sign-in link was already used</h1>"
                : "<h1>Error: invalid sign-in callback</h1>"
            );
            return;
          }
          handled = true;

          const { tokens } = await oauth2Client.getToken({ code: code!, codeVerifier });
          oauth2Client.setCredentials(tokens);

          // Get the email address for this account
          const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
          const userInfo = await oauth2.userinfo.get();
          const email = userInfo.data.email;

          if (!email) {
            throw new Error("Could not retrieve email from Google account");
          }

          const emailHash = hashEmail(email);
          // Bind the name first: if it belongs to a different Google account
          // this throws, and no orphan token is written.
          await addAccount(accountName, email);
          await saveToken(emailHash, tokens);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<h1>Authorization successful!</h1><p>Account "${escapeHtml(accountName)}" (${escapeHtml(email)}) connected. You can close this tab.</p>`
          );

          clearTimeout(timeout);
          server.close();
          resolve(email);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><pre>${escapeHtml(String(err))}</pre>`);
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
