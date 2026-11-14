import * as fs from "node:fs/promises";
import * as path from "node:path";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const SENSITIVE_BASENAMES: RegExp[] = [
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keychain-db)$/i,
  /^\.env/,
  /^(credentials|token)s?\.json$/i,
];

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

async function checkAttachmentPath(
  p: string,
  roots: string[],
  forbiddenDirs: string[]
): Promise<string | null> {
  if (!path.isAbsolute(p)) return null;
  const real = await tryRealpath(p);
  if (!real) return null;

  let matchedRoot: string | null = null;
  for (const r of roots) {
    const realRoot = await tryRealpath(r);
    if (realRoot && isUnder(real, realRoot)) {
      matchedRoot = realRoot;
      break;
    }
  }
  if (!matchedRoot) return null;

  if (path.relative(matchedRoot, real).split(path.sep).some((s) => s.startsWith("."))) return null;

  for (const f of forbiddenDirs) {
    const realForbidden = (await tryRealpath(f)) ?? path.resolve(f);
    if (real === realForbidden || isUnder(real, realForbidden)) return null;
  }

  if (SENSITIVE_BASENAMES.some((re) => re.test(path.basename(real)))) return null;
  return real;
}

/**
 * Resolve an attachment path to its real location, or throw GuardError.
 * The realpath (symlinks and ".." resolved) must sit under one of `roots`.
 * Every rejection throws the SAME message, so the error cannot be used to
 * learn whether a given file exists. The rejected path is never echoed.
 */
export async function resolveAttachmentPath(
  p: string,
  roots: string[],
  forbiddenDirs: string[]
): Promise<string> {
  const real = await checkAttachmentPath(p, roots, forbiddenDirs);
  if (real === null) {
    throw new GuardError(attachmentDeniedMessage(roots));
  }
  return real;
}

/** The single message used for every attachment rejection (shared with callers that must not leak more). */
export function attachmentDeniedMessage(roots: string[]): string {
  return (
    `Attachment not allowed. Attach only an existing file inside one of these folders: ${roots.join(", ")}, ` +
    "not inside a hidden folder or a credentials folder. Save the file into one of those folders, " +
    "or ask the user to add a folder to attachmentRoots in config.json."
  );
}

export function assertNoCRLF(field: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n]/.test(value)) {
    throw new GuardError(`${field} must not contain line breaks (CR or LF). Remove them and pass a single-line value; separate multiple addresses with commas.`);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", bsol: "\\",
  tab: "\t", newline: "\n", lpar: "(", rpar: ")", period: ".", comma: ",", semi: ";",
  num: "#", equals: "=", nbsp: " ",
};

function decodeEntitiesOnce(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    if (hex !== undefined || dec !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    const lower = String(name).toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
    // Browsers also accept some entities without a semicolon, glued to following letters.
    for (let k = lower.length - 1; k >= 2; k--) {
      const head = lower.slice(0, k);
      if (Object.hasOwn(NAMED_ENTITIES, head)) return NAMED_ENTITIES[head] + String(name).slice(k) + (m.endsWith(";") ? ";" : "");
    }
    return m;
  });
}

function decodeCssEscapes(s: string): string {
  return s
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_m, h) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/\\([^\n])/g, "$1");
}

function remoteResourceError(): GuardError {
  return new GuardError(
    "HTML drafts may not contain remote images, stylesheets, URLs or other remote resources: Gmail loads them as soon as the owner opens the draft, which tells the sender's server the draft was opened. " +
      "Wrap links as <a href>, remove images and styles from outside hosts, or use plain text. (cid: and data:image images are fine.)"
  );
}

const MAX_DECODE_PASSES = 5;

/**
 * Decode until stable (entities, optionally CSS escapes), stripping NUL, tab, CR
 * and LF, which URL parsers ignore. Returns null if the text is still changing
 * after MAX_DECODE_PASSES, which the caller treats as a refusal.
 */
