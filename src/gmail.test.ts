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
  assert.ok(!desc.includes("/Users/"));
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
