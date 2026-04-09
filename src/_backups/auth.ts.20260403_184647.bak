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
export async function runOAuthFlow(accountName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(0, async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start local server"));
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

          server.close();
          resolve(email);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h1>Error</h1><pre>${err}</pre>`);
          server.close();
          reject(err);
        }
      });

      await open(authUrl);
    });
  });
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
 * Check if a token exists and is not obviously expired for a given account.
 */
export async function checkTokenHealth(emailHash: string): Promise<"valid" | "expired" | "missing"> {
  const tokens = await loadToken(emailHash);
  if (!tokens) return "missing";
  if (tokens.expiry_date && tokens.expiry_date < Date.now() && !tokens.refresh_token) {
    return "expired";
  }
  return "valid";
}