function normalizeStable(s: string, cssEscapes: boolean, percent = false): string | null {
  const pass = (t: string): string => {
    let r = decodeEntitiesOnce(t);
    if (cssEscapes) r = decodeCssEscapes(r);
    // Malformed %-sequences are left alone (the regex only matches %XX).
    if (percent) r = r.replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    // NFKC folds fullwidth lookalikes (ｈｔｔｐｓ：／／) to ASCII so they cannot dodge the patterns.
    return r.normalize("NFKC").replace(/[\u0000\t\r\n]/g, "");
  };
  let cur = s;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    const next = pass(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return pass(cur) === cur ? cur : null;
}

/**
 * Find the value spans of `href` attributes on well-formed <a>/<area> tags.
 * A tag only counts if a spec-style tokenizer sees it as a real tag AND its raw
 * text matches <(a|area)\b[^<>]*> (it cannot contain another "<", and the first
 * ">" ends it). A quoted value, or an unquoted value with no whitespace, quotes
 * or ">", is a well-formed href value. Anything else is left in the residue.
 */
function findAnchorHrefSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = text.length;
  const isWs = (c: string) => c === " " || c === "\f" || c === "\t" || c === "\n" || c === "\r";
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0 || lt + 1 >= n) break;
    if (!/[a-z]/i.test(text[lt + 1])) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !isWs(text[j]) && text[j] !== "/" && text[j] !== ">") j++;
    const tagName = text.slice(lt + 1, j).toLowerCase();
    const hrefs: Array<{ vs: number; ve: number; quoted: boolean }> = [];
    let closed = false;
    while (j < n) {
      while (j < n && (isWs(text[j]) || text[j] === "/")) j++;
      if (j >= n) break;
      if (text[j] === ">") {
        closed = true;
        j++;
        break;
      }
      const ns = j;
      j++; // the first character always belongs to the name, even "="
      while (j < n && !isWs(text[j]) && text[j] !== "/" && text[j] !== ">" && text[j] !== "=") j++;
      const attrName = text.slice(ns, j).toLowerCase();
      let k = j;
      while (k < n && isWs(text[k])) k++;
      if (text[k] !== "=") continue;
      k++;
      while (k < n && isWs(text[k])) k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, k + 1);
        if (close < 0) {
          j = n;
          break;
        }
        if (attrName === "href") hrefs.push({ vs: k + 1, ve: close, quoted: true });
        j = close + 1;
      } else {
        let e = k;
        while (e < n && !isWs(text[e]) && text[e] !== ">") e++;
        if (attrName === "href") hrefs.push({ vs: k, ve: e, quoted: false });
        j = e;
      }
    }
    i = j;
    if (!closed) break;
    if (tagName === "style" || tagName === "title") {
      // The only raw-text tags allowed. Comments, svg/math, script, textarea etc. are refused
      // outright by RESIDUE_PATTERNS, so no other skipping rules (and no parser differentials) exist.
      // The body must hold no "<" at all, and the close tag is found with an ASCII-only regex on the
      // ORIGINAL string (never a lowercased copy, whose indices can shift on non-ASCII text).
      const closeRe = new RegExp("</" + tagName + "\\s*>", "gi");
      closeRe.lastIndex = j;
      const cm = closeRe.exec(text);
      if (!cm || text.slice(j, cm.index).includes("<")) throw remoteResourceError();
      i = cm.index + cm[0].length;
      continue;
    }
    if (tagName !== "a" && tagName !== "area") continue;
    if (!/^<(a|area)\b[^<>]*>$/i.test(text.slice(lt, j))) continue;
    for (const h of hrefs) {
      const value = text.slice(h.vs, h.ve);
      if (h.quoted ? /[<>]/.test(value) : /["'<>`=\s{}();]/.test(value)) continue;
      spans.push([h.vs, h.ve]);
    }
  }
  return spans;
}

