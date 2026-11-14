import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Isolate config BEFORE any src module that touches config is imported.
const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "logger-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { logAction, logFailure, withFailureLog } = await import("./logger.js");
const { ensureDirs, saveConfig, getConfigDir, getTokensDir, safeChmod } = await import("./config.js");
const { GuardError } = await import("./guards.js");

const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;
const logPath = () => path.join(getConfigDir(), "action-log.jsonl");
const readLog = async () =>
  (await fs.readFile(logPath(), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));

test("temp config dir is isolated from the real one", () => {
  assert.ok(getConfigDir().startsWith(xdg));
});

test("logAction creates the log 0600 and tightens an existing loose log", async () => {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(logPath(), "", { mode: 0o644 });
  await fs.chmod(logPath(), 0o644);
  await logAction({ timestamp: "t", tool: "x", account: "a", summary: "s" });
  assert.equal(await mode(logPath()), 0o600);
});

test("ensureDirs makes config dir 0700 and tokens dir 0700", async () => {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.chmod(getConfigDir(), 0o755);
  await ensureDirs();
  assert.equal(await mode(getConfigDir()), 0o700);
  assert.equal(await mode(getTokensDir()), 0o700);
});

test("saveConfig writes config.json 0600, tightening an existing loose file", async () => {
  const cfg = path.join(getConfigDir(), "config.json");
  await fs.writeFile(cfg, "{}", { mode: 0o644 });
  await fs.chmod(cfg, 0o644);
  await saveConfig({ defaultGmailAccount: "primary", defaultCalendar: "primary", accounts: {} });
  assert.equal(await mode(cfg), 0o600);
});

test("safeChmod skips symlinks and never touches the target", async () => {
  const target = path.join(xdg, "outside.txt");
  await fs.writeFile(target, "x", { mode: 0o644 });
  await fs.chmod(target, 0o644);
  const link = path.join(getConfigDir(), "link.txt");
  await fs.symlink(target, link);
  await safeChmod(link, 0o600);
  assert.equal(await mode(target), 0o644);
});

test("logFailure records tool, account, truncated message, and no secrets", async () => {
  const long = "boom " + "x".repeat(1000);
  await logFailure("gmail_draft", "primary", new Error(long));
  const entries = await readLog();
  const e = entries[entries.length - 1];
  assert.equal(e.tool, "gmail_draft");
  assert.equal(e.account, "primary");
  assert.equal(e.outcome, "failed");
  assert.ok(e.summary.length <= 400, `summary too long: ${e.summary.length}`);
  assert.match(e.summary, /boom/);
});

test("logFailure marks GuardError as refused", async () => {
  await logFailure("calendar_create", "primary", new GuardError("Guest not allowed"));
  const entries = await readLog();
  assert.equal(entries[entries.length - 1].outcome, "refused");
});

test("withFailureLog logs a thrown error and rethrows it", async () => {
  const h = withFailureLog("gmail_apply_label", async (_a: any) => { throw new Error("api down"); });
  await assert.rejects(() => h({ account: "work" }), /api down/);
  const e = (await readLog()).pop();
  assert.equal(e.tool, "gmail_apply_label");
  assert.equal(e.account, "work");
  assert.equal(e.outcome, "failed");
});

test("withFailureLog logs a guard refusal result as refused and returns it", async () => {
  const res = { content: [{ type: "text", text: "Refused: bad label" }], isError: true };
  const h = withFailureLog("gmail_apply_label", async (_a: any) => res);
  assert.equal(await h({}), res);
  const e = (await readLog()).pop();
  assert.equal(e.outcome, "refused");
  assert.equal(e.account, "default");
  assert.match(e.summary, /bad label/);
});

test("withFailureLog does not log on success", async () => {
  const before = (await readLog()).length;
  const h = withFailureLog("gmail_apply_label", async (_a: any) => ({ content: [] }));
  await h({});
  assert.equal((await readLog()).length, before);
});

test("every write tool in gmail and calendar is wired to the failure log", async () => {
  const { registerGmailTools } = await import("./gmail.js");
  const { registerCalendarTools } = await import("./calendar.js");
  const { ToolCapture } = await import("./testing.js");
  const { WRITE_TOOLS } = await import("./logger.js");
  const cap = new ToolCapture();
  registerGmailTools(cap as any);
  registerCalendarTools(cap as any);
  for (const name of WRITE_TOOLS) cap.get(name); // all registered
  // A guard refusal through a real wired tool lands in the log as refused.
  const before = (await readLog()).length;
  const res = await cap.get("gmail_draft").handler({ to: "a@example.com\r\nBcc: x@example.com", subject: "s", body: "b" });
  assert.equal(res.isError, true);
  const entries = await readLog();
  assert.equal(entries.length, before + 1);
  const e = entries[entries.length - 1];
  assert.equal(e.tool, "gmail_draft");
  assert.equal(e.outcome, "refused");
  assert.doesNotMatch(JSON.stringify(e), /Bcc: x@example\.com/);
});
