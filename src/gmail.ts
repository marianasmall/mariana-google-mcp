import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "fs";
import * as path from "path";
import { getAuthClient } from "./auth.js";
import { logAction } from "./logger.js";

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

export function registerGmailTools(server: McpServer): void {
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
    "Create a draft email. Does NOT send — the draft appears in Gmail for manual review and sending.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      html: z
        .string()
        .optional()
        .describe(
          "Optional HTML body (tables, bold, links). PREFER this whenever the content has structure — figures, comparisons, per-person breakdowns, lists of accounts — a formatted draft reads better than plain text. Plain text is fine for short conversational notes. When provided it is used instead of the plain-text body, which then serves only as a fallback description."
        ),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
      attachments: z
        .array(z.string())
        .optional()
        .describe("Absolute file paths to attach (PDF, images, docs; 20MB total max)"),
      thread_id: z
        .string()
        .optional()
        .describe(
          "Gmail thread ID to draft a REPLY into an existing conversation (get threadId from gmail_search/gmail_read; keep the same subject prefixed 'Re:'). Omit for a new conversation."
        ),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ to, subject, body, html, cc, bcc, attachments, thread_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const contentType = html
        ? "Content-Type: text/html; charset=utf-8"
        : "Content-Type: text/plain; charset=utf-8";
      const content = html ?? body;
      const baseHeaders = [
        `To: ${to}`,
        `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
      ];

      let rawMessage: string;
      if (attachments && attachments.length > 0) {
        const boundary = `mixed_${Date.now().toString(36)}_mcp`;
        const parts: string[] = [`--${boundary}\r\n${contentType}\r\n\r\n${content}`];
        let totalBytes = 0;
        for (const filePath of attachments) {
          const data = await fs.readFile(filePath);
          totalBytes += data.length;
          if (totalBytes > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachments exceed ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB total`);
          }
          const name = path.basename(filePath);
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mime = ATTACHMENT_MIME_TYPES[ext] || "application/octet-stream";
          const b64 = data.toString("base64").replace(/(.{76})/g, "$1\r\n");
          parts.push(
            `--${boundary}\r\nContent-Type: ${mime}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`
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
          message: { raw: encodedMessage, ...(thread_id ? { threadId: thread_id } : {}) },
        },
      });

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_draft",
        account: accountName,
        summary: `Draft created: '${subject}' to ${to}${attachments?.length ? ` (+${attachments.length} attachment${attachments.length > 1 ? "s" : ""})` : ""}${thread_id ? " (reply in thread)" : ""}`,
        ids: [res.data.id || "unknown"],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Draft created successfully (ID: ${res.data.id}). Review and send from Gmail.`,
          },
        ],
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

  // --- gmail_create_filter ---
  server.tool(
    "gmail_create_filter",
    "Create a Gmail filter rule. Matches messages by criteria and applies actions automatically. At least one criterion and one action required.",
    {
      from: z.string().optional().describe("Match sender (e.g. 'newsletter@example.com')"),
      to: z.string().optional().describe("Match recipient"),
      subject: z.string().optional().describe("Match subject (substring)"),
      query: z.string().optional().describe("Gmail search query for advanced matching"),
      add_label_ids: z.array(z.string()).optional().describe("Label IDs to apply to matching messages"),
      remove_label_ids: z.array(z.string()).optional().describe("Label IDs to remove (e.g. 'INBOX' to archive)"),
      mark_read: z.boolean().optional().describe("Mark matching messages as read"),
      star: z.boolean().optional().describe("Star matching messages"),
      forward: z.string().optional().describe("Email address to forward matching messages to"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ from, to, subject, query, add_label_ids, remove_label_ids, mark_read, star, forward, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const criteria: Record<string, string> = {};
      if (from) criteria.from = from;
      if (to) criteria.to = to;
      if (subject) criteria.subject = subject;
      if (query) criteria.query = query;

      if (Object.keys(criteria).length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: At least one criterion (from, to, subject, query) is required." }],
          isError: true,
        };
      }

      const action: Record<string, any> = {};
      if (add_label_ids) action.addLabelIds = add_label_ids;
      if (remove_label_ids) action.removeLabelIds = remove_label_ids;
      if (mark_read) action.removeLabelIds = [...(action.removeLabelIds || []), "UNREAD"];
      if (star) action.addLabelIds = [...(action.addLabelIds || []), "STARRED"];
      if (forward) action.forward = forward;

      if (Object.keys(action).length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: At least one action (add_label_ids, remove_label_ids, mark_read, star, forward) is required." }],
          isError: true,
        };
      }

      const res = await gmail.users.settings.filters.create({
        userId: "me",
        requestBody: { criteria, action },
      });

      const criteriaDesc = Object.entries(criteria).map(([k, v]) => `${k}:${v}`).join(", ");
      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_create_filter",
        account: accountName,
        summary: `Created filter: ${criteriaDesc} (ID: ${res.data.id})`,
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
            text: `Moved ${moved} message(s) to "To Be Deleted" label. Review in Gmail before permanently deleting.`,
          },
        ],
      };
    }
  );
}
