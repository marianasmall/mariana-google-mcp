// Pure builder for Gmail filter requests. No network: everything here is
// validated before gmail_create_filter touches Google, and is unit-tested
// directly against the exact payload that would be sent.
import { GuardError, assertNoCRLF, assertUserLabelId } from "./guards.js";

export interface FilterArgs {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  label_id?: string;
  star?: boolean;
  mark_important?: boolean;
  never_spam?: boolean;
  archive?: boolean;
  mark_read?: boolean;
  trash?: boolean;
}

export interface FilterRequest {
  criteria: Record<string, string>;
  action: { addLabelIds?: string[]; removeLabelIds?: string[] };
  hides: boolean;
}

// Senders whose mail a filter may never trash, archive or mark read: account
// security, sign-in codes and money alerts. Extend locally with
// `protectedSenders` in config.json (kept out of this public repo).
export const DEFAULT_PROTECTED_SENDERS = [
  "google.com",
  "apple.com",
  "icloud.com",
  "microsoft.com",
  "github.com",
  "paypal.com",
  "1password.com",
  "anthropic.com",
];

// Domains shared by huge numbers of unrelated people. A cleanup filter on one
// of these must name a full address, never the whole domain.
export const SHARED_MAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "gmx.com", "zoho.com", "fastmail.com",
];
// Second-level labels used under country codes (co.uk, com.au, ...).
const GENERIC_SLD = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

function isTooBroadDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (SHARED_MAIL_DOMAINS.includes(d)) return true;
  const parts = d.split(".");
  return parts.length === 2 && GENERIC_SLD.has(parts[0]);
}

// Local part must start with a letter/digit ("_@gmail.com" would tokenize to
// the whole domain).
const SENDER_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._%+-]*@)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
// Subjects on hiding filters: plain words only, no Gmail operators ( ) { } " - OR.
const SAFE_SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9 .,!'&:$%#]*$/;

function senderDomain(from: string): string {
  return from.toLowerCase().split("@").pop()!;
}

// Gmail matches `from:` by tokens, so "accounts.google" would still catch
// accounts.google.com. Protected if the candidate's labels sit contiguously
// anywhere inside a protected domain, or the candidate is a subdomain of one.
function containsRun(hay: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j] === n)) return true;
  }
  return false;
}

export function isProtectedSender(from: string, protectedSenders: string[]): boolean {
  const d = senderDomain(from).replace(/\.+$/, "");
  const dl = d.split(".");
  return protectedSenders.some((p) => {
    const q = p.toLowerCase().replace(/^@/, "").replace(/\.+$/, "");
    if (!q) return false;
    const ql = q.split(".");
    // Brand label ("google" in google.com) appearing as any part of the
    // candidate catches stop-short forms like service.paypal / accounts.google.
    const brand = ql[0];
    return d === q || d.endsWith("." + q) || containsRun(ql, dl) || (ql.length >= 2 && dl.includes(brand));
  });
}

/** Pull the address out of a From header like `Name <a@b.com>` or `a@b.com`. */
export function addressFromHeader(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim();
}

export function buildFilterRequest(args: FilterArgs, protectedSenders: string[]): FilterRequest {
  const criteria: Record<string, string> = {};
  for (const k of ["from", "to", "subject", "query"] as const) {
    const v = args[k];
    assertNoCRLF(k, v);
    if (v && v.trim()) criteria[k] = v.trim();
  }
  if (Object.keys(criteria).length === 0) {
    throw new GuardError("At least one criterion (from, to, subject, query) is required.");
  }

  const add: string[] = [];
  const remove: string[] = [];
  if (args.label_id) {
    assertUserLabelId(args.label_id);
    add.push(args.label_id);
  }
  if (args.star) add.push("STARRED");
  if (args.mark_important) add.push("IMPORTANT");
  if (args.trash) add.push("TRASH");
  if (args.never_spam) remove.push("SPAM");
  if (args.archive) remove.push("INBOX");
  if (args.mark_read) remove.push("UNREAD");
  if (add.length === 0 && remove.length === 0) {
    throw new GuardError("At least one action (label_id, star, mark_important, never_spam, archive, mark_read, trash) is required.");
  }
  if (args.trash && (args.star || args.mark_important || args.never_spam)) {
    throw new GuardError("trash cannot be combined with star, mark_important or never_spam. Pick one intent.");
  }

  const hides = Boolean(args.trash || args.archive || args.mark_read || args.never_spam);
  if (hides) {
    // A filter keeps running after the session. Anything that hides mail (or
    // lets it past the spam check) must name ONE sender, so a filter can never
    // sweep broad swaths of mail out of sight.
    if (!criteria.from || criteria.to || criteria.query) {
      throw new GuardError("archive, mark_read, trash and never_spam need a single sender in `from` (an address or a domain like news.example.com), optionally narrowed by `subject`; `to` and `query` are not allowed with them.");
    }
    if (criteria.subject && (!SAFE_SUBJECT_RE.test(criteria.subject) || /\b(OR|AND)\b/.test(criteria.subject))) {
      throw new GuardError("With archive, mark_read, trash or never_spam, `subject` must be plain words (letters, digits, spaces, basic punctuation), with no Gmail operators like ( ) { } \" - OR.");
    }
    if (!SENDER_RE.test(criteria.from)) {
      throw new GuardError(`\`from\` must be one email address or domain (no spaces, wildcards, OR, or search operators), not "${criteria.from}".`);
    }
    if (!criteria.from.includes("@") && isTooBroadDomain(criteria.from)) {
      throw new GuardError(`${criteria.from} is shared by too many unrelated senders. Name the full address (e.g. deals@${criteria.from}) instead of the whole domain.`);
    }
    if (isProtectedSender(criteria.from, protectedSenders)) {
      throw new GuardError(`${criteria.from} is a protected sender (security, sign-in or money mail). Filters may not trash, archive, mark read or never-spam it (spoofed mail from these domains is common phishing). The user can do this in Gmail settings if they really want it.`);
    }
  }

  const action: FilterRequest["action"] = {};
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  return { criteria, action, hides };
}
