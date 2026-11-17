import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs, constants as fsConstants } from "fs";
import * as path from "path";
import { getAuthClient } from "./auth.js";
import { logAction, withWriteLogging } from "./logger.js";
import * as os from "os";
import { GuardError, assertSafeAddLabels, assertUserLabelId, assertNoCRLF, resolveAttachmentPath, attachmentDeniedMessage } from "./guards.js";
import { sanitizeDraftHtml } from "./htmlGuard.js";
import { loadConfig, getAllowedImageHosts, getAttachmentRoots, getConfigDir, getTokensDir } from "./config.js";

function guardErrorResult(err: unknown) {
  if (err instanceof GuardError) {
    return { content: [{ type: "text" as const, text: err.message }], isError: true as const };
  }
  return null;
}

/**
 * Validate an attachment path, then open it, fstat the handle (must be a
 * regular file) and read from that same handle, so the file cannot be swapped
 * between check and read. Every failure yields the same GuardError message.
 */
export async function readAttachmentGuarded(
  filePath: string,
  roots: string[],
  forbidden: string[],
  remainingBytes: number = MAX_ATTACHMENT_BYTES,
  // Test seam only: runs between path validation and open, to simulate a swap race.
  afterResolve?: (real: string) => Promise<void>
): Promise<Buffer> {
  const real = await resolveAttachmentPath(filePath, roots, forbidden);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (afterResolve) await afterResolve(real);
    // O_NOFOLLOW: a symlink swapped in after validation is refused, not followed.
    // O_NONBLOCK: opening a FIFO must not hang waiting for a writer.
    handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    // A hard link can point a harmless-looking name at a secret's data.
    if (st.nlink > 1) throw new Error("hard-linked file");
    if (st.size > remainingBytes) throw new Error("over the attachment budget");
    // The path must still resolve to the place we validated, and that place
    // must be the very file we hold open.
    if ((await fs.realpath(filePath)) !== real) throw new Error("path moved");
    const onDisk = await fs.stat(real);
    if (onDisk.dev !== st.dev || onDisk.ino !== st.ino) throw new Error("file replaced");
    const data = await handle.readFile();
    if (data.length > remainingBytes) throw new Error("over the attachment budget");
    return data;
  } catch {
    throw new GuardError(attachmentDeniedMessage(roots));
  } finally {
    await handle?.close();
  }
}

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  csv: "text/csv",
  txt: "text/plain",
  html: "text/html",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Threading needs MORE than Gmail's threadId.
//
// threadId files a draft into the right thread in Gmail's own storage, which is
// why a broken reply still LOOKS correct in the sender's mailbox. Every other
// mail client threads on the RFC 5322 headers instead: In-Reply-To and
// References, both carrying the original message's Message-ID. Send without
// them and the recipient sees a brand-new conversation.
//
// Gmail also rejects or detaches a threaded draft whose Subject does not match
// the thread, so the subject is inherited here rather than trusted to the caller.
//
// Fixed 2026-08-21 after replies kept arriving as new conversations.
type ReplyContext = {
  threadId: string;
  messageId: string | null;
  references: string | null;
  subject: string | null;
};

const getReplyContext = async (
  gmail: any,
  replyToMessageId: string
): Promise<ReplyContext> => {
  const original = await gmail.users.messages.get({
    userId: "me",
    id: replyToMessageId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "Message-Id", "References", "Subject"],
  });

  const headers = original.data.payload?.headers ?? [];
  const header = (name: string): string | null =>
    headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

  return {
    threadId: original.data.threadId,
    messageId: header("Message-ID") ?? header("Message-Id"),
    references: header("References"),
    subject: header("Subject"),
  };
};

// References accumulates the whole ancestry, oldest first, so deep threads stay
// linked even for clients that only read that header.
const buildThreadingHeaders = (ctx: ReplyContext): string[] => {
  if (!ctx.messageId) return [];
  // Header values come from the mailbox (attacker-controlled): never let a line break through.
  assertNoCRLF("Message-ID", ctx.messageId);
  assertNoCRLF("References", ctx.references ?? undefined);
  const references = ctx.references
    ? `${ctx.references} ${ctx.messageId}`
    : ctx.messageId;
  return [`In-Reply-To: ${ctx.messageId}`, `References: ${references}`];
};