// An https URL token; cut at quotes, brackets, parentheses, commas and backslashes.
const HTTPS_TOKEN = /https:\/\/[^\s"'<>(),\\]+/gi;
const CID_TOKEN = /cid:[^\s"'<>(),]*/gi;
// Raster, base64-only data images. SVG, text/html, percent-encoded and every other data: form is
// not an allowed span and is refused by RESIDUE_PATTERNS. The payload charset has no ":".
const DATA_IMAGE_TOKEN = /data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*/gi;

/** Strip the ALLOWED URL spans; whatever is left is the residue. */
function residueOf(text: string, hosts: Set<string>): string {
  let out = "";
  let pos = 0;
  for (const [s, e] of findAnchorHrefSpans(text)) {
    out += text.slice(pos, s);
    pos = e;
  }
  out += text.slice(pos);
  return out
    .replace(CID_TOKEN, "")
    .replace(DATA_IMAGE_TOKEN, "")
    .replace(HTTPS_TOKEN, (m) => {
      try {
        const u = new URL(m);
        return u.protocol === "https:" && !u.username && !u.password && hosts.has(u.hostname.toLowerCase()) ? "" : m;
      } catch {
        return m;
      }
    });
}

// Anything matching one of these in the residue is refused (case-insensitive).
const RESIDUE_PATTERNS: RegExp[] = [
  /https?:/i,
  /\/\/\S/, // protocol-relative
  /ftp:/i,
  /url\s*\(\s*(?!(?:""|''|)\s*\))/i, // url( with anything but an empty argument
  /@import/i,
  /srcdoc/i,
  /http-equiv/i,
  /<\s*(?:i?frame|frameset|object|embed)\b/i, // drafts never need embedded documents
  /<\s*[!?]|<\/(?![a-z])/i, // bogus comments (<!x, <?, </ + non-letter); the one allowed doctype is stripped first
  /<!--|<\s*(?:svg|math|script|noscript|xmp|plaintext|noembed|noframes|template|textarea)\b/i, // ambiguous parsing contexts
  /data:(?!image\/(?:png|jpe?g|gif|webp);base64,)/i, // any data: form except raster base64 images
];

/**
 * Refuse an HTML body that could fetch (or hide) anything remote when the draft
 * is merely opened. Residue rule: normalize (entities, CSS escapes, NUL/tab/CR/LF,
 * looped until stable), remove ONLY the allowed URL spans (the href value of a
 * well-formed <a>/<area> tag, cid: and data:image values, and https URLs whose
 * host EXACTLY equals an `allowedImageHosts` entry), then refuse if ANY URL-like
 * text is left: http(s):, ftp:, protocol-relative //, url(...), @import, srcdoc,
 * http-equiv. Bare URLs in text are refused too. Fails closed.
 */
export function assertNoRemoteResources(html: string, allowedImageHosts: string[] = []): void {
  const hosts = new Set(allowedImageHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));

  // The residue is the authority. Two normalized views, each of which must come out clean:
  // (1) entities + CSS escapes decoded; (2) entities only, with backslashes read as slashes
  // (browsers treat "\\host" like "//host", and CSS decoding would eat the backslashes).
  const decoded = normalizeStable(html, true);
  const entityOnly = normalizeStable(html, false);
  const pctDecoded = normalizeStable(html, true, true); // third view: %XX decoded too
  if (decoded === null || entityOnly === null || pctDecoded === null) throw remoteResourceError();
  // The raw HTML is checked as well, so a payload that normalization mangles cannot hide.
  for (const view of [decoded, entityOnly.replace(/\\/g, "/"), pctDecoded, html]) {
    // Exactly one leading doctype is allowed; anywhere else it is a bogus comment and is refused.
    const residue = residueOf(view.replace(/^\s*<!doctype\s+html[^<>]*>/i, ""), hosts);
    if (RESIDUE_PATTERNS.some((re) => re.test(residue))) throw remoteResourceError();
  }
}

export function assertSafeAddLabels(ids: string[]): void {
  for (const id of ids) {
    const up = id.toUpperCase();
    if (up === "TRASH" || up === "SPAM") {
      throw new GuardError(`Adding the ${up} label is not allowed. Apply a normal label instead, or ask the user to trash or spam the message themselves.`);
    }
  }
}

export function assertAttendeesAllowed(attendees: string[], allowed: string[]): void {
  const ok = new Set(allowed.map((a) => a.toLowerCase()));
  for (const a of attendees) {
    if (!ok.has(a.toLowerCase())) {
      throw new GuardError(`Attendee ${a} is not on the allowed attendees list. Remove that attendee, or ask the user to add the address to allowedAttendees in config.json.`);
    }
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
