import * as fs from "fs/promises";
import * as path from "path";
import { getConfigDir, safeChmod } from "./config.js";
import { GuardError } from "./guards.js";

const LOG_FILE = "action-log.jsonl";
const MAX_ERROR_CHARS = 300;

export interface ActionLogEntry {
  timestamp: string; tool: string; account: string; summary: string; ids?: string[];
  /** Present only on non-success entries. */
  outcome?: "failed" | "refused";
}

export async function logAction(entry: ActionLogEntry): Promise<void> {
  const logPath = path.join(getConfigDir(), LOG_FILE);
  const line = JSON.stringify(entry) + "\n";
  // mode applies on creation; safeChmod tightens a log that already existed.
  await fs.appendFile(logPath, line, { encoding: "utf-8", mode: 0o600 });
  await safeChmod(logPath, 0o600);
}

/**
 * Collapse newlines and redact credential-shaped strings. Used for every
 * failure/refusal message, before truncation, so a secret cannot survive by
 * sitting inside the first 300 characters.
 */
export function sanitizeErrorText(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/ya29\.[\w-]+/g, "[redacted]")
    .replace(/1\/\/[\w-]+/g, "[redacted]")
    .replace(/(refresh|access)_token["'=:\s]+\S+/gi, "[redacted]");
}

/**
 * Record a failed or refused write attempt. Logs only the tool, the account
 * name and a short error message: never tokens, headers, request bodies or
 * email text. Never throws, so it cannot mask the original error.
 */
export async function logFailure(tool: string, account: string, error: unknown): Promise<void> {
  try {
    const raw = sanitizeErrorText(error instanceof Error ? error.message : String(error));
    const msg = raw.length > MAX_ERROR_CHARS ? raw.slice(0, MAX_ERROR_CHARS) + "..." : raw;
    const refused = error instanceof GuardError;
    await logAction({
      timestamp: new Date().toISOString(),
      tool,
      account,
      summary: `${refused ? "Refused" : "Failed"}: ${msg}`,
      outcome: refused ? "refused" : "failed",
    });
  } catch {
    // A logging problem must not hide the real error.
  }
}

/**
 * Wrap a write tool's handler so every failure path is logged: thrown errors
 * ("failed") and guard refusals returned as isError results ("refused").
 */
export function withFailureLog<A extends { account?: string }, R>(
  tool: string,
  handler: (args: A) => Promise<R>
): (args: A) => Promise<R> {
  return async (args: A) => {
    const account = args?.account || "default";
    let result: R;
    try {
      result = await handler(args);
    } catch (err) {
      await logFailure(tool, account, err);
      throw err;
    }
    const r = result as any;
    if (r && r.isError === true) {
      await logFailure(tool, account, new GuardError(String(r.content?.[0]?.text ?? "refused")));
    }
    return result;
  };
}

/** Write tools whose failures and refusals must reach the action log. */
export const WRITE_TOOLS = new Set([
  "gmail_draft", "gmail_update_draft", "gmail_delete_draft",
  "gmail_create_label", "gmail_apply_label", "gmail_remove_label", "gmail_move_to_delete",
  "gmail_trash", "gmail_create_filter", "gmail_delete_filter",
  "calendar_create", "calendar_update", "calendar_flag_delete",
]);

/** Returns a server whose write tools are wrapped with withFailureLog. */
export function withWriteLogging<S extends { tool: (...a: any[]) => any }>(server: S): S {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);
      return (...a: any[]) => {
        const name = a[0];
        const last = a.length - 1;
        if (WRITE_TOOLS.has(name) && typeof a[last] === "function") {
          a[last] = withFailureLog(name, a[last]);
        }
        return target.tool(...a);
      };
    },
  });
}
