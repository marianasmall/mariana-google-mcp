# Design: mariana-google-mcp

**Date:** 2026-04-03
**Status:** Draft — pending user approval

## Overview

A custom MCP (Model Context Protocol) server providing Gmail and Google Calendar access for Claude Code. Built with safety-first defaults: no sending emails, no deleting anything, soft-delete patterns for all destructive actions.

Designed to be forked — all personal configuration lives outside the repo in environment variables and local config files.

## Motivation

- Replace third-party MCP packages (trust no one with OAuth tokens)
- Apply Mariana's "default to reversible" constitution to email and calendar operations
- Create a public portfolio piece demonstrating MCP development alongside MCP certification
- Reuse existing Google Cloud project credentials

## Architecture

```
mariana-google-mcp/
├── src/
│   ├── index.ts          # MCP server entry, tool registration
│   ├── auth.ts           # OAuth flow, token storage, multi-account
│   ├── gmail.ts          # Gmail tool handlers
│   ├── calendar.ts       # Calendar tool handlers
│   ├── contacts.ts       # Contacts tool handlers (read-only)
│   ├── logger.ts         # Action log (append-only JSONL)
│   └── config.ts         # Default account/calendar config
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE               # MIT
└── .gitignore
```

**Stack:**
- TypeScript (compiled to JS for runtime)
- `googleapis` v144+ (official Google SDK)
- `@modelcontextprotocol/sdk` (Anthropic's MCP SDK)
- `google-auth-library` (official Google OAuth)
- `open` (browser launcher for OAuth flow)
- `zod` (input validation)

No other dependencies.

## Authentication

### OAuth Flow
- Uses existing Google Cloud project (`tribal-pride-490401-f1` — NOT hardcoded, passed via env vars)
- Client ID and Secret passed via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars in `.claude.json`
- OAuth redirect to `http://localhost:<dynamic-port>` (same pattern as google-docs-mcp)
- Browser opens automatically for consent screen

### Token Storage
- Tokens stored at `~/.config/mariana-google-mcp/tokens/`
- One token file per account: `<sha256-of-email>.json` (SHA-256 hash to avoid email addresses on disk)
- Token auto-refresh using refresh_token (no re-auth needed unless revoked)
- Tokens NEVER committed to repo (in .gitignore)

### Multi-Account Support
- First OAuth flow sets the default account
- Additional accounts added via `google_auth` tool (triggers new OAuth flow)
- Default account stored in `~/.config/mariana-google-mcp/config.json`
- Every Gmail tool accepts optional `account` parameter to override default

### Required OAuth Scopes
- `https://www.googleapis.com/auth/gmail.readonly` (read messages, search, list labels)
- `https://www.googleapis.com/auth/gmail.compose` (create drafts)
- `https://www.googleapis.com/auth/gmail.labels` (create/manage labels for soft-delete)
- `https://www.googleapis.com/auth/calendar` (full calendar CRUD — deletion blocked at application level, not scope level)
- `https://www.googleapis.com/auth/contacts.readonly` (read contacts — no write access needed)

## Gmail Tools

### `gmail_search`
Search messages across inbox.
- **Input:** `query` (Gmail search syntax, e.g. "from:allyn subject:invoice"), `account?`, `max_results?` (default 10)
- **Output:** List of message summaries (id, from, to, subject, date, snippet, labels)

### `gmail_read`
Read a specific message.
- **Input:** `message_id`, `account?`
- **Output:** Full message (from, to, cc, subject, date, body text, attachment names)

### `gmail_list_labels`
List all labels/folders for an account.
- **Input:** `account?`
- **Output:** List of labels (id, name, message count)

### `gmail_draft`
Create a draft email (never sends).
- **Input:** `to`, `subject`, `body`, `cc?`, `bcc?`, `account?`
- **Output:** Draft ID, confirmation message
- **Behavior:** Creates draft in Gmail Drafts folder. Mariana reviews and sends manually.

### `gmail_move_to_delete`
Soft-delete: move messages to "To Be Deleted" label.
- **Input:** `message_ids` (array), `account?`
- **Output:** Count moved, confirmation
- **Behavior:** Creates "To Be Deleted" label if it doesn't exist. Moves messages there. NEVER calls Gmail's delete or trash endpoints.

### NOT IMPLEMENTED (by design)
- `gmail_send` — No sending. Drafts only.
- `gmail_delete` — No deleting. Soft-delete only.
- `gmail_trash` — No trashing. Soft-delete only.

## Calendar Tools

### `calendar_list`
List upcoming events.
- **Input:** `days_ahead?` (default 7), `calendar_id?` (default: primary)
- **Output:** List of events (id, title, start, end, location, attendees, description, video link)

### `calendar_search`
Search events by keyword.
- **Input:** `query`, `time_min?`, `time_max?`, `calendar_id?`
- **Output:** Matching events (same fields as calendar_list)

### `calendar_get`
Get a specific event's full details.
- **Input:** `event_id`, `calendar_id?`
- **Output:** Full event details including attendees, description, recurrence

### `calendar_create`
Create a new event.
- **Input:** `title`, `start`, `end`, `description?`, `location?`, `attendees?`, `calendar_id?`
- **Output:** Event ID, confirmation
- **Behavior:** Creates event with `sendUpdates: "none"` — NO invites sent unless Mariana explicitly overrides with `send_invites: true`

### `calendar_update`
Modify an existing event.
- **Input:** `event_id`, `title?`, `start?`, `end?`, `description?`, `location?`, `calendar_id?`
- **Output:** Confirmation of changes
- **Behavior:** Updates with `sendUpdates: "none"` — no notifications to attendees

### `calendar_flag_delete`
Soft-delete: prepend "DELETE - " to event title.
- **Input:** `event_id`, `calendar_id?`
- **Output:** Confirmation
- **Behavior:** Renames event to "DELETE - [original title]". NEVER calls Calendar's delete endpoint. Mariana reviews and deletes manually.

### `calendar_availability`
Check free/busy status.
- **Input:** `date` (or date range), `calendar_id?`
- **Output:** Free/busy blocks for the day

### NOT IMPLEMENTED (by design)
- `calendar_delete` — No deleting. Flag only.
- Invite sending defaults to OFF on create and update.

## Contacts Tools

### `contacts_search`
Search contacts by name, email, or phone.
- **Input:** `query`, `account?`, `max_results?` (default 10)
- **Output:** List of contacts (name, emails, phones, organization, notes)

### `contacts_list`
List contacts, optionally filtered by group.
- **Input:** `group?`, `account?`, `max_results?` (default 25)
- **Output:** List of contacts (same fields as search)

### NOT IMPLEMENTED (by design)
- `contacts_create` / `contacts_update` / `contacts_delete` — Read-only. Contacts are managed in Google Contacts UI.

## Status Tool

### `google_status`
Report connection health.
- **Input:** none
- **Output:** For each connected account: email, token status (valid/expired/missing), last action timestamp, services available (gmail/calendar)

## Auth Tool

### `google_auth`
Trigger OAuth flow for a new account.
- **Input:** `account_name?` (friendly label, e.g. "newsletters")
- **Output:** Opens browser, completes OAuth, confirms account added

## Action Log

Every mutating action (draft created, message moved, event created/updated/flagged) is appended to `~/.config/mariana-google-mcp/action-log.jsonl`.

Format:
```json
{"timestamp": "2026-04-03T12:00:00Z", "tool": "gmail_draft", "account": "primary", "summary": "Draft created: 'Re: Invoice Q2' to allyn@example.com", "ids": ["draft_abc123"]}
```

- Append-only (never modified or truncated)
- Local-only (never committed, never transmitted)
- Human-readable (one JSON object per line)

## Configuration

`~/.config/mariana-google-mcp/config.json`:
```json
{
  "default_gmail_account": "primary",
  "default_calendar": "primary",
  "accounts": {
    "primary": { "label": "Main", "email_hash": "abc123..." },
    "newsletters": { "label": "Newsletters", "email_hash": "def456..." }
  }
}
```

Generated on first auth. Updated when new accounts are added. No emails stored in plaintext — only hashes for token file lookup. The account labels ("primary", "newsletters") are user-chosen friendly names.

## Claude Code Integration

Added to `~/.claude.json` under `mcpServers`:
```json
{
  "mariana-google-mcp": {
    "type": "stdio",
    "command": "node",
    "args": ["/Users/marianasmall/Projects/mariana-google-mcp/dist/index.js"],
    "env": {
      "GOOGLE_CLIENT_ID": "<from env>",
      "GOOGLE_CLIENT_SECRET": "<from env>"
    }
  }
}
```

Runs locally from compiled JS. No npx, no npm — direct execution from the project's dist/ folder.

## Security Principles

1. **No secrets in code.** All credentials via env vars or local config files.
2. **No destructive actions.** Delete endpoints are not implemented, period.
3. **No silent actions.** Every mutation logged to action-log.jsonl.
4. **No external transmission.** Only talks to googleapis.com and localhost.
5. **No send by default.** Emails are drafts. Calendar invites are suppressed.
6. **Fork-safe.** Repo contains zero personal information.
7. **Minimal dependencies.** Only official Google + Anthropic SDKs + Zod.

## What's NOT in Scope

- Google Slides (no current need)
- Google Analytics (deferred to client engagement)
- YouTube (deferred to client engagement)
- Gmail attachment download (can be added if needed)

## Future Extensions (not built now)

- `gmail_send` — gated behind explicit `ENABLE_SEND=true` env var
- `calendar_delete` — gated behind explicit `ENABLE_DELETE=true` env var
- Additional Google APIs added as new tool files (same auth, same server)
