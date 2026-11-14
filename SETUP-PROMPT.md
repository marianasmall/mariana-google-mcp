# Setup: Gmail + Calendar + Contacts access for Claude Code

**Instructions for Claude Code.** A user has pasted this document (or a link to it) into you so you can set up Google account access for them. Follow it step by step. Do everything you can yourself; where a step requires clicking in a browser, give the user numbered instructions, then STOP and wait for them to say "done" before continuing. Do not skip ahead.

## What you are building

You will install `mariana-google-mcp`, an open-source MCP server (MIT license) that gives Claude Code direct access to Gmail, Google Calendar, and Google Contacts across multiple Google accounts. It is deliberately safety-first:

- **It cannot send email.** It creates drafts only; the user reviews and sends from Gmail.
- **It cannot delete your mail.** Gmail deletions apply a "To Be Deleted" label; calendar deletions prepend "DELETE - " to the event title. The user confirms in the Google UI. The one exception is the user's own unsent drafts, which `gmail_delete_draft` moves to Trash (recoverable for 30 days). There is no permanent-delete option, and `gmail_apply_label` refuses the TRASH and SPAM labels.
- **It cannot create filters and never sends calendar invites.** There is no filter tool (filters can forward mail). Calendar writes never email guests. Guests must be in the owner's saved Google Contacts or on an `allowedAttendees` list in `config.json`, and events are written only to calendars the owner owns.
- **Attachments are limited to chosen folders.** Drafts can attach files only from the folders in `attachmentRoots` in `config.json` (defaults: Projects, Documents, Downloads, Desktop, Library/CloudStorage under the home folder), never from hidden folders, `~/.ssh`, `~/.claude` or the server's own config folder.
- **Replies actually thread.** Pass `reply_to_message_id` and the draft carries the `In-Reply-To` and `References` headers real threading depends on, not just Gmail's internal thread id. The tool states in its result whether it made a reply or a new conversation, so a mistake is visible immediately rather than discovered by the recipient.
- **Every write is logged** to a local append-only action log, including failed and refused attempts. The log, config and tokens are readable only by the owner (`0600`).
- **Multi-account:** each Google account connects under a named alias and tools take an `account` parameter.

Repo: https://github.com/marianasmall/mariana-google-mcp

## Phase 1 — Install and connect

### Step 0 — Preflight (you do this)

Check that `node` (v18+), `npm`, and `git` are installed. If not, install them first (on macOS: `brew install node git`). Ask the user which directory they keep code projects in; default to `~/Projects/`.

Also ask now: **which Google accounts do they want to connect, and what short alias should each get?** (Examples: `personal`, `work`, or brand names.) You'll use this list in Steps 1 and 4.

### Step 1 — Google Cloud project (user does this in a browser; you guide)

Walk the user through this with numbered instructions, one checkpoint at a time. Google's console UI changes often, so adapt to what they actually see rather than insisting on exact menu names.

1. Go to https://console.cloud.google.com/ and sign in with the Google account they want as the "owner" of this setup (any account works; the others connect later regardless).
2. Create a new project. Name it something recognizable, e.g., "Claude Code MCP".
3. Enable three APIs (APIs & Services → Library, or search each by name):
   - **Gmail API**
   - **Google Calendar API**
   - **People API** (this is the Contacts one)
4. Configure the OAuth consent screen (may appear as "Google Auth Platform" → Branding/Audience):
   - App name: "Claude Code" (or similar). Support email: their own.
   - User type / Audience: **External**. (External is required so both personal Gmail and Google Workspace accounts can connect.)
   - No scopes need to be pre-declared; no logo needed.
5. **Publish the app to Production.** On the Audience (or OAuth consent screen) page, change publishing status from "Testing" to "In production". The app stays "unverified" — that is fine and expected for personal use.
6. Create credentials: Clients (or Credentials) → Create Client → Application type: **Desktop app**. Name it "Claude Code".
7. Copy the **Client ID** and **Client Secret** it shows.

⚠️ CRITICAL — do not let the user skip step 5. Apps left in "Testing" status have their refresh tokens expire every 7 days, which means re-authenticating every week and mysterious "invalid_grant" failures. Published + unverified = tokens persist indefinitely.

Ask the user to paste the Client ID and Client Secret to you when done (or have them keep the secret out of chat and insert it themselves in Step 3 — their choice; a Desktop-app client secret is low-sensitivity by design, but treating secrets carefully is a good default).

### Step 2 — Install the server (you do this)

```bash
cd ~/Projects
git clone https://github.com/marianasmall/mariana-google-mcp.git
cd mariana-google-mcp
npm install
npm run build
```

Confirm `dist/index.js` exists before proceeding.

### Step 3 — Register the MCP server (you do this)

Preferred method, from any directory:

```bash
claude mcp add google --scope user \
  -e GOOGLE_CLIENT_ID="<client-id>.apps.googleusercontent.com" \
  -e GOOGLE_CLIENT_SECRET="<client-secret>" \
  -- node /FULL/PATH/TO/mariana-google-mcp/dist/index.js
```

