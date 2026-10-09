#!/usr/bin/env node
// Export Gmail messages as native .eml files (full RFC 5322 MIME, attachments included).
//
// Usage:
//   node scripts/export_eml.mjs --account primary --out /path/to/dir [--dry-run] <messageId> [<messageId> ...]
//
// Why: evidence/archive pipelines need headers-intact .eml files, and the
// MCP's gmail_read returns parsed bodies only. This reuses the MCP's own OAuth
// token store (dist/auth.js) so there is nothing new to authorize.
//
// Filenames: YYYY-MM-DD_HHMM_<from-slug>_<subject-slug>_<messageId>.eml
// Never overwrites: an existing target file is skipped and reported.

import { google } from "googleapis";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// The MCP server receives GOOGLE_CLIENT_ID/SECRET from its mcpServers entry in
// ~/.claude.json. Outside the server, borrow the same entry so the script needs
// no separate secret plumbing. Values are never logged.
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf-8"));
    const entry =
      cfg.mcpServers?.["mariana-google"] ??
      Object.values(cfg.projects ?? {}).map((p) => p.mcpServers?.["mariana-google"]).find(Boolean);
    for (const [k, v] of Object.entries(entry?.env ?? {})) if (!process.env[k]) process.env[k] = v;
  } catch {}
}
const { getAuthClient } = await import("../dist/auth.js");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const account = arg("--account", "primary");
const outDir = arg("--out", null);
const dryRun = process.argv.includes("--dry-run");
const ids = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith("--")) return false;
  const prev = all[i - 1];
  return !(prev === "--account" || prev === "--out");
});

if (!outDir || ids.length === 0) {
  console.error("usage: export_eml.mjs --account <name> --out <dir> [--dry-run] <messageId>...");
  process.exit(2);
}

const slug = (s, n = 40) =>
  (s || "")
    .replace(/^(re|fwd?|fw):\s*/gi, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, n) || "untitled";

function header(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

const { client } = await getAuthClient(account);
const gmail = google.gmail({ version: "v1", auth: client });
await fs.mkdir(outDir, { recursive: true });

let ok = 0, skipped = 0, failed = 0;
for (const id of ids) {
  try {
    const meta = await gmail.users.messages.get({
      userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = meta.data.payload?.headers || [];
    const fromRaw = header(headers, "From");
    const display = fromRaw.replace(/<.*>/, "").replace(/"/g, "").trim();
    const from = display || (fromRaw.match(/<?([^<>@\s]+)@/) || [])[1] || "unknown";
    const subject = header(headers, "Subject");
    // Local time (America/Los_Angeles on this Mac), to match the case record.
    const when = new Date(Number(meta.data.internalDate));
    const p2 = (n) => String(n).padStart(2, "0");
    const dateSlug = `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}_${p2(when.getHours())}${p2(when.getMinutes())}`;
    const file = path.join(outDir, `${dateSlug}_${slug(from, 24)}_${slug(subject)}_${id}.eml`);

    try {
      await fs.access(file);
      console.log(`SKIP (exists) ${path.basename(file)}`);
      skipped++;
      continue;
    } catch {}

    if (dryRun) {
      console.log(`DRY  ${path.basename(file)}`);
      ok++;
      continue;
    }

    const raw = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
    const mime = Buffer.from(raw.data.raw, "base64url");
    await fs.writeFile(file, mime);
    console.log(`OK   ${path.basename(file)}  (${(mime.length / 1024).toFixed(0)} KB)`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${id}: ${e.message}`);
    failed++;
  }
}
console.log(`\n${ok} exported, ${skipped} skipped, ${failed} failed → ${outDir}`);
process.exit(failed ? 1 : 0);
