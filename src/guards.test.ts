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
  assert.deepEqual(config.getAllowedImageHosts(base), []);
  assert.deepEqual(config.getAllowedImageHosts({ ...base, allowedImageHosts: ["images.example.com"] }), ["images.example.com"]);
});

test("sensitive id_* basenames match case-insensitively", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guards-id-"));
  await fs.writeFile(path.join(root, "ID_RSA"), "x");
  await assert.rejects(guards.resolveAttachmentPath(path.join(root, "ID_RSA"), [root], []), /Attachment not allowed/);
});

const REMOTE_BYPASSES: Record<string, string> = {
  "plain https img": `<img src="https://evil.test/p.png">`,
  "plain http img": `<img src="http://evil.test/p.png">`,
  "uppercase SRC and scheme": `<IMG SRC="HTTPS://EVIL.TEST/p.png">`,
  "single quotes": `<img src='https://evil.test/p.png'>`,
  "no quotes": `<img src=https://evil.test/p.png>`,
  "spaces around equals": `<img src  =  "https://evil.test/p.png">`,
  "slash instead of space": `<img/src="https://evil.test/p.png">`,
  "protocol-relative": `<img src="//evil.test/p.png">`,
  "backslash protocol-relative": `<img src="\\\\evil.test/p.png">`,
  "srcset multiple urls": `<img srcset="cid:a 1x, https://evil.test/b.png 2x">`,
  "srcset second url no space": `<img srcset="cid:a 1x,https://evil.test/b.png 2x">`,
  "background attribute": `<table background="https://evil.test/b.png"></table>`,
  "css url with spaces": `<div style="background: url(  'https://evil.test/b.png'  )"></div>`,
  "css url unquoted": `<style>p{background:url(https://evil.test/b.png)}</style>`,
  "style attr background-image": `<div style="background-image:url(//evil.test/x.png)"></div>`,
  "css @import string": `<style>@import "https://evil.test/a.css";</style>`,
  "css @import url": `<style>@import url(https://evil.test/a.css);</style>`,
  "css image-set": `<div style="background:image-set('https://evil.test/a.png' 1x)"></div>`,
  "entity-encoded scheme decimal": `<img src="&#104;ttp://evil.test/p.png">`,
  "entity-encoded scheme hex": `<img src="&#x68;&#x74;&#x74;&#x70;s://evil.test/p.png">`,
  "entity-encoded colon": `<img src="https&colon;//evil.test/p.png">`,
  "entity without semicolon": `<img src="&#104ttp://evil.test/p.png">`,
  "double-encoded": `<img src="&amp;#104;ttp://evil.test/p.png">`,
  "tab inside scheme": `<img src="ht&Tab;tp://evil.test/p.png">`,
  "entity in css url": `<div style="background:url(&#104;ttp://evil.test/x.png)"></div>`,
  "css escape in url": `<style>p{background:u\\72l(https://evil.test/x.png)}</style>`,
  "css escaped scheme": `<style>p{background:url(\\68 ttps://evil.test/x.png)}</style>`,
  "link stylesheet": `<link rel="stylesheet" href="https://evil.test/a.css">`,
  "quote-hidden gt before href": `<link title=">" rel="stylesheet" href="https://evil.test/a.css">`,
  "svg image href": `<svg><image href="https://evil.test/a.png"/></svg>`,
  "base href": `<base href="https://evil.test/">`,
  "iframe src": `<iframe src="https://evil.test/"></iframe>`,
  "video poster": `<video poster="https://evil.test/a.png"></video>`,
  "unterminated tag": `<img src="https://evil.test/p.png"`,
  // Residue-rule bypass regressions
  "stray quote hides link tag": `<a title=x" ><link rel=stylesheet href=https://evil/a.css><a x=">`,
  "srcdoc nested html": `<iframe srcdoc="&lt;img src=https://evil/x&gt;">`,
  "image-set second string": `<div style="background:image-set(&quot;a.png&quot; 1x, &quot;https://evil/x&quot; 2x)"></div>`,
  "image-set second string (single quotes)": `<div style='background:image-set("a.png" 1x, "https://evil/x" 2x)'></div>`,
  "meta refresh": `<meta http-equiv=refresh content="0;url=https://evil">`,
  "double-encoded bare scheme": `&amp;#104;ttps://evil`,
  "css escape url bare": `url(\\68 ttps://evil)`,
  "protocol-relative img unquoted": `<img src=//evil/x>`,
  "bare url in text": `see https://evil.test/x`,
  "fake anchor start inside unquoted attr": `<link x=<a href=https://evil/x>`,
  "fake anchor inside quoted attr": `<link x='<a ' href=https://evil/x>`,
  "link after a fake anchor": `<a href="https://example.com/"><link rel=stylesheet href=//evil/x>`,
  "ftp scheme": `<img src="ftp://evil/x">`,
  "import in text": `<style>@IMPORT 'x.css';</style>`,
};