Use the absolute path to the cloned repo's `dist/index.js`. If the `claude mcp add` command isn't available in their version, instead add this to `~/.claude.json` under the top-level `"mcpServers"` key:

```json
"google": {
  "type": "stdio",
  "command": "node",
  "args": ["/FULL/PATH/TO/mariana-google-mcp/dist/index.js"],
  "env": {
    "GOOGLE_CLIENT_ID": "<client-id>.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "<client-secret>"
  }
}
```

Then tell the user to fully restart Claude Code (quit and relaunch — MCP servers only load on startup) and paste this document in again, saying "continue from Step 4".

### Step 4 — Connect each account (after restart)

For each account on the list from Step 0:

1. Run the `google_auth` tool with that account's alias. The first account connected becomes the default.
2. A browser window opens. The user picks the matching Google account and approves.
3. They will see a **"Google hasn't verified this app"** warning. This is expected (the app is their own, unverified). Click **Advanced → Go to Claude Code (unsafe)** → Continue, and approve the requested permissions.

The sign-in listens on `127.0.0.1` only and uses `state` and PKCE. It requires the **Desktop app** client type from Step 1; a "Web application" client will fail. Re-using an account alias for a different Google account is refused.

The server requests exactly six scopes: `userinfo.email`, `gmail.modify`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, `contacts.readonly`. If the user connected accounts with an older version of this server, have them re-run `google_auth` for each account so the stored token drops the older, broader grants.

Tokens are stored locally at `~/.config/mariana-google-mcp/` and refresh automatically.

### Step 5 — Verify (you do this)

1. Run `google_status` — every connected account should show `tokenStatus: valid`.
2. Run a `gmail_search` for `newer_than:7d` on each account and show the user a couple of subject lines as proof of life.
3. Briefly show the user what they can now ask for: email search/triage across accounts, drafted replies (they send), label cleanup, calendar management, contact lookups.

## Phase 2 — Optional: unify a multi-account inbox

If the user connected 3+ accounts (common for people running several brands or roles), offer this phase. The daily pain is hopping between inboxes; there are three ways to fix it, in increasing order of plumbing. Present all three, recommend starting with Play 1, and let the user choose.

**Play 1 — Claude as the unified layer (no settings changes).**
Nothing about the accounts changes; Claude becomes the one place to look. Establish a triage routine the user can invoke in one line, e.g. "sweep my inboxes": for each account, search `in:inbox newer_than:1d` (or since last sweep), then present one combined brief — grouped by account, flagged by what needs a reply, with drafts offered where a response is obvious. Queue each draft in the account it belongs to so replies come from the right brand. Start here: it delivers the benefit on day one and teaches you both which accounts actually carry urgent mail before anyone re-plumbs anything.

**Play 2 — Consolidate into one inbox (forwarding + send-as).**
Auto-forward the secondary accounts into the primary one; filters label incoming mail by brand on arrival; Gmail's "Send mail as" lets replies go out from the correct address without leaving the primary inbox. You guide the user through Gmail Settings (Forwarding and POP/IMAP → Add a forwarding address, then Accounts → Send mail as). Useful detail: forwarding setup emails a verification code to the primary account — once accounts are connected you can read that code for the user via `gmail_search`/`gmail_read` instead of making them fish for it. Offer this only after Play 1 has run for a while and shown that one inbox truly dominates.

**Play 3 — Shared label taxonomy across accounts.**
Whether or not they consolidate, create a consistent label set in each account (e.g., `Action`, `Waiting`, `Read Later`, plus brand or client labels) using `gmail_create_label`, and apply them to messages with `gmail_apply_label` during each sweep. There is no filter tool, so if the user wants labels applied automatically on arrival, walk them through creating the filter themselves in Gmail Settings → Filters and Blocked Addresses. Mirror the same names everywhere so the user's mental model transfers between accounts.

## Troubleshooting

- **"invalid_grant" or accounts disconnecting after ~a week:** the consent screen was left in Testing. Publish to Production (Step 1.5), then re-run `google_auth` for each account.
- **"Access blocked" on a Google Workspace account** (e.g., a company domain): the Workspace admin must allow the app. If the user is their own admin: Google Admin console → Security → API controls → App access control → allow/trust the app (identified by its Client ID).
- **Server not appearing after restart:** check the path in the config is absolute and `dist/index.js` exists; run `claude mcp list` to see registration status.
- **Consent browser window never opens:** the OAuth flow listens on a localhost port; check nothing is blocking loopback connections, and try again.

## Security rules (state these to the user at the end)

- The Client Secret identifies their Cloud project, not their Gmail password. Still: it lives only in their local Claude config; never commit it to a repo or share it.
- Access tokens live only on this machine (`~/.config/mariana-google-mcp/`). Another computer would need its own `google_auth` run.
- Revoking access at any time: https://myaccount.google.com/permissions (remove "Claude Code"), or delete the local tokens directory.
