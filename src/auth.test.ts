import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "auth-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { decideCallback } = await import("./auth.js");

const S = "s".repeat(64);

test("callback with wrong state is rejected 400", () => {
  assert.deepEqual(decideCallback({ state: "x", code: "c" }, S, false), { status: 400, proceed: false });
});

test("callback with missing state is rejected 400", () => {
  assert.equal(decideCallback({ state: null, code: "c" }, S, false).status, 400);
});

test("callback with missing code is rejected 400", () => {
  assert.equal(decideCallback({ state: S, code: null }, S, false).status, 400);
});

test("callback after first valid one is 410", () => {
  assert.deepEqual(decideCallback({ state: S, code: "c" }, S, true), { status: 410, proceed: false });
});

test("valid callback proceeds", () => {
  assert.deepEqual(decideCallback({ state: S, code: "c" }, S, false), { status: 200, proceed: true });
});

test("SCOPES is the exact least-privilege list, in order", async () => {
  const { SCOPES } = await import("./auth.js");
  const p = "https://www.googleapis.com/auth/";
  assert.deepEqual(SCOPES, [
    p + "userinfo.email",
    p + "gmail.modify",
    p + "calendar.events",
    p + "calendar.calendarlist.readonly",
    p + "calendar.freebusy",
    p + "contacts.readonly",
  ]);
});
