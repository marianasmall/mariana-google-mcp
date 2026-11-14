import * as fs from "node:fs/promises";
import * as path from "node:path";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const SENSITIVE_BASENAMES: RegExp[] = [
  /^id_(rsa|dsa|ecdsa|ed25519)/,
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

/**
 * Resolve an attachment path to its real location, or throw GuardError.
 * The realpath (symlinks and ".." resolved) must sit under one of `roots`.
 */
export async function resolveAttachmentPath(
  p: string,
  roots: string[],
  forbiddenDirs: string[]
): Promise<string> {
  if (!path.isAbsolute(p)) throw new GuardError("Attachment path must be absolute");

  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    throw new GuardError("Attachment path does not exist or is not readable");
  }

  let matchedRoot: string | null = null;
  for (const r of roots) {
    const realRoot = await tryRealpath(r);
    if (realRoot && isUnder(real, realRoot)) {
      matchedRoot = realRoot;
      break;
    }
  }
  if (!matchedRoot) throw new GuardError("Attachment path is outside the allowed attachment roots");

  const segments = path.relative(matchedRoot, real).split(path.sep);
  if (segments.some((s) => s.startsWith("."))) {
    throw new GuardError("Attachment path contains a hidden file or directory");
  }

  for (const f of forbiddenDirs) {
    const realForbidden = (await tryRealpath(f)) ?? path.resolve(f);
    if (real === realForbidden || isUnder(real, realForbidden)) {
      throw new GuardError("Attachment path is inside a forbidden directory");
    }
  }

  const base = path.basename(real);
  if (SENSITIVE_BASENAMES.some((re) => re.test(base))) {
    throw new GuardError("Attachment filename looks like a credential or key file");
  }

  return real;
}

export function assertNoCRLF(field: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n]/.test(value)) {
    throw new GuardError(`${field} must not contain line breaks`);
  }
}

export function assertSafeAddLabels(ids: string[]): void {
  for (const id of ids) {
    if (id === "TRASH" || id === "SPAM") {
      throw new GuardError(`Adding the ${id} label is not allowed`);
    }
  }
}

export function assertAttendeesAllowed(attendees: string[], allowed: string[]): void {
  const ok = new Set(allowed.map((a) => a.toLowerCase()));
  for (const a of attendees) {
    if (!ok.has(a.toLowerCase())) {
      throw new GuardError(`Attendee ${a} is not on the allowed attendees list`);
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