for (const [name, html] of Object.entries(REMOTE_BYPASSES)) {
  test(`assertNoRemoteResources refuses: ${name}`, () => {
    assert.throws(
      () => guards.assertNoRemoteResources(`<p>hi</p>${html}`),
      (e: any) => e instanceof guards.GuardError && /remote images/i.test(e.message) && /wrap links as <a href>/i.test(e.message) && /plain text/.test(e.message)
    );
  });
}

test("assertNoRemoteResources allows cid:, data:, plain links, plain text", () => {
  for (const html of [
    `<p>Hello <b>there</b></p>`,
    `<img src="cid:logo123">`,
    `<img src="data:image/png;base64,//8AAA==">`,
    `<img srcset="data:image/png;base64,AAAA 1x, cid:b 2x">`,
    `<a href="https://example.com/page">click</a>`,
    `<a href='http://example.com'>click</a>`,
    `<div style="color:red;background:url(data:image/png;base64,AAAA)"></div>`,
    `<div style="background:url(cid:bg)"></div>`,
    `<p>Tom &amp; Jerry &#169; 2026</p>`,
    `<a href="https://example.com/page">link</a>`,
    `<a href='https://example.com'>link</a>`,
    `<a href=https://example.com/x>link</a>`,
    `<a\n  href="https://example.com/?a=1&amp;b=2" target="_blank">link</a>`,
    `<img src="logo.png">`, // relative: resolves nowhere remote, and <base> is refused
    `<p>Hello</p>`,
  ]) {
    assert.doesNotThrow(() => guards.assertNoRemoteResources(html), html);
  }
});

test("assertNoRemoteResources allowedImageHosts: exact https host only", () => {
  const allow = ["Example.com"];
  assert.doesNotThrow(() => guards.assertNoRemoteResources(`<img src="https://example.com/logo.png">`, allow));
  assert.doesNotThrow(() => guards.assertNoRemoteResources(`<img src="HTTPS://EXAMPLE.COM/logo.png">`, allow));
  assert.doesNotThrow(() => guards.assertNoRemoteResources(`<div style="background:url('https://example.com/b.png')"></div>`, allow));
  assert.doesNotThrow(() => guards.assertNoRemoteResources(`<img srcset="https://example.com/a.png 1x, cid:b 2x">`, allow));
  for (const bad of [
    "https://example.com.evil.test/logo.png",
    "https://evil-example.com/logo.png",
    "https://images.example.com/logo.png",
    "https://evil.test/https://example.com/logo.png",
    "https://example.com@evil.test/logo.png",
    "https://evil.test@example.com/logo.png",
    "http://example.com/logo.png",
    "//example.com/logo.png",
    "https://example.com.@evil.test/x.png",
  ]) {
    assert.throws(() => guards.assertNoRemoteResources(`<img src="${bad}">`, allow), guards.GuardError, bad);
  }
  const imgHost = ["images.example.com"];
  assert.doesNotThrow(() => guards.assertNoRemoteResources(`<img src="https://images.example.com/l.png">`, imgHost));
  assert.throws(() => guards.assertNoRemoteResources(`<img src="https://images.example.com/l.png">`), guards.GuardError);
  // Default (no allowed hosts) still refuses.
  assert.throws(() => guards.assertNoRemoteResources(`<img src="https://example.com/logo.png">`), guards.GuardError);
  assert.throws(() => guards.assertNoRemoteResources(`<img srcset="https://example.com.evil.test/a.png 1x">`, allow), guards.GuardError);
});
