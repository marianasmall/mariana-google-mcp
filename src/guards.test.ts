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
  "iframe tag": `<IFRAME></IFRAME>`,
  "frame tag": `<frame>`,
  "object tag": `<object data="x"></object>`,
  "embed tag": `<EMBED>`,
  "percent-encoded scheme": `<img src="%68ttps://evil">`,
  "percent-encoded colon and slashes": `<img src="https%3A%2F%2Fevil/x">`,
  "fullwidth scheme": `<img src="ｈｔｔｐｓ：／／evil/x">`,
  "empty comment <!-->": `<!-->`,
  "comment <!--->": `<!--->`,
  "comment closed by --!>": `<!-- x --!>`,
  "svg style foreign content": `<svg><style><a href="https://ok"></style></svg>`,
  "math tag": `<math>`,
  "template tag": `<template>`,
  "noscript tag": `<noscript>`,
  "style block, even harmless": `<style>p{color:red}</style><a href="https://example.com">x</a>`,
  "title tag": `<title>Hi</title>`,
  "style close tag with nbsp": `<style>p{}</style ><a href="x{background:url(https://evil)}">x</a>`,
  "style close tag with vertical tab": `<style>p{}</style\u000b><a href="x{background:url(https://evil)}">x</a>`,
  "style body with anchor": `<style><a href=https://x></style>`,
  "style unclosed": `<style>p{color:red}`,
  "title body with tag": `<title><a href="https://ok"></title>`,
  "non-ascii before style then evil": `${"İ".repeat(5)}<style><a href="https://ok"></STYLE><link href=//evil/x>`,
  "bogus comment <!x": `<!x <a href="https://ok">>`,
  "bogus comment <?": `<?php <a href="https://ok"> ?>`,
  "bogus close tag": `</ x>`,
  "href value containing tag": `<a href="https://ok<link>">`,
  "doctype in the middle": `<p>x</p><!DOCTYPE html><a href="https://ok">x</a>`,
  "anchor inside style raw text": `<style>x{background:url(<a href="https://evil/x">)}</style>`,
  "anchor inside comment": `<!-- <a href="https://evil"> -->`,
  "anchor inside textarea": `<textarea><a href=https://evil></textarea>`,
  "unquoted href with semicolon": `<a href=https://evil/x;y>`,
  "anchor inside unclosed script": `<script><a href="https://evil">`,
  "svg data percent-encoded": `<img src="data:image/svg+xml,%3Csvg%3E%3Cimage%20href=%27https%3A%2F%2Fevil%2Fx%27/%3E%3C/svg%3E">`,
  "svg data base64": `<img src="data:image/svg+xml;base64,PHN2Zz48aW1hZ2UgaHJlZj0iaHR0cHM6Ly9ldmlsIi8+PC9zdmc+">`,
  "text/html data base64 iframe": `<iframe src="data:text/html;base64,PGltZyBzcmM9aHR0cHM6Ly9ldmlsPg=="></iframe>`,
  "raster data without base64": `<img src="data:image/png,AAAA">`,
  "import in text": `<style>@IMPORT 'x.css';</style>`,
};

// ---------------------------------------------------------------------------
// sanitizeDraftHtml: parse5 allowlist validator + re-serializer
// ---------------------------------------------------------------------------

const { sanitizeDraftHtml } = await import("./htmlGuard.js");
const parse5 = await import("parse5");

const HELP_RE = /HTML drafts allow basic formatting only: wrap links in <a href>, use inline style for color\/font\/spacing, images only cid:\/data:\/allowed hosts\./;

// Independent oracle: a second copy of the allowlist, so a typo in the guard cannot also hide in the check.
const ORACLE_ELEMENTS = new Set(
  "html head body meta p br div span b strong i em u s small sub sup blockquote pre code h1 h2 h3 h4 h5 h6 ul ol li hr a img table thead tbody tfoot tr td th caption colgroup col center font".split(" ")
);
const ORACLE_GLOBAL_ATTRS = new Set(
  "dir align valign width height colspan rowspan cellpadding cellspacing border bgcolor color face size title alt lang style".split(" ")
);

