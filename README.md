# mariana-google-mcp

A custom MCP (Model Context Protocol) server that gives Claude Code access to Gmail, Google Calendar, and Google Contacts — with safety-first defaults.

## Design Philosophy

This server is built for an operator who wants AI to help manage their Google workspace without risk of accidental damage:

- **No sending email.** You can draft, but sending requires manual action in Gmail.
- **No deleting anything.** Gmail uses a "To Be Deleted" label (soft-delete). Calendar prepends "DELETE - " to event titles. You review and confirm in the Google UI.
- **Every mutation is logged.** An append-only JSONL action log records every write operation with timestamps, tool name, account, and summary.
- **Multi-account support.** Manage personal and work accounts with named aliases.

## Setup

### 1. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable these APIs:
   - Gmail API
   - Google Calendar API
   - People API (for Contacts)
4. Create OAuth 2.0 credentials:
   - Application type: **Desktop app**
   - Download the client ID and client secret

### 2. Install and Build

```bash
git clone https://github.com/marianasmall/mariana-google-mcp.git
cd mariana-google-mcp
npm install
npm run build
```

### 3. Add to Claude Code

Add this to your `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "mariana-google-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mariana-google-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Replace `/path/to/` with the actual path to your clone, and fill in your OAuth credentials.

### 4. Authenticate

After restarting Claude Code, run the `google_auth` tool. It will open a browser window for OAuth consent. Once authorized, your token is stored locally and refreshed automatically.

## Available Tools (19)

### Authentication & Status
| Tool | Description |
|------|-------------|
| `google_auth` | Authenticate a Google account via OAuth browser flow |
| `google_status` | Check connection health for all configured accounts |

### Gmail (9 tools)
| Tool | Description |
|------|-------------|
| `gmail_search` | Search messages using Gmail query syntax |
| `gmail_read` | Read a specific message by ID (full content) |
| `gmail_list_labels` | List all Gmail labels/folders |
| `gmail_draft` | Create a draft email (does NOT send) |
| `gmail_create_label` | Create a new label (supports nesting with `/`) |
| `gmail_apply_label` | Apply a label to one or more messages |
| `gmail_remove_label` | Remove a label from one or more messages |
| `gmail_create_filter` | Create a filter rule (match criteria → actions) |
| `gmail_move_to_delete` | Soft-delete: move messages to a "To Be Deleted" label |

### Calendar (6 tools)
| Tool | Description |
|------|-------------|
| `calendar_list` | List upcoming calendar events |
| `calendar_search` | Search events by keyword |
| `calendar_get` | Get full details of a specific event |
| `calendar_create` | Create an event (does NOT send invites by default) |
| `calendar_update` | Modify an existing event (does NOT notify attendees by default) |
| `calendar_flag_delete` | Soft-delete: prepend "DELETE - " to event title |
| `calendar_availability` | Check free/busy status for a date range |

### Contacts (2 tools)
| Tool | Description |
|------|-------------|
| `contacts_search` | Search contacts by name, email, or phone |
| `contacts_list` | List contacts, optionally filtered by group |

## Multi-Account Support

You can authenticate multiple Google accounts with friendly names:

```
google_auth account_name: "primary"
google_auth account_name: "newsletters"
google_auth account_name: "work"
```

Most tools accept an optional `account` parameter. If omitted, they use the default account. Use `google_status` to see all configured accounts and their health.

## Configuration Files

All configuration is stored in `~/.config/mariana-google-mcp/`:

| File | Purpose |
|------|---------|
| `config.json` | Account registry (names, email hashes, defaults) |
| `tokens/<hash>.json` | OAuth tokens per account (auto-refreshed) |
| `actions.jsonl` | Append-only log of all mutations |

Tokens are stored by email hash, not plaintext email, for a layer of indirection.

## Action Log

Every write operation (drafts, calendar creates/updates, soft-deletes) is logged to `~/.config/mariana-google-mcp/actions.jsonl` in this format:

```json
{"timestamp":"2026-04-03T10:30:00.000Z","tool":"gmail_draft","account":"primary","summary":"Draft created: subject='Meeting follow-up'"}
```

The log is append-only and never modified by the server. Review it anytime to audit what Claude has done.

## Fork and Use

To use this with your own Google account:

1. Fork this repo
2. Create your own Google Cloud project and OAuth credentials (see Setup above)
3. Build and point your Claude Code config at your fork's `dist/index.js`
4. Run `google_auth` to authenticate

No code changes needed — all account-specific data lives in config files and environment variables.

## Tech Stack

- TypeScript
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `googleapis` — Google API client
- `google-auth-library` — OAuth2 token management
- `zod` — Input validation

## License

MIT
