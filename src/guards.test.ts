import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Isolate config BEFORE any src module that touches config is imported.
const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "guards-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const guards = await import("./guards.js");
const config = await import("./config.js");
const {
  resolveAttachmentPath,
  assertNoCRLF,
  assertSafeAddLabels,
  assertAttendeesAllowed,
  escapeHtml,
  GuardError,
} = guards;

let base: string; // realpath of temp sandbox
let root: string; // fake attachment root
let outside: string; // dir outside root

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "guards-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(outside, ".ssh"), { recursive: true });
  await fs.writeFile(path.join(root, "ok.pdf"), "x");
  await fs.writeFile(path.join(outside, "outside.txt"), "x");
  await fs.writeFile(path.join(outside, ".ssh", "secret.txt"), "x");
});

after(async () => {
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(xdg, { recursive: true, force: true });
});

test("allowed file under root returns its realpath", async () => {
  const p = path.join(root, "ok.pdf");
  assert.equal(await resolveAttachmentPath(p, [root], []), p);
});

test("Drive-style path with spaces, @ and unicode passes", async () => {
  const dir = path.join(root, "My Drive (user@example.com)", "Résumé ñ");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, "Rapport été 2026.pdf");
  await fs.writeFile(p, "x");
  assert.equal(await resolveAttachmentPath(p, [root], []), p);
});

test("symlink under root pointing into outside .ssh throws", async () => {
  const link = path.join(root, "innocent.txt");
  await fs.symlink(path.join(outside, ".ssh", "secret.txt"), link);
  await assert.rejects(resolveAttachmentPath(link, [root], []), GuardError);
});

test("dot-dot traversal out of root throws", async () => {
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  const p = path.join(root, "sub", "..", "..", "outside", "outside.txt");
  await assert.rejects(resolveAttachmentPath(p, [root], []), GuardError);
});

test("relative path throws", async () => {
  await assert.rejects(resolveAttachmentPath("ok.pdf", [root], []), GuardError);
});

test("hidden directory segment throws", async () => {
  await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
  const p = path.join(root, ".hidden", "x.pdf");
  await fs.writeFile(p, "x");
  await assert.rejects(resolveAttachmentPath(p, [root], []), GuardError);
});

test("sensitive basenames throw", async () => {
  for (const name of ["id_ed25519", "a.pem", "server.KEY", "credentials.json", "tokens.json"]) {
    const p = path.join(root, name);
    await fs.writeFile(p, "x");
    await assert.rejects(resolveAttachmentPath(p, [root], []), GuardError, name);
  }
});

test("file under a forbiddenDirs entry inside root throws", async () => {
  const forbidden = path.join(root, "private");
  await fs.mkdir(forbidden, { recursive: true });
  const p = path.join(forbidden, "doc.pdf");
  await fs.writeFile(p, "x");
  await assert.rejects(resolveAttachmentPath(p, [root], [forbidden]), GuardError);
});

test("nonexistent file throws GuardError", async () => {
  await assert.rejects(resolveAttachmentPath(path.join(root, "nope.pdf"), [root], []), GuardError);
});

test("every attachment rejection has the identical actionable message (no existence oracle)", async () => {
  const forbidden = path.join(root, "forbid2");
  await fs.mkdir(forbidden, { recursive: true });
  await fs.writeFile(path.join(forbidden, "d.pdf"), "x");
  await fs.mkdir(path.join(root, ".h2"), { recursive: true });
  await fs.writeFile(path.join(root, ".h2", "x.pdf"), "x");
  await fs.writeFile(path.join(root, "id_rsa"), "x");
  const cases = [
    path.join(root, "missing-file.pdf"), // does not exist
    path.join(outside, "outside.txt"), // exists, outside roots
    path.join(outside, "does-not-exist.txt"), // missing, outside roots
    path.join(forbidden, "d.pdf"), // forbidden dir
    path.join(root, ".h2", "x.pdf"), // hidden folder
    path.join(root, "id_rsa"), // credential basename
    "relative/path.pdf", // not absolute
  ];
  const messages: string[] = [];
  for (const c of cases) {
    try {
      await resolveAttachmentPath(c, [root], [forbidden]);
      assert.fail(`expected rejection for ${c}`);
    } catch (e) {
      assert.ok(e instanceof GuardError);
      messages.push(e.message);
    }
  }
  assert.equal(new Set(messages).size, 1, "messages must all be identical");
  const msg = messages[0];
  assert.ok(msg.includes(root), "lists the configured roots");
  assert.match(msg, /attachmentRoots/);
  assert.ok(!msg.includes("missing-file") && !msg.includes("id_rsa"), "does not echo the rejected path");
});

test("other guard messages say what to do instead", () => {
  assert.throws(() => assertNoCRLF("To", "a\nb"), /To must not contain line breaks.*Remove/);
  assert.throws(() => assertSafeAddLabels(["TRASH"]), /TRASH.*instead/);
  assert.throws(() => assertAttendeesAllowed(["b@y.com"], []), /b@y\.com.*allowedAttendees/);
});

test("assertNoCRLF rejects header injection, allows quoted display names", () => {
  assert.throws(() => assertNoCRLF("To", "a@b.com\r\nBcc: x@y.com"), GuardError);
  assert.throws(() => assertNoCRLF("To", "a@b.com\nBcc: x@y.com"), GuardError);
  assert.doesNotThrow(() => assertNoCRLF("To", '"Small, M" <m@x.com>, b@y.com'));
  assert.doesNotThrow(() => assertNoCRLF("Cc", undefined));
});

test("assertSafeAddLabels blocks TRASH and SPAM", () => {
  assert.doesNotThrow(() => assertSafeAddLabels(["Label_1"]));
  assert.throws(() => assertSafeAddLabels(["TRASH"]), GuardError);
  assert.throws(() => assertSafeAddLabels(["SPAM"]), GuardError);
});

test("assertAttendeesAllowed is case-insensitive and names the offender", () => {
  assert.doesNotThrow(() => assertAttendeesAllowed(["A@x.com"], ["a@x.com"]));
  assert.throws(() => assertAttendeesAllowed(["b@y.com"], []), /b@y\.com/);
});

test("escapeHtml escapes & < > \" '", () => {
  assert.equal(escapeHtml(`<b x="1">&'`), "&lt;b x=&quot;1&quot;&gt;&amp;&#39;");
});

test("config resolvers apply defaults and overrides", () => {
  const roots = config.getAttachmentRoots({ defaultGmailAccount: "p", defaultCalendar: "p", accounts: {} });
  assert.deepEqual(roots, ["Projects", "Documents", "Downloads", "Desktop", "Library/CloudStorage"].map((d) => path.join(os.homedir(), d)));
  const base = { defaultGmailAccount: "p", defaultCalendar: "p", accounts: {} };
  assert.deepEqual(config.getAllowedAttendees(base), []);
  assert.deepEqual(config.getAttachmentRoots({ ...base, attachmentRoots: ["/x"] }), ["/x"]);
  assert.deepEqual(config.getAllowedAttendees({ ...base, allowedAttendees: ["a@x.com"] }), ["a@x.com"]);
});
