#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerGmailTools } from "./gmail.js";
import { registerCalendarTools } from "./calendar.js";
import { registerContactsTools } from "./contacts.js";
import { startOAuthFlow, checkTokenHealth } from "./auth.js";
import { loadConfig, ensureDirs } from "./config.js";
import { logAction, sanitizeErrorText } from "./logger.js";

const server = new McpServer({
  name: "mariana-google-mcp",
  version: "1.0.0",
});

// --- google_auth ---
server.tool(
  "google_auth",
  "Authenticate a Google account. Returns the consent URL IMMEDIATELY (does not block): give it to the user, they approve in the browser as the right Google account, and the token saves in the background. Confirm afterwards with google_status. A browser tab also opens automatically as a convenience, but the URL in the response is authoritative if it opens in the wrong profile.",
  {
    account_name: z
      .string()
      .optional()
      .default("primary")
      .describe("Friendly name for this account (e.g. 'primary', 'newsletters')"),
  },
  async ({ account_name }) => {
    try {
      const { authUrl, completion } = await startOAuthFlow(account_name);

      // Log completion (or failure) in the background; the tool returns now.
      completion
        .then((email) =>
          logAction({
            timestamp: new Date().toISOString(),
            tool: "google_auth",
            account: account_name,
            summary: `Account authenticated: ${email}`,
          })
        )
        .catch((err) =>
          logAction({
            timestamp: new Date().toISOString(),
            tool: "google_auth",
            account: account_name,
            summary: `Auth flow did not complete: ${sanitizeErrorText(String(err?.message ?? err))}`,
          })
        );

      return {
        content: [
          {
            type: "text" as const,
            text: `Consent flow started for account "${account_name}". Have the user open this URL and approve as the correct Google account (a browser tab may have opened already):\n\n${authUrl}\n\nThe token saves automatically on completion (15-minute window). Verify with google_status.`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Authentication failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- google_status ---
server.tool(
  "google_status",
  "Check connection health for all configured Google accounts with a LIVE credential check against Google (not just local file state). tokenStatus 'needs_reauth' means run google_auth for that account.",
  {},
  async () => {
    const config = await loadConfig();
    const accounts = Object.entries(config.accounts);

    if (accounts.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No accounts configured. Use google_auth to set up your first account.",
          },
        ],
      };
    }

    const statuses = await Promise.all(
      accounts.map(async ([name, entry]) => {
        const tokenStatus = await checkTokenHealth(entry.emailHash);
        return {
          account: name,
          label: entry.label,
          tokenStatus,
          isDefault: name === config.defaultGmailAccount,
          services: ["gmail", "calendar", "contacts"],
        };
      })
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify(statuses, null, 2) }],
    };
  }
);

// Register all tool modules
registerGmailTools(server);
registerCalendarTools(server);
registerContactsTools(server);

// Start server
async function main() {
  await ensureDirs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
