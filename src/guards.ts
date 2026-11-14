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
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? m;
  });
}

/** Decode HTML entities repeatedly, so double-encoded text cannot hide a scheme. */
function decodeEntities(s: string): string {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = decodeEntitiesOnce(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function decodeCssEscapes(s: string): string {
  return s
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_m, h) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/\\([^\n])/g, "$1");
}

// Characters browsers ignore or strip inside URLs, plus invisible lookalikes.
const URL_NOISE = new RegExp(
  "[\\u0000-\\u0020\\u007f-\\u00a0\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u2060\\ufeff]",
  "g"
);

function remoteResourceError(): GuardError {
  return new GuardError(
    "HTML drafts may not contain remote images, stylesheets or other remote resources: Gmail loads them as soon as the owner opens the draft, which tells the sender's server the draft was opened. " +
      "Remove the remote images and styles (cid: and data: images are fine), or use the plain-text `body` instead. The owner can add images by hand in Gmail."
  );
}

/**
 * Refuse an HTML body that would fetch anything from the internet when the
 * draft is merely opened: src, srcset, background, poster and similar
 * attributes, href on non-anchor tags (link, image, use, base), CSS url(),
 * @import and image-set(). Plain <a href> links are fine, since they need a
 * click. Anything that is not cid:, data: (or empty / a #fragment) once
 * entities and CSS escapes are decoded is treated as remote. The one
 * exception is an https: URL whose host EXACTLY equals an entry of
 * `allowedImageHosts` (no subdomain wildcards, no http:). Fails closed.
 */
export function assertNoRemoteResources(html: string, allowedImageHosts: string[] = []): void {
  const hosts = new Set(allowedImageHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));

  const urlOk = (raw: string): boolean => {
    const v = decodeEntities(raw).replace(URL_NOISE, "");
    if (v === "" || v.startsWith("#")) return true;
    const lower = v.toLowerCase();
    if (lower.startsWith("cid:") || lower.startsWith("data:")) return true;
    if (lower.startsWith("https://")) {
      try {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password && hosts.has(u.hostname.toLowerCase());
      } catch {
        return false;
      }
    }
    return false;
  };

  const srcsetOk = (raw: string): boolean => {
    const decoded = decodeEntities(raw);
    // Check both as written and with tab/newline stripped (URL parsers drop them).
    for (const text of [decoded, decoded.replace(/[\t\n\r\f\u0000]/g, "")]) {
      for (const token of text.split(/\s+/)) {
        if (token === "") continue;
        const lower = token.toLowerCase();
        if (lower.startsWith("data:") || lower.startsWith("cid:")) continue;
        for (const piece of token.split(",")) {
          if (piece === "" || /^\d+(\.\d+)?[wx]$/i.test(piece)) continue;
          if (!urlOk(piece)) return false;
        }
      }
    }
    return true;
  };

  const URL_ATTRS = new Set(["src", "background", "poster", "lowsrc", "dynsrc", "data", "xlink:href", "action", "formaction", "ping", "manifest", "icon"]);
  const tagRe = /<\s*([a-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(?:>|$)/gi;
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const tm of html.matchAll(tagRe)) {
    const tag = tm[1].toLowerCase();
    for (const am of tm[2].matchAll(attrRe)) {
      const name = am[1].toLowerCase();
      const value = am[2] ?? am[3] ?? am[4];
      if (value === undefined) continue;
      if (name === "srcset" || name === "imagesrcset") {
        if (!srcsetOk(value)) throw remoteResourceError();
      } else if (URL_ATTRS.has(name) || (name === "href" && tag !== "a" && tag !== "area")) {
        if (!urlOk(value)) throw remoteResourceError();
      }
    }
  }

  // CSS anywhere (style attributes, <style> blocks): decode entities, then CSS escapes.
  const css = decodeCssEscapes(decodeEntities(html));
  for (const m of css.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))/gi)) {
    if (!urlOk(m[1] ?? m[2] ?? m[3] ?? "")) throw remoteResourceError();
  }
  for (const m of css.matchAll(/@import\s*(?:url\s*\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]*))/gi)) {
    if (!urlOk(m[1] ?? m[2] ?? m[3] ?? "")) throw remoteResourceError();
  }
  for (const m of css.matchAll(/image-set\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (!urlOk(m[1] ?? m[2] ?? "")) throw remoteResourceError();
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