const replySubject = (original: string | null, provided: string): string => {
  const base = original ?? provided;
  return /^re:/i.test(base) ? base : `Re: ${base}`;
};

// RFC 822 headers carry no charset — non-ASCII values must be RFC 2047
// encoded-words, or Gmail decodes the raw UTF-8 bytes as Latin-1 (mojibake).
// Encoded-words are capped at 75 chars and must not split a character, so
// long values fold into multiple words on header continuation lines.
const encodeHeaderValue = (value: string): string => {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chunks: string[] = [];
  let current = "";
  for (const char of value) {
    if (current && Buffer.byteLength(current + char, "utf8") > 45) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n ");
};

export function registerGmailTools(rawServer: McpServer): void {
  const server = withWriteLogging(rawServer);
  // --- gmail_search ---
  server.tool(
    "gmail_search",
    "Search Gmail messages. Uses Gmail search syntax (e.g. 'from:name subject:topic').",
    {
      query: z.string().describe("Gmail search query"),
      account: z.string().optional().describe("Account name (default: primary)"),
      max_results: z.coerce.number().optional().default(10).describe("Max results (default 10)"),
    },
    async ({ query, account, max_results }) => {
      const { client } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: max_results,
      });

      const messages = res.data.messages || [];
      const summaries = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
          return {
            id: msg.id,
            threadId: detail.data.threadId,
            from: getHeader("From"),
            to: getHeader("To"),
            subject: getHeader("Subject"),
            date: getHeader("Date"),
            snippet: detail.data.snippet || "",
            labels: detail.data.labelIds || [],
          };
        })
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(summaries, null, 2) }] };
    }
  );

  // --- gmail_read ---
  server.tool(
    "gmail_read",
    "Read a specific Gmail message by ID. Returns full message content.",
    {
      message_id: z.string().describe("Gmail message ID"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ message_id, account }) => {
      const { client } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const res = await gmail.users.messages.get({
        userId: "me",
        id: message_id,
        format: "full",
      });

      const headers = res.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

      // Extract body text
      let bodyText = "";
      const extractText = (part: any): void => {
        if (part.mimeType === "text/plain" && part.body?.data) {
          bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.parts) part.parts.forEach(extractText);
      };
      if (res.data.payload) extractText(res.data.payload);

      // Extract attachment names
      const attachments: string[] = [];
      const extractAttachments = (part: any): void => {
        if (part.filename && part.filename.length > 0) {
          attachments.push(part.filename);
        }
        if (part.parts) part.parts.forEach(extractAttachments);
      };
      if (res.data.payload) extractAttachments(res.data.payload);

      const message = {
        id: res.data.id,
        threadId: res.data.threadId,
        from: getHeader("From"),
        to: getHeader("To"),
        cc: getHeader("Cc"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        body: bodyText,
        attachments,
        labels: res.data.labelIds || [],
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(message, null, 2) }] };
    }
  );

  // --- gmail_list_labels ---
  server.tool(
    "gmail_list_labels",
    "List all Gmail labels/folders for an account.",
    {
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ account }) => {
      const { client } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        messagesTotal: l.messagesTotal,
        messagesUnread: l.messagesUnread,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(labels, null, 2) }] };
    }
  );

  // --- gmail_draft ---
  server.tool(
    "gmail_draft",
    "Create a draft email. Does NOT send — the draft appears in Gmail for manual review and sending. REPLYING: if the user said 'reply to' / 'write back to' / 'follow up on' an existing email, you MUST pass reply_to_message_id (get it from gmail_search or gmail_read). Omitting it silently creates a NEW conversation that arrives detached from the thread — the result text tells you which happened, so check it.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      html: z
        .string()
        .optional()
        .describe(
          "Optional HTML body (tables, bold, links). PREFER this whenever the content has structure — figures, comparisons, per-person breakdowns, lists of accounts — a formatted draft reads better than plain text. Plain text is fine for short conversational notes. When provided it is used instead of the plain-text body, which then serves only as a fallback description. Basic formatting only: p, div, span, b/i/u, headings, lists, tables, <a href> (http/https/mailto/tel), inline style for color/font/spacing/borders, images only cid:, base64 data:image or allowedImageHosts. No <style>, scripts, forms or CSS url()."
        ),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
      attachments: z
        .array(z.string())
        .optional()
        .describe(
          "Absolute file paths to attach (PDF, images, docs; 20MB total max). Files must be inside an allowed folder: by default ~/Projects, ~/Documents, ~/Downloads, ~/Desktop, ~/Library/CloudStorage (configurable via attachmentRoots in config.json). Hidden folders and credential folders are refused."
        ),
      reply_to_message_id: z
        .string()
        .optional()
        .describe(
          "PREFERRED way to reply. Message ID of the email being replied to (from gmail_search/gmail_read). Sets the thread, the In-Reply-To and References headers, and inherits the thread's subject — everything real threading needs. Use this rather than thread_id whenever you have a message in hand."
        ),
      thread_id: z
        .string()
        .optional()
        .describe(
          "Lower-level alternative to reply_to_message_id. Gmail thread ID only: it files the draft into the thread in YOUR mailbox but sets no RFC threading headers, so recipients may still see a new conversation. Prefer reply_to_message_id."
        ),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ to, subject, body, html, cc, bcc, attachments, reply_to_message_id, thread_id, account }) => {
      // Guards run before any network or auth work.
      const loaded: { filePath: string; data: Buffer }[] = [];
      // Only the re-serialized output of the allowlist validator is ever sent, never `html` itself.
      let safeHtml: string | undefined;
      try {
        assertNoCRLF("to", to);
        assertNoCRLF("cc", cc);
        assertNoCRLF("bcc", bcc);
        const config = await loadConfig();
        if (html) safeHtml = sanitizeDraftHtml(html, { allowedImageHosts: getAllowedImageHosts(config) });
        if (attachments && attachments.length > 0) {
          const roots = getAttachmentRoots(config);
          const forbidden = [
            getConfigDir(),
            getTokensDir(),
            path.join(os.homedir(), ".claude"),
            path.join(os.homedir(), ".ssh"),
          ];
          let totalBytes = 0;
          for (const filePath of attachments) {
            const data = await readAttachmentGuarded(filePath, roots, forbidden, MAX_ATTACHMENT_BYTES - totalBytes);
            totalBytes += data.length;
            loaded.push({ filePath, data });
          }
        }
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      // Resolve reply context first: it can override both the thread and the
      // subject, and Gmail detaches a threaded draft whose subject disagrees.
      let replyCtx: ReplyContext | null = null;
      if (reply_to_message_id) {
        replyCtx = await getReplyContext(gmail, reply_to_message_id);
        try {
          // Threading headers come from the mailbox; a line break there would inject headers.
          buildThreadingHeaders(replyCtx);
        } catch (err) {
          const r = guardErrorResult(err);
          if (r) return r;
          throw err;
        }
      }
      const effectiveThreadId = replyCtx?.threadId ?? thread_id;
      const effectiveSubject = replyCtx ? replySubject(replyCtx.subject, subject) : subject;

      const contentType = safeHtml
        ? "Content-Type: text/html; charset=utf-8"
        : "Content-Type: text/plain; charset=utf-8";
      const content = safeHtml ?? body;
      const baseHeaders = [
        `To: ${to}`,
        `Subject: ${encodeHeaderValue(effectiveSubject)}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        ...(replyCtx ? buildThreadingHeaders(replyCtx) : []),
      ];

      let rawMessage: string;
      if (loaded.length > 0) {
        const boundary = `mixed_${Date.now().toString(36)}_mcp`;
        const parts: string[] = [`--${boundary}\r\n${contentType}\r\n\r\n${content}`];
        for (const { filePath, data } of loaded) {
          const name =
            path.basename(filePath).replace(/[\r\n"\\]/g, "_").trim() || "attachment";
          // Same header-charset problem as Subject: quoted filename params must
          // stay ASCII; the original name travels via RFC 2231 filename*.
          const asciiName = name.replace(/[^\x20-\x7e]/g, "_");
          const extendedName =
            name === asciiName ? "" : `; filename*=UTF-8''${encodeURIComponent(name)}`;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mime = ATTACHMENT_MIME_TYPES[ext] || "application/octet-stream";
          const b64 = data.toString("base64").replace(/(.{76})/g, "$1\r\n");
          parts.push(
            `--${boundary}\r\nContent-Type: ${mime}; name="${asciiName}"\r\nContent-Disposition: attachment; filename="${asciiName}"${extendedName}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`
          );
        }
        rawMessage = [
          ...baseHeaders,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          "",
          parts.join("\r\n"),
          `--${boundary}--`,
        ].join("\r\n");
      } else {
        rawMessage = [...baseHeaders, contentType, "", content].join("\r\n");
      }

      const encodedMessage = Buffer.from(rawMessage)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: encodedMessage,
            ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
          },
        },
      });

      // Say plainly which of the two things happened. The old failure mode was
      // silent: a reply drafted without threading info looked identical in the
      // result, and only the recipient ever found out.
      let threadingNote: string;
      if (replyCtx) {
        threadingNote = replyCtx.messageId
          ? `Threaded REPLY (thread ${replyCtx.threadId}, In-Reply-To set).`
          : `Filed into thread ${replyCtx.threadId}, but the original carried no Message-ID header, so RFC threading headers could not be set — recipients may see a new conversation.`;
      } else if (effectiveThreadId) {
        threadingNote = `Filed into thread ${effectiveThreadId} via thread_id only — no RFC threading headers, so recipients may see a NEW conversation. Pass reply_to_message_id for a real reply.`;
      } else {
        threadingNote = `NEW conversation (not a reply). If this was meant to reply to something, recreate it with reply_to_message_id.`;
      }

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_draft",
        account: accountName,
        summary: `Draft created: '${effectiveSubject}' to ${to}${cc ? ` cc ${cc}` : ""}${bcc ? ` bcc ${bcc}` : ""}${attachments?.length ? ` (+${attachments.length} attachment${attachments.length > 1 ? "s" : ""})` : ""}${replyCtx ? " (threaded reply)" : effectiveThreadId ? " (thread_id only)" : ""}`,
        ids: [res.data.id || "unknown"],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Draft created (ID: ${res.data.id}). ${threadingNote} Review and send from Gmail.`,
          },
        ],
      };
    }
  );

  // --- gmail_list_drafts ---
  server.tool(
    "gmail_list_drafts",
    "List current Gmail drafts with their IDs, subjects and recipients. Use this to find the draft ID needed by gmail_update_draft and gmail_delete_draft.",
    {
      max_results: z.number().optional().describe("How many drafts to return (default 20)"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ max_results, account }) => {
      const { client } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const list = await gmail.users.drafts.list({
        userId: "me",
        maxResults: max_results ?? 20,
      });
      const drafts = list.data.drafts ?? [];
      if (drafts.length === 0) {
        return { content: [{ type: "text" as const, text: "No drafts." }] };
      }

      const rows: string[] = [];
      for (const d of drafts) {
        const full = await gmail.users.drafts.get({
          userId: "me",
          id: d.id!,
          format: "metadata",
        });
        const headers = full.data.message?.payload?.headers ?? [];
        const header = (n: string) =>
          headers.find((h: any) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
        rows.push(
          `${d.id}  |  ${header("Subject") || "(no subject)"}  |  to: ${header("To") || "(none)"}  |  thread: ${full.data.message?.threadId ?? "-"}`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `${rows.length} draft(s):\n\n${rows.join("\n")}`,
          },
        ],
      };
    }
  );

  // --- gmail_update_draft ---
  server.tool(
    "gmail_update_draft",
    "Revise an existing Gmail draft in place, instead of creating a second one. Only the fields you pass change; everything else (recipients, subject, and crucially the thread it belongs to) is carried forward. Get the draft ID from gmail_list_drafts.",
    {
      draft_id: z.string().describe("Draft ID (from gmail_list_drafts)"),
      to: z.string().optional().describe("New recipient(s). Omit to keep the existing ones."),
      subject: z.string().optional().describe("New subject. Omit to keep the existing one."),
      body: z.string().optional().describe("New plain-text body. Omit to keep the existing content."),
      html: z.string().optional().describe("New HTML body. Takes precedence over body, same as gmail_draft."),
      cc: z.string().optional().describe("New CC. Omit to keep existing."),
      bcc: z.string().optional().describe("New BCC. Omit to keep existing."),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ draft_id, to, subject, body, html, cc, bcc, account }) => {
      // Only the re-serialized output of the allowlist validator is ever sent, never `html` itself.
      let safeHtml: string | undefined;
      try {
        assertNoCRLF("to", to);
        assertNoCRLF("cc", cc);
        assertNoCRLF("bcc", bcc);
        if (html) safeHtml = sanitizeDraftHtml(html, { allowedImageHosts: getAllowedImageHosts(await loadConfig()) });
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      // Gmail's drafts.update REPLACES the whole message rather than patching it.
      // Anything not resupplied is destroyed — including the threading headers,
      // which is how "editing a reply" silently turns it into a new conversation.
      // So: read everything first, then rebuild with the caller's overrides on top.
      const existing = await gmail.users.drafts.get({
        userId: "me",
        id: draft_id,
        format: "full",
      });
      const msg = existing.data.message;
      const headers = msg?.payload?.headers ?? [];
      const header = (n: string): string =>
        headers.find((h: any) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const keptThreadId = msg?.threadId;
      const inReplyTo = header("In-Reply-To");
      const references = header("References");

      const finalTo = to ?? header("To");
      const finalSubject = subject ?? header("Subject");
      const finalCc = cc ?? header("Cc");
      const finalBcc = bcc ?? header("Bcc");
      // Inherited header values can also carry line breaks; check the final values.
      try {
        assertNoCRLF("to", finalTo);
        assertNoCRLF("cc", finalCc);
        assertNoCRLF("bcc", finalBcc);
        assertNoCRLF("In-Reply-To", inReplyTo);
        assertNoCRLF("References", references);
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

      let finalContent: string;
      let isHtml: boolean;
      if (safeHtml) {
        finalContent = safeHtml;
        isHtml = true;
      } else if (body) {
        finalContent = body;
        isHtml = false;
      } else {
        // Neither supplied: keep whatever the draft already had.
        const findPart = (p: any, mime: string): any => {
          if (!p) return null;
          if (p.mimeType === mime && p.body?.data) return p;
          for (const sub of p.parts ?? []) {
            const hit = findPart(sub, mime);
            if (hit) return hit;
          }
          return null;
        };
        const htmlPart = findPart(msg?.payload, "text/html");
        const textPart = findPart(msg?.payload, "text/plain");
        const chosen = htmlPart ?? textPart ?? msg?.payload;
        isHtml = Boolean(htmlPart);
        finalContent = chosen?.body?.data
          ? Buffer.from(chosen.body.data, "base64").toString("utf8")
          : "";
      }

      const rawMessage = [
        `To: ${finalTo}`,
        `Subject: ${encodeHeaderValue(finalSubject)}`,
        ...(finalCc ? [`Cc: ${finalCc}`] : []),
        ...(finalBcc ? [`Bcc: ${finalBcc}`] : []),
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
        ...(references ? [`References: ${references}`] : []),
        isHtml
          ? "Content-Type: text/html; charset=utf-8"
          : "Content-Type: text/plain; charset=utf-8",
        "",
        finalContent,
      ].join("\r\n");

      const encodedMessage = Buffer.from(rawMessage)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      await gmail.users.drafts.update({
        userId: "me",
        id: draft_id,
        requestBody: {
          message: {
            raw: encodedMessage,
            ...(keptThreadId ? { threadId: keptThreadId } : {}),
          },
        },
      });

      const threadingNote = inReplyTo
        ? "Threading preserved (In-Reply-To and References carried forward)."
        : keptThreadId
          ? `Kept in thread ${keptThreadId}.`
          : "Standalone draft, no thread to preserve.";

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_update_draft",
        account: accountName,
        summary: `Draft updated: '${finalSubject}'${inReplyTo ? " (threading preserved)" : ""}`,
        ids: [draft_id],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Draft ${draft_id} updated in place. ${threadingNote} No second draft created.`,
          },
        ],
      };
    }
  );

  // --- gmail_delete_draft ---
  server.tool(
    "gmail_delete_draft",
    "Delete a Gmail draft by moving it to Trash (recoverable for 30 days; the user empties Trash). Get the draft ID from gmail_list_drafts.",
    {
      draft_id: z.string().describe("Draft ID (from gmail_list_drafts)"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ draft_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      // Read it first so the log records WHAT was removed, not just an opaque id.
      const existing = await gmail.users.drafts.get({
        userId: "me",
        id: draft_id,
        format: "metadata",
      });
      const headers = existing.data.message?.payload?.headers ?? [];
      const subject =
        headers.find((h: any) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
      const messageId = existing.data.message?.id;

      // Trashing the underlying message removes it from Drafts while leaving it
      // restorable, which the drafts.delete endpoint cannot do.
      if (!messageId) throw new Error("Draft has no message id; cannot move it to Trash.");
      await gmail.users.messages.trash({ userId: "me", id: messageId });
      const outcome = "moved to Trash (restorable for 30 days)";

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_delete_draft",
        account: accountName,
        summary: `Draft ${outcome}: '${subject}'`,
        ids: [draft_id],
      });

      return {
        content: [{ type: "text" as const, text: `Draft '${subject}' ${outcome}.` }],
      };
    }
  );

  // --- gmail_create_label ---
  server.tool(
    "gmail_create_label",
    "Create a new Gmail label. Returns the label ID for use with other label tools.",
    {
      name: z.string().describe("Label name (use '/' for nesting, e.g. 'Clients/Acme')"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ name, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const res = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_create_label",
        account: accountName,
        summary: `Created label: "${name}" (ID: ${res.data.id})`,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: res.data.id, name: res.data.name, type: res.data.type }, null, 2),
          },
        ],
      };
    }
  );

  // --- gmail_apply_label ---
  server.tool(
    "gmail_apply_label",
    "Apply a label to one or more Gmail messages. Use gmail_list_labels to find label IDs.",
    {
      message_ids: z.array(z.string()).describe("Array of Gmail message IDs"),
      label_id: z.string().describe("Label ID to apply (from gmail_list_labels or gmail_create_label)"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ message_ids, label_id, account }) => {
      try {
        assertSafeAddLabels([label_id]);
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      let applied = 0;
      for (const msgId of message_ids) {
        await gmail.users.messages.modify({
          userId: "me",
          id: msgId,
          requestBody: { addLabelIds: [label_id] },
        });
        applied++;
      }

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_apply_label",
        account: accountName,
        summary: `Applied label ${label_id} to ${applied} message(s)`,
        ids: message_ids,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Applied label to ${applied} message(s).`,
          },
        ],
      };
    }
  );

  // --- gmail_remove_label ---
  server.tool(
    "gmail_remove_label",
    "Remove a label from one or more Gmail messages. Use gmail_list_labels to find label IDs.",
    {
      message_ids: z.array(z.string()).describe("Array of Gmail message IDs"),
      label_id: z.string().describe("Label ID to remove"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ message_ids, label_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      let removed = 0;
      for (const msgId of message_ids) {
        await gmail.users.messages.modify({
          userId: "me",
          id: msgId,
          requestBody: { removeLabelIds: [label_id] },
        });
        removed++;
      }

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_remove_label",
        account: accountName,
        summary: `Removed label ${label_id} from ${removed} message(s)`,
        ids: message_ids,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Removed label from ${removed} message(s).`,
          },
        ],
      };
    }
  );

  // --- gmail_list_filters ---
  server.tool(
    "gmail_list_filters",
    "List the Gmail filters on an account (criteria and actions). Read-only.",
    {
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ account }) => {
      const { client } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });
      const res = await gmail.users.settings.filters.list({ userId: "me" });
      const filters = (res.data.filter || []).map((f) => ({ id: f.id, criteria: f.criteria, action: f.action }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: filters.length, filters }, null, 2) }],
      };
    }
  );

  // --- gmail_create_filter (safe actions only) ---
  // Deliberately narrow: no forward, archive, mark-read, delete, trash, or label
  // removal. A filter keeps running after the session, so it may only make mail
  // MORE visible (star, label, important, never spam), never hide or send it.
  server.tool(
    "gmail_create_filter",
    "Create a Gmail filter that makes matching mail MORE visible: star it, apply one of your own labels, mark it important, and/or keep it out of spam. It cannot forward, archive, mark read, trash or delete. Applies to NEW mail only; use gmail_search + gmail_apply_label for existing messages. At least one criterion and one action required.",
    {
      from: z.string().optional().describe("Match sender, e.g. 'thersegroup.com' or 'name@example.com'"),
      to: z.string().optional().describe("Match recipient"),
      subject: z.string().optional().describe("Match subject (substring)"),
      query: z.string().optional().describe("Gmail search query for advanced matching"),
      label_id: z.string().optional().describe("One of your own label IDs (Label_...), from gmail_list_labels"),
      star: z.boolean().optional().describe("Star matching messages"),
      mark_important: z.boolean().optional().describe("Mark matching messages important"),
      never_spam: z.boolean().optional().describe("Never send matching messages to Spam"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ from, to, subject, query, label_id, star, mark_important, never_spam, account }) => {
      const criteria: Record<string, string> = {};
      const addLabelIds: string[] = [];
      const removeLabelIds: string[] = [];
      try {
        for (const [k, v] of Object.entries({ from, to, subject, query })) {
          assertNoCRLF(k, v);
          if (v && v.trim()) criteria[k] = v.trim();
        }
        if (label_id) {
          assertUserLabelId(label_id);
          addLabelIds.push(label_id);
        }
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }
      if (star) addLabelIds.push("STARRED");
      if (mark_important) addLabelIds.push("IMPORTANT");
      if (never_spam) removeLabelIds.push("SPAM");

      if (Object.keys(criteria).length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: At least one criterion (from, to, subject, query) is required." }],
          isError: true,
        };
      }
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: At least one action (label_id, star, mark_important, never_spam) is required." }],
          isError: true,
        };
      }

      const action: Record<string, string[]> = {};
      if (addLabelIds.length) action.addLabelIds = addLabelIds;
      if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;

      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });
      const res = await gmail.users.settings.filters.create({
        userId: "me",
        requestBody: { criteria, action },
      });

      const criteriaDesc = Object.entries(criteria).map(([k, v]) => `${k}:${v}`).join(", ");
      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_create_filter",
        account: accountName,
        summary: `Created filter ${res.data.id}: ${criteriaDesc} -> add [${addLabelIds.join(",")}] remove [${removeLabelIds.join(",")}]`,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: res.data.id, criteria: res.data.criteria, action: res.data.action }, null, 2),
          },
        ],
      };
    }
  );

  // --- gmail_move_to_delete ---
  server.tool(
    "gmail_move_to_delete",
    "Soft-delete: move messages to a 'To Be Deleted' label. Does NOT delete or trash messages.",
    {
      message_ids: z.array(z.string()).describe("Array of Gmail message IDs to move"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ message_ids, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      // Ensure "To Be Deleted" label exists
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      let deleteLabel = (labelsRes.data.labels || []).find(
        (l) => l.name === "To Be Deleted"
      );

      if (!deleteLabel) {
        const created = await gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name: "To Be Deleted",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        });
        deleteLabel = created.data;
      }

      // Move each message
      let moved = 0;
      for (const msgId of message_ids) {
        await gmail.users.messages.modify({
          userId: "me",
          id: msgId,
          requestBody: { addLabelIds: [deleteLabel.id!] },
        });
        moved++;
      }

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_move_to_delete",
        account: accountName,
        summary: `Moved ${moved} message(s) to "To Be Deleted"`,
        ids: message_ids,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Moved ${moved} message(s) to "To Be Deleted" label. Review in Gmail before deleting them yourself.`,
          },
        ],
      };
    }
  );
}
