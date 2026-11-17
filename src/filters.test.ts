import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilterRequest, DEFAULT_PROTECTED_SENDERS, isProtectedSender } from "./filters.js";
import { GuardError } from "./guards.js";

const P = [...DEFAULT_PROTECTED_SENDERS, "mybank.example"];
const build = (a: any) => buildFilterRequest(a, P);
const refuses = (a: any, re: RegExp) =>
  assert.throws(() => build(a), (e: any) => e instanceof GuardError && re.test(e.message));

test("visibility filter payload: exact criteria and action sent to Google", () => {
  const r = build({ from: "thersegroup.com", label_id: "Label_39", star: true, mark_important: true });
  assert.deepEqual(r.criteria, { from: "thersegroup.com" });
  assert.deepEqual(r.action, { addLabelIds: ["Label_39", "STARRED", "IMPORTANT"] });
  assert.equal(r.hides, false);
});

test("visibility actions accept broad criteria", () => {
  const r = build({ query: "has:attachment invoice", star: true });
  assert.deepEqual(r.action, { addLabelIds: ["STARRED"] });
});

test("cleanup payloads map to the documented labels and nothing else", () => {
  assert.deepEqual(build({ from: "news@shop.example", trash: true }).action, { addLabelIds: ["TRASH"] });
  assert.deepEqual(build({ from: "shop.example", archive: true, mark_read: true }).action, { removeLabelIds: ["INBOX", "UNREAD"] });
  assert.deepEqual(build({ from: "rse.example", never_spam: true, star: true }).action, { addLabelIds: ["STARRED"], removeLabelIds: ["SPAM"] });
  const keys = new Set<string>();
  for (const a of [{ trash: true }, { archive: true }, { mark_read: true }, { never_spam: true }, { star: true }]) {
    for (const k of Object.keys(build({ from: "shop.example", ...a }).action)) keys.add(k);
  }
  assert.deepEqual([...keys].sort(), ["addLabelIds", "removeLabelIds"]);
});

test("hiding actions and never_spam require one sender, no query/to", () => {
  for (const act of ["trash", "archive", "mark_read", "never_spam"]) {
    refuses({ query: "*", [act]: true }, /single sender/);
    refuses({ from: "shop.example", query: "x", [act]: true }, /single sender/);
    refuses({ from: "shop.example", to: "me@example.com", [act]: true }, /single sender/);
    refuses({ subject: "sale", [act]: true }, /single sender/);
    for (const bad of ["*", "a.com OR b.com", "{a.com b.com}", "-from:x.com", "shop", "@shop.example", "a b@x.com"]) {
      refuses({ from: bad, [act]: true }, /one email address or domain/);
    }
  }
  assert.equal(build({ from: "shop.example", subject: "Weekly deals", trash: true }).criteria.subject, "Weekly deals");
});

test("protected senders cannot be trashed, archived or marked read (subdomains too)", () => {
  for (const from of ["no-reply@accounts.google.com", "google.com", "alerts@mybank.example", "x@id.apple.com"]) {
    for (const act of ["trash", "archive", "mark_read"]) refuses({ from, [act]: true }, /protected sender/);
  }
  assert.equal(isProtectedSender("news@notgoogle.com", P), false);
  assert.equal(build({ from: "news@notgoogle.com", trash: true }).hides, true);
  // never_spam / star on a protected sender is allowed (only makes it more visible)
  assert.ok(build({ from: "google.com", never_spam: true }));
});

test("trash cannot be combined with star/important/never_spam", () => {
  refuses({ from: "shop.example", trash: true, star: true }, /Pick one intent/);
  refuses({ from: "shop.example", trash: true, never_spam: true }, /Pick one intent/);
});

test("requires criterion and action; rejects system labels and CR/LF", () => {
  refuses({ star: true }, /criterion/);
  refuses({ from: "   ", star: true }, /criterion/);
  refuses({ from: "a@example.com" }, /action/);
  refuses({ from: "a@example.com", label_id: "TRASH" }, /own labels/);
  refuses({ from: "a@example.com\r\nx", star: true }, /line breaks/);
});
