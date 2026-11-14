import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Isolate config BEFORE any src module that touches config is imported.
const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "cal-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
await fs.mkdir(path.join(xdg, "mariana-google-mcp"), { recursive: true });
await fs.writeFile(
  path.join(xdg, "mariana-google-mcp", "config.json"),
  JSON.stringify({
    defaultGmailAccount: "main",
    defaultCalendar: "primary",
    accounts: {},
    allowedAttendees: ["Friend@Example.com"],
  })
);

const { registerCalendarTools, assertOwnedCalendar } = await import("./calendar.js");
const { GuardError } = await import("./guards.js");
const { ToolCapture } = await import("./testing.js");

interface FakeOpts {
  contacts?: string[] | Error;
  accessRole?: string;
  existingAttendees?: any[];
}

function setup(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const inserted: any[] = [];
  const updated: any[] = [];
  const contactAccounts: string[] = [];
  const fakeCal: any = {
    calendarList: {
      get: async ({ calendarId }: any) => {
        calls.push(`calendarList.get:${calendarId}`);
        return { data: { id: "owner@example.com", primary: true, accessRole: opts.accessRole ?? "owner" } };
      },
    },
    events: {
      get: async () => ({
        data: { id: "e1", summary: "Old", description: "old", attendees: opts.existingAttendees ?? [] },
      }),
      insert: async (p: any) => {
        calls.push("events.insert");
        inserted.push(p);
        return { data: { id: "new1", summary: p.requestBody.summary } };
      },
      update: async (p: any) => {
        calls.push("events.update");
        updated.push(p);
        return { data: { id: "e1", summary: p.requestBody.summary } };
      },
      patch: async (p: any) => {
        calls.push("events.patch");
        updated.push(p);
        return { data: { id: "e1", summary: "x" } };
      },
    },
  };
  const cap = new ToolCapture();
  registerCalendarTools(cap as any, {
    getAuthClient: async (account?: string) => ({ client: {} as any, accountName: account ?? "main" }),
    getContactEmails: async (_client: any, cacheKey: string) => {
      contactAccounts.push(cacheKey);
      if (opts.contacts instanceof Error) throw opts.contacts;
      return new Set((opts.contacts ?? []).map((c) => c.toLowerCase()));
    },
    makeCalendar: () => fakeCal,
  });
  return { cap, calls, inserted, updated, contactAccounts };
}

const baseCreate = { title: "T", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", calendar_id: "primary" };

test("calendar_create and calendar_update schemas have no send_invites / send_updates", () => {
  const { cap } = setup();
  for (const n of ["calendar_create", "calendar_update"]) {
    const keys = Object.keys(cap.get(n).schema);
    assert.ok(!keys.includes("send_invites"), n);
    assert.ok(!keys.includes("send_updates"), n);
  }
});

test("calendar_create refuses a stranger and never inserts", async () => {
  const { cap, calls } = setup({ contacts: [] });
  const res = await cap.get("calendar_create").handler({ ...baseCreate, attendees: ["stranger@example.com"] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Google Contacts or on allowedAttendees/);
  assert.ok(!calls.includes("events.insert"));
});

test("calendar_create allows a contact, an allowlisted address (case-insensitive) and the owner; sends nothing", async () => {
  const { cap, inserted } = setup({ contacts: ["pal@example.com"] });
  const res = await cap.get("calendar_create").handler({
    ...baseCreate,
    attendees: ["Pal@Example.com", "friend@example.com", "OWNER@example.com"],
  });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].sendUpdates, "none");
});

test("calendar_create fails closed when contact lookup throws", async () => {
  const { cap, calls } = setup({ contacts: new Error("insufficient scope") });
  const res = await cap.get("calendar_create").handler({ ...baseCreate, attendees: ["pal@example.com"] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Couldn't check the owner's Google Contacts/);
  assert.ok(!calls.includes("events.insert"));
  // allowlisted address still passes when lookup fails
  const ok = await cap.get("calendar_create").handler({ ...baseCreate, attendees: ["friend@example.com"] });
  assert.ok(!ok.isError);
});

test("contact lookup uses the same account as the calendar call", async () => {
  const { cap, contactAccounts } = setup({ contacts: ["pal@example.com"] });
  await cap.get("calendar_create").handler({ ...baseCreate, attendees: ["pal@example.com"], account: "work" });
  assert.deepEqual(contactAccounts, ["work"]);
});

test("calendar_create refuses a calendar that is not owned", async () => {
  const { cap, calls } = setup({ accessRole: "writer" });
  const res = await cap.get("calendar_create").handler({ ...baseCreate, calendar_id: "shared@example.com" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /owner/i);
  assert.ok(!calls.includes("events.insert"));
});

test("assertOwnedCalendar throws GuardError unless accessRole is owner", async () => {
  const mk = (role: string): any => ({ calendarList: { get: async () => ({ data: { accessRole: role } }) } });
  await assertOwnedCalendar(mk("owner"), "primary");
  for (const r of ["writer", "reader", "freeBusyReader"]) {
    await assert.rejects(assertOwnedCalendar(mk(r), "x"), GuardError);
  }
});

test("calendar_update runs the guest guard on new attendees", async () => {
  const { cap, calls } = setup({ contacts: [] });
  const res = await cap.get("calendar_update").handler({
    event_id: "e1",
    attendees: ["stranger@example.com"],
    calendar_id: "primary",
  });
  assert.equal(res.isError, true);
  assert.ok(!calls.includes("events.update"));
});

test("calendar_update refuses free-text edits when an existing guest is not allowed", async () => {
  const outsider = [{ email: "outsider@example.com" }, { email: "owner@example.com", self: true }];
  for (const change of [{ description: "d" }, { title: "t" }, { location: "l" }]) {
    const { cap, calls } = setup({ contacts: [], existingAttendees: outsider });
    const res = await cap.get("calendar_update").handler({ event_id: "e1", calendar_id: "primary", ...change });
    assert.equal(res.isError, true, JSON.stringify(change));
    assert.match(res.content[0].text, /Google Calendar/);
    assert.ok(!calls.includes("events.update"));
  }
});

test("calendar_update allows time changes with outside guests, and text edits when all guests are allowed", async () => {
  const outsider = [{ email: "outsider@example.com" }];
  const a = setup({ contacts: [], existingAttendees: outsider });
  const r1 = await a.cap.get("calendar_update").handler({ event_id: "e1", calendar_id: "primary", start: "2026-02-01T10:00:00Z" });
  assert.ok(!r1.isError);
  assert.equal(a.updated[0].sendUpdates, "none");

  const b = setup({ contacts: ["pal@example.com"], existingAttendees: [{ email: "pal@example.com" }, { email: "me@example.com", self: true }] });
  const r2 = await b.cap.get("calendar_update").handler({ event_id: "e1", calendar_id: "primary", description: "d" });
  assert.ok(!r2.isError);
});

test("calendar_update with unreadable contacts treats existing guests as unallowed for text edits", async () => {
  const { cap } = setup({ contacts: new Error("scope"), existingAttendees: [{ email: "pal@example.com" }] });
  const res = await cap.get("calendar_update").handler({ event_id: "e1", calendar_id: "primary", description: "d" });
  assert.equal(res.isError, true);
});

test("calendar_flag_delete checks ownership before patching", async () => {
  const { cap, calls } = setup({ accessRole: "reader" });
  const res = await cap.get("calendar_flag_delete").handler({ event_id: "e1", calendar_id: "x@example.com" });
  assert.equal(res.isError, true);
  assert.ok(!calls.includes("events.patch"));
});