function isGuardRefusal(e: unknown): boolean {
  return e instanceof GuardError && HELP_RE.test((e as Error).message) && /^HTML draft refused: .+ is not allowed\./.test((e as Error).message);
}

/**
 * Property check on sanitizer OUTPUT: re-parse it with parse5 and assert that every node is
 * inside the allowlist, no attribute other than a@href can name a remote URL, img src is
 * cid:/data:image/allowed https host only, and style holds nothing that can fetch.
 */
function assertOutputClean(out: string, hosts: string[] = []): void {
  const hostSet = new Set(hosts.map((h) => h.toLowerCase()));
  const visit = (node: any): void => {
    for (const c of node.childNodes ?? []) {
      assert.notEqual(c.nodeName, "#comment", `comment survived in ${out}`);
      assert.notEqual(c.nodeName, "#documentType", `doctype survived in ${out}`);
      if (c.tagName) {
        assert.equal(c.namespaceURI, "http://www.w3.org/1999/xhtml", `foreign element in ${out}`);
        assert.ok(ORACLE_ELEMENTS.has(c.tagName), `element <${c.tagName}> in ${out}`);
        for (const a of c.attrs) {
          const tag = c.tagName;
          if (tag === "meta") {
            assert.equal(a.name, "charset", `meta attr ${a.name} in ${out}`);
          } else if (tag === "a" && a.name === "href") {
            assert.match(new URL(a.value).protocol, /^(https?|mailto|tel):$/, `href ${a.value}`);
            continue;
          } else if (tag === "a" && (a.name === "target" || a.name === "rel")) {
            // allowed
          } else if (tag === "img" && a.name === "src") {
            const ok =
              /^cid:/i.test(a.value) ||
              /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(a.value) ||
              (/^https:\/\//i.test(a.value) && hostSet.has(new URL(a.value).hostname));
            assert.ok(ok, `img src ${a.value} in ${out}`);
            continue;
          } else {
            assert.ok(ORACLE_GLOBAL_ATTRS.has(a.name), `attribute ${a.name} on <${tag}> in ${out}`);
          }
          if (a.name === "style") {
            assert.doesNotMatch(a.value, /url|image|@|\\|\/\*|expression|[<>\n\r]/i, `style ${a.value}`);
            assert.doesNotMatch(a.value.replace(/rgba?\([0-9.,%\s]*\)/gi, ""), /\(/, `style paren ${a.value}`);
          }
          assert.doesNotMatch(a.value, /https?:|ftp:|\/\//i, `URL in ${tag}@${a.name} in ${out}`);
        }
      }
      visit(c.content ?? c); // template content (never allowed, but walk it if present)
    }
  };
  visit(parse5.parse(out));
}

/** Serialized output with every <a ...> start tag removed: what is left must not mention http. */
function noHttpOutsideAnchors(out: string): boolean {
  return !/http/i.test(out.replace(/<a\s[^>]*>/gi, ""));
}

/** Either refuses with the standard GuardError, or returns output that passes the property check. */
function refusedOrClean(html: string, hosts: string[] = []): { refused: boolean; out?: string } {
  let out: string;
  try {
    out = sanitizeDraftHtml(html, { allowedImageHosts: hosts });
  } catch (e) {
    assert.ok(isGuardRefusal(e), `unexpected error for ${html}: ${e}`);
    return { refused: true };
  }
  assertOutputClean(out, hosts);
  return { refused: false, out };
}

// The two payloads an independent review proved in real Chromium against the old residue guard.
const PROVEN_PAYLOADS: Record<string, string> = {
  "a style= entity href smuggle (https)": `<a style=x&#32;href=&quot;&#10;;background:u&#114;l&#40;h&#116;tps&#58;&#47;&#47;evil.example/x&#41;;&quot;>hi</a>`,
  "a style= entity href smuggle (http)": `<a style=x&#32;href=&quot;&#10;;background:u&#114;l&#40;h&#116;tp&#58;&#47;&#47;evil.test/astyle&#41;;&quot;>hi</a>`,
  "a style= image-set smuggle": `<a style=x&#32;href=&quot;&#10;;background-image:image-set&#40;&quot;h&#116;tp&#58;&#47;&#47;evil.test/imgset&quot;&#32;1x&#41;;&quot;>z</a>`,
  "div style= bad-string smuggle": `<div style=&gt;&lt;a&#32;href=&quot;&#10;;background:u&#114;l&#40;h&#116;tp&#58;&#47;&#47;evil.test/badstring&#41;;x:&quot;&gt;>hi</div>`,
};

for (const [name, html] of Object.entries(PROVEN_PAYLOADS)) {
  test(`sanitizeDraftHtml refuses proven payload: ${name}`, () => {
    assert.throws(() => sanitizeDraftHtml(html, { allowedImageHosts: [] }), isGuardRefusal);
  });
}

// Every earlier bypass class: refused, or neutralized (output re-parses clean).
for (const [name, html] of Object.entries(REMOTE_BYPASSES)) {
  test(`sanitizeDraftHtml refuses or neutralizes: ${name}`, () => {
    refusedOrClean(`<p>hi</p>${html}`);
  });
}

test("sanitizeDraftHtml refuses each named bypass class, naming the offender", () => {
  const cases: Array<[string, RegExp]> = [
    [`<iframe srcdoc="&lt;img src=https://evil.test/x&gt;"></iframe>`, /<iframe> element/],
    [`<div style="background:image-set('https://evil.test/a.png' 1x)"></div>`, /image in style/],
    [`<p style='color:red;background:image-set("a.png" 1x, "https://evil.test/x" 2x)'>x</p>`, /image in style/],
    [`<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">`, /<img src>/],
    [`<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">`, /<img src>/],
    [`<style>p{color:red}</style><p>x</p>`, /<style> element/],
    [`<link rel="stylesheet" href="https://evil.test/a.css">`, /<link> element/],
    [`<base href="https://evil.test/"><img src="x.png">`, /<base> element/],
    [`<meta http-equiv="refresh" content="0;url=https://evil.test">`, /<meta http-equiv>/],
    [`<iframe src="https://evil.test/"></iframe>`, /<iframe> element/],
    [`<style>p{}</style ><a href="x{background:url(https://evil.test)}">x</a>`, /<style> element/],
    [`<svg><image href="https://evil.test/a.png"/></svg>`, /<svg> element/],
    [`<math><mi>x</mi></math>`, /<math> element/],
    [`<img src="https://evil.test/p.png">`, /<img src>/],
    [`<img src="cid:a" srcset="https://evil.test/b.png 2x">`, /srcset attribute on <img>/],
    [`<img src="cid:a" onerror="fetch('https://evil.test')">`, /onerror attribute on <img>/],
    [`<table background="https://evil.test/b.png"></table>`, /background attribute on <table>/],
    [`<p class="x">y</p>`, /class attribute on <p>/],
    [`<a href="javascript:alert(1)">x</a>`, /link scheme javascript:/],
    [`<a href="data:text/html,hi">x</a>`, /link scheme data:/],
    [`<a href="#top">x</a>`, /<a href> that is not an absolute/],
    [`<a href="https://example.com" ping="https://evil.test">x</a>`, /ping attribute on <a>/],
    [`<p style="background:red">x</p>`, /CSS property background/],
    [`<p style="border-image-source:none">x</p>`, /image in style/],
    [`<p style="position:absolute">x</p>`, /CSS property position/],
    [`<p style="color:var(--x)">x</p>`, /value of CSS property color/],
    [`<p style="color:red/**/">x</p>`, /a comment in style/],
    [`<p style="color:r\\65 d">x</p>`, /a backslash in style/],
    [`<p style="color:red&#10;">x</p>`, /line break or control character in style/],
    [`<p style="behavior:x">x</p>`, /CSS property behavior/],
    [`<p style="color:red;;foo">x</p>`, /CSS declaration/],
    [`<font face="Arial" style="font-size:12px" onclick="x">x</font>`, /onclick attribute on <font>/],
  ];
  for (const [html, offender] of cases) {
    assert.throws(
      () => sanitizeDraftHtml(html, { allowedImageHosts: [] }),
      (e: any) => isGuardRefusal(e) && offender.test(e.message),
      html
    );
  }
});

test("sanitizeDraftHtml drops comments, bogus comments and stray doctypes (no http survives outside a@href)", () => {
  for (const html of [
    `<!-- <img src="https://evil.test/x"> --><p>x</p>`,
    `<!--[if mso]><img src="https://evil.test/x"><![endif]--><p>y</p>`,
    `<!-- x --!><p>z</p>`,
    `<!--><p>a</p>`,
    `<!---><p>b</p>`,
    `<!x <img src="https://evil.test/x">>`,
    `<?php <img src="https://evil.test/x"> ?>`,
    `</ <img src="https://evil.test/x">>`,
    `<p>x</p><!DOCTYPE html><a href="https://example.com">x</a>`,
    `<!-- <a href="https://evil.test"> -->`,
  ]) {
    const r = refusedOrClean(html);
    assert.equal(r.refused, false, html);
    assert.ok(noHttpOutsideAnchors(r.out!), `${html} -> ${r.out}`);
    assert.doesNotMatch(r.out!, /<!/, `${html} -> ${r.out}`);
  }
});

const ALLOWED_INPUTS: string[] = [
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p style="color:#333">Hello</p></body></html>`,
  `<div style="font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #222">
     <h2 style="margin: 0 0 8px 0; font-weight: bold">Quarterly numbers</h2>
     <p>Hi team, <b>three</b> things, <i>briefly</i>:</p>
     <ul style="list-style-type: disc; padding-left: 20px"><li>One</li><li><u>Two</u></li><li><s>Three</s></li></ul>
     <table border="0" cellpadding="6" cellspacing="0" width="100%" style="border-collapse: collapse; border: 1px solid #ccc">
       <thead><tr><th align="left" style="background-color: rgb(240, 240, 240); padding: 6px 10px">Item</th><th>Amount</th></tr></thead>
       <tbody><tr><td style="padding: 6px 10px; border-bottom: 1px solid #eee">Widgets</td><td align="right" bgcolor="#fafafa">$1,200</td></tr></tbody>
       <tfoot><tr><td colspan="2" style="text-align: right; font-style: italic; color: rgba(0,0,0,0.6)">Total</td></tr></tfoot>
     </table>
     <p>Details: <a href="https://example.com" target="_blank" rel="noopener">https://example.com</a></p>
     <p>Mail <a href="mailto:someone@example.com">someone@example.com</a> or call <a href="tel:+15550100">555-0100</a>.</p>
     <blockquote style="border-left: 3px solid #ddd; margin: 0; padding-left: 10px">Quoted text</blockquote>
     <pre><code>code sample</code></pre><hr><center><font face="Arial" color="#555" size="2">small print</font></center>
   </div>`,
  `<p>Logo: <img src="cid:logo123" alt="Logo" width="80" height="20"></p>`,
  `<img src="data:image/png;base64,iVBORw0KGgo=" alt="pixel">`,
  `<p>See https://example.com/bare for more, 5 &lt; 6 &amp; done.</p>`,
  `<p style="font-weight: bold !important; display: inline-block; white-space: nowrap; vertical-align: top; max-width: 600px; min-width: 100px; border-radius: 4px; letter-spacing: 0.5px; text-decoration: underline; margin-top: 4px; padding-right: 2px; border-left-color: red; border-top: 1px dashed #000">x</p>`,
  `<p>Tom &amp; Jerry &#169; 2026, 100% sure</p>`,
  `<table><caption>Cap</caption><colgroup><col width="50%"><col></colgroup><tr><td rowspan="2" valign="top" dir="rtl" lang="ar" title="t">x</td></tr></table>`,
  `<p>sub<sub>1</sub> sup<sup>2</sup> <small>s</small> <em>e</em> <strong>s</strong> <span>sp</span><br>end</p><h1>a</h1><h6>b</h6><ol><li>x</li></ol>`,
];

test("sanitizeDraftHtml allows and round-trips normal formatted email", () => {
  for (const html of ALLOWED_INPUTS) {
    const r = refusedOrClean(html);
    assert.equal(r.refused, false, html);
    // Re-sanitizing the output is a fixed point: the serialized tree re-parses to the same tree.
    assert.equal(sanitizeDraftHtml(r.out!, { allowedImageHosts: [] }), r.out, html);
  }
  const out = sanitizeDraftHtml(ALLOWED_INPUTS[1], { allowedImageHosts: [] });
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener">https:\/\/example\.com<\/a>/);
  assert.match(out, /<table border="0" cellpadding="6"/);
  assert.match(out, /style="padding: 6px 10px; border-bottom: 1px solid #eee"/);
  assert.match(out, /color: rgba\(0,0,0,0\.6\)/);
  assert.match(sanitizeDraftHtml(ALLOWED_INPUTS[2], { allowedImageHosts: [] }), /<img src="cid:logo123" alt="Logo" width="80" height="20">/);
  assert.match(sanitizeDraftHtml(ALLOWED_INPUTS[3], { allowedImageHosts: [] }), /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="pixel">/);
  const doc = sanitizeDraftHtml(ALLOWED_INPUTS[0], { allowedImageHosts: [] });
  assert.equal(doc, `<html><head><meta charset="utf-8"></head><body><p style="color:#333">Hello</p></body></html>`);
  // Entities come back escaped, never as live markup.
  assert.match(sanitizeDraftHtml(ALLOWED_INPUTS[4], { allowedImageHosts: [] }), /5 &lt; 6 &amp; done/);
});

test("sanitizeDraftHtml allowedImageHosts: exact https host only", () => {
  const allow = ["Images.Example.com"];
  for (const ok of ["https://images.example.com/l.png", "HTTPS://IMAGES.EXAMPLE.COM/l.png", "https://images.example.com/a/b.png?x=1#f"]) {
    const r = refusedOrClean(`<img src="${ok}">`, allow.map((h) => h.toLowerCase()));
    assert.equal(r.refused, false, ok);
  }
  for (const bad of [
    "https://images.example.com:443/l.png",
    "https://images.example.com:8443/l.png",
    "https://user@images.example.com/l.png",
    "https://user:pw@images.example.com/l.png",
    "https://images.example.com./l.png",
    "https://images.example.com.evil.test/l.png",
    "https://evil-images.example.com/l.png",
    "https://a.images.example.com/l.png",
    "https://example.com/l.png",
    "https://images.example.com@evil.test/l.png",
    "https://evil.test/https://images.example.com/l.png",
    "https://іmages.example.com/l.png", // Cyrillic i
    "http://images.example.com/l.png",
    "//images.example.com/l.png",
    "https:\\\\images.example.com/l.png",
    "https:images.example.com/l.png",
    " https://images.example.com/l.png",
  ]) {
    assert.throws(() => sanitizeDraftHtml(`<img src="${bad}">`, { allowedImageHosts: allow }), isGuardRefusal, bad);
  }
  // A trailing-dot entry never matches anything, and no hosts means no https images at all.
  assert.throws(() => sanitizeDraftHtml(`<img src="https://images.example.com/l.png">`, { allowedImageHosts: ["images.example.com."] }), isGuardRefusal);
  assert.throws(() => sanitizeDraftHtml(`<img src="https://images.example.com/l.png">`, { allowedImageHosts: [] }), isGuardRefusal);
});

test("sanitizeDraftHtml property check: random mixes of allowed and hostile fragments refuse or come out clean", () => {
  const pieces = [...ALLOWED_INPUTS, ...Object.values(REMOTE_BYPASSES), ...Object.values(PROVEN_PAYLOADS), "<", ">", "\"", "'", "&", "<table>", "</td>", "<a href=https://example.com>", "<!--", "-->", "</p>", " "];
  let seed = 1234567;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let refused = 0;
  for (let i = 0; i < 600; i++) {
    let html = "";
    for (let k = 0, m = 1 + rand(5); k < m; k++) html += pieces[rand(pieces.length)];
    if (refusedOrClean(html).refused) refused++;
  }
  assert.ok(refused > 0 && refused < 600, `refused ${refused}/600`);
});

