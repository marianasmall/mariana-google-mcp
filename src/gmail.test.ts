import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Isolate config BEFORE any src module that touches config is imported.
const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { registerGmailTools } = await import("./gmail.js");
const { ToolCapture } = await import("./testing.js");

function setup() {
  const cap = new ToolCapture();
  registerGmailTools(cap as any);
  return cap;
}

test("gmail_draft attachments description names default roots and refusals", () => {
  const t = setup().get("gmail_draft");
  const desc: string = t.schema.attachments.description;
  for (const r of ["~/Projects", "~/Documents", "~/Downloads", "~/Desktop", "~/Library/CloudStorage"]) {
    assert.ok(desc.includes(r), `missing ${r}`);
  }
  assert.ok(desc.includes("attachmentRoots"));
  assert.match(desc, /hidden/i);
  assert.match(desc, /credential/i);
  assert.doesNotMatch(desc, /\/Users\//);
});

test("gmail_draft rejects CR/LF in to/cc/bcc before any network call", async () => {
  const t = setup().get("gmail_draft");
  for (const field of ["to", "cc", "bcc"]) {
    const args: any = { to: "a@example.com", subject: "s", body: "b" };
    args[field] = "a@example.com\r\nBcc: evil@example.com";
    const res = await t.handler(args);
    assert.equal(res.isError, true, field);
    assert.match(res.content[0].text, /line breaks/);
  }
});

test("gmail_draft rejects a disallowed attachment with one uniform message", async () => {
  const t = setup().get("gmail_draft");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-att-"));
  const real = path.join(dir, "secret.txt");
  await fs.writeFile(real, "x");
  const msgs: string[] = [];
  for (const p of [real, path.join(dir, "missing.txt"), "relative.txt"]) {
    const res = await t.handler({ to: "a@example.com", subject: "s", body: "b", attachments: [p] });
    assert.equal(res.isError, true);
    msgs.push(res.content[0].text);
  }
  assert.match(msgs[0], /Attachment not allowed/);
  assert.equal(new Set(msgs).size, 1);
  assert.ok(!msgs[0].includes(dir));
});

test("gmail_draft and gmail_update_draft refuse remote resources in html before any network call", async () => {
  const cap = setup();
  const html = `<p>hi</p><img src="https://evil.test/pixel.png">`;
  const d = await cap.get("gmail_draft").handler({ to: "a@example.com", subject: "s", html });
  assert.equal(d.isError, true);
  assert.match(d.content[0].text, /HTML drafts allow basic formatting only/);
  assert.match(d.content[0].text, /<img src>/);
  const u = await cap.get("gmail_update_draft").handler({ draft_id: "d1", html });
  assert.equal(u.isError, true);
  assert.match(u.content[0].text, /HTML drafts allow basic formatting only/);
});

test("gmail_draft and gmail_update_draft send only the sanitizer's returned html, never the input", async () => {
  const src = await fs.readFile(new URL("./gmail.js", import.meta.url), "utf8");
  assert.equal(src.match(/safeHtml = sanitizeDraftHtml\(html, /g)?.length, 2);
  assert.match(src, /const content = safeHtml \?\? body;/);
  assert.match(src, /finalContent = safeHtml;/);
  // After the guard, the raw `html` argument is never read again.
  const bodies = src.split(/safeHtml = sanitizeDraftHtml\(html, [^\n]*\n/).slice(1);
  for (const rest of bodies) {
    const handlerTail = rest.split(/server\.tool\(/)[0];
    assert.doesNotMatch(handlerTail, /(?<![\w/])html\b(?!Part)/, "raw html used after sanitizing");
  }
});

// --- readAttachmentGuarded ---
const { readAttachmentGuarded } = await import("./gmail.js");
const { execFileSync } = await import("node:child_process");
const DENIED = /Attachment not allowed/;

async function attRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gmail-rag-")));
  return root;
}

test("readAttachmentGuarded reads a regular file inside the root", async () => {
  const root = await attRoot();
  const f = path.join(root, "ok.txt");
  await fs.writeFile(f, "hello");
  const data = await readAttachmentGuarded(f, [root], []);
  assert.equal(data.toString(), "hello");
});

test("readAttachmentGuarded refuses a directory", async () => {
  const root = await attRoot();
  const d = path.join(root, "sub");
  await fs.mkdir(d);
  await assert.rejects(readAttachmentGuarded(d, [root], []), DENIED);
});

test("readAttachmentGuarded refuses a FIFO without hanging", async (t) => {
  const root = await attRoot();
  const f = path.join(root, "pipe");
  try {
    execFileSync("mkfifo", [f]);
  } catch {
    t.skip("mkfifo not available on this platform");
    return;
  }
  await assert.rejects(readAttachmentGuarded(f, [root], []), DENIED);
});

test("readAttachmentGuarded refuses a file larger than the remaining budget", async () => {
  const root = await attRoot();
  const f = path.join(root, "big.bin");
  await fs.writeFile(f, Buffer.alloc(100));
  await assert.rejects(readAttachmentGuarded(f, [root], [], 99), DENIED);
  assert.equal((await readAttachmentGuarded(f, [root], [], 100)).length, 100);
});

test("readAttachmentGuarded refuses a hard-linked file", async () => {
  const root = await attRoot();
  const outside = await attRoot();
  const secret = path.join(outside, "secret.txt");
  await fs.writeFile(secret, "s");
  const linked = path.join(root, "innocent.txt");
  await fs.link(secret, linked);
  await assert.rejects(readAttachmentGuarded(linked, [root], []), DENIED);
});

test("readAttachmentGuarded refuses a symlink swapped in after validation", async () => {
  const root = await attRoot();
  const outside = await attRoot();
  const secret = path.join(outside, "secret.txt");
  await fs.writeFile(secret, "TOP SECRET");
  const f = path.join(root, "doc.txt");
  await fs.writeFile(f, "fine");
  await assert.rejects(
    readAttachmentGuarded(f, [root], [], undefined, async (real) => {
      await fs.rm(real);
      await fs.symlink(secret, real);
    }),
    DENIED
  );
});

test("readAttachmentGuarded refuses a swap to a symlink even when the target is inside the root", async () => {
  const root = await attRoot();
  const f = path.join(root, "doc.txt");
  await fs.writeFile(f, "fine");
  const other = path.join(root, "other.txt");
  await fs.writeFile(other, "other");
  await assert.rejects(
    readAttachmentGuarded(f, [root], [], undefined, async (real) => {
      await fs.rm(real);
      await fs.symlink(other, real);
    }),
    DENIED
  );
});

test("readAttachmentGuarded refusals share one message", async () => {
  const root = await attRoot();
  const d = path.join(root, "sub");
  await fs.mkdir(d);
  const msgs: string[] = [];
  for (const p of [d, path.join(root, "missing"), "relative.txt"]) {
    try {
      await readAttachmentGuarded(p, [root], []);
    } catch (e: any) {
      msgs.push(e.message);
    }
  }
  assert.equal(msgs.length, 3);
  assert.equal(new Set(msgs).size, 1);
});

test("filter tools are exactly list/create/delete, and nothing forwards", () => {
  const names = setup().tools.map((t) => t.name).filter((n) => /filter|forward/i.test(n)).sort();
  assert.deepEqual(names, ["gmail_create_filter", "gmail_delete_filter", "gmail_list_filters"]);
});

test("gmail_trash caps batch size and has no permanent option", () => {
  const t = setup().get("gmail_trash");
  assert.ok(!("permanent" in t.schema));
  assert.equal(t.schema.message_ids.safeParse(new Array(501).fill("m")).success, false);
  assert.equal(t.schema.message_ids.safeParse([]).success, false);
  assert.match(t.desc, /recoverable/i);
});

test("gmail_delete_draft has no permanent option and does not mention permanent deletion", () => {
  const t = setup().get("gmail_delete_draft");
  assert.ok(!("permanent" in t.schema));
  assert.ok(!/permanent/i.test(t.desc));
});

test("gmail_apply_label refuses TRASH and SPAM before any Google call", async () => {
  const t = setup().get("gmail_apply_label");
  for (const label_id of ["TRASH", "SPAM", "trash", "Spam"]) {
    const res = await t.handler({ message_ids: ["m1"], label_id });
    assert.equal(res.isError, true, label_id);
    assert.match(res.content[0].text, new RegExp(label_id.toUpperCase()));
  }
});

test("gmail_create_filter exposes a fixed action vocabulary with no forward or raw label lists", () => {
  const t = setup().get("gmail_create_filter");
  const keys = Object.keys(t.schema).sort();
  assert.deepEqual(keys, ["account", "archive", "from", "label_id", "mark_important", "mark_read", "never_spam", "query", "star", "subject", "to", "trash"]);
  for (const bad of ["forward", "remove_label_ids", "add_label_ids", "delete", "permanent"]) {
    assert.ok(!(bad in t.schema), bad);
  }
});

test("gmail_create_filter refuses trash with a broad query before any Google call", async () => {
  const t = setup().get("gmail_create_filter");
  const res = await t.handler({ query: "*", trash: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /single sender/);
});

test("gmail_create_filter refuses system labels before any Google call", async () => {
  const t = setup().get("gmail_create_filter");
  for (const label_id of ["TRASH", "SPAM", "INBOX", "UNREAD", "STARRED", "CATEGORY_PROMOTIONS", "Label_1;x", "label_39", ""]) {
    const res = await t.handler({ from: "a@example.com", label_id: label_id || " " });
    assert.equal(res.isError, true, label_id);
    assert.match(res.content[0].text, /own labels/);
  }
});

test("gmail_create_filter requires a criterion and an action, and rejects CR/LF", async () => {
  const t = setup().get("gmail_create_filter");
  let res = await t.handler({ star: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /criterion/);
  res = await t.handler({ from: "   ", star: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /criterion/);
  res = await t.handler({ from: "a@example.com" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /action/);
  for (const field of ["from", "to", "subject", "query"]) {
    const args: any = { star: true };
    args[field] = "x\r\nevil";
    res = await t.handler(args);
    assert.equal(res.isError, true, field);
    assert.match(res.content[0].text, /line breaks/);
  }
});

test("gmail_list_filters is registered and read-only by description", () => {
  const t = setup().get("gmail_list_filters");
  assert.match(t.desc, /read-only/i);
});

test("gmail_update_draft rejects CR/LF in to/cc/bcc before any network call", async () => {
  const t = setup().get("gmail_update_draft");
  for (const field of ["to", "cc", "bcc"]) {
    const args: any = { draft_id: "d1" };
    args[field] = "a@example.com\nBcc: evil@example.com";
    const res = await t.handler(args);
    assert.equal(res.isError, true, field);
    assert.match(res.content[0].text, /line breaks/);
  }
});
