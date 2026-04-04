import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthClient } from "./auth.js";
import { logAction } from "./logger.js";

export function registerGmailTools(server: McpServer): void {
  // --- gmail_search ---
  server.tool(
    "gmail_search",
    "Search Gmail messages. Uses Gmail search syntax (e.g. 'from:name subject:topic').",
    {
      query: z.string().describe("Gmail search query"),
      account: z.string().optional().describe("Account name (default: primary)"),
      max_results: z.number().optional().default(10).describe("Max results (default 10)"),
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
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ to, subject, body, cc, bcc, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const gmail = google.gmail({ version: "v1", auth: client });

      const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\r\n");

      const encodedMessage = Buffer.from(headers)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: encodedMessage } },
      });

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "gmail_draft",
        account: accountName,
        summary: `Draft created: '${subject}' to ${to}`,
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
