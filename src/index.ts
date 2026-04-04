#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerGmailTools } from "./gmail.js";
import { registerCalendarTools } from "./calendar.js";
import { registerContactsTools } from "./contacts.js";
import { runOAuthFlow, checkTokenHealth } from "./auth.js";
import { loadConfig, ensureDirs } from "./config.js";
import { logAction } from "./logger.js";

const server = new McpServer({
  name: "mariana-google-mcp",
  version: "1.0.0",
});

// --- google_auth ---
server.tool(
  "google_auth",
  "Authenticate a Google account. Opens a browser for OAuth consent. Use this to add a new account or re-authenticate an existing one.",
  {
    account_name: z
      .string()
      .optional()
      .default("primary")
      .describe("Friendly name for this account (e.g. 'primary', 'newsletters')"),
  },
  async ({ account_name }) => {
    try {
      const email = await runOAuthFlow(account_name);
      await logAction({
        timestamp: new Date().toISOString(),
        tool: "google_auth",
        account: account_name,
        summary: `Account authenticated: ${email}`,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Account "${account_name}" authenticated successfully as ${email}.`,
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
  "Check connection health for all configured Google accounts. Shows token status and last action.",
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
