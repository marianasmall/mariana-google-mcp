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

// HTML draft bodies are validated by sanitizeDraftHtml in ./htmlGuard.ts (parse5 allowlist + re-serializer).

export function assertSafeAddLabels(ids: string[]): void {
  for (const id of ids) {
    const up = id.toUpperCase();
    if (up === "TRASH" || up === "SPAM") {
      throw new GuardError(`Adding the ${up} label is not allowed. Apply a normal label instead, or ask the user to trash or spam the message themselves.`);
    }
  }
}

// Filters may only add the user's own labels (IDs like "Label_39"). System labels
// (TRASH, SPAM, INBOX, UNREAD, CATEGORY_*, ...) are refused so a filter can never
// trash, spam, archive or hide mail. Star/important come from fixed booleans.
export function assertUserLabelId(id: string): void {
  if (!/^Label_[A-Za-z0-9_]+$/.test(id)) {
    throw new GuardError(`Filters can only apply your own labels (IDs like "Label_39"), not "${id}". Use gmail_list_labels to find the label ID, or gmail_create_label to make one.`);
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
