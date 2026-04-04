import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthClient } from "./auth.js";
import { logAction } from "./logger.js";

function formatEvent(event: any) {
  return {
    id: event.id,
    title: event.summary || "(no title)",
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
    location: event.location || "",
    description: event.description || "",
    attendees: (event.attendees || []).map((a: any) => ({
      email: a.email,
      name: a.displayName || "",
      status: a.responseStatus || "",
    })),
    videoLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || "",
    status: event.status,
  };
}

export function registerCalendarTools(server: McpServer): void {
  // --- calendar_list ---
  server.tool(
    "calendar_list",
    "List upcoming calendar events.",
    {
      days_ahead: z.number().optional().default(7).describe("Days to look ahead (default 7)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
      account: z.string().optional().describe("Account name (default: primary)"),
    },
    async ({ days_ahead, calendar_id, account }) => {
      const { client } = await getAuthClient(account);
      const calendar = google.calendar({ version: "v3", auth: client });

      const now = new Date();
      const future = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);

      const res = await calendar.events.list({
        calendarId: calendar_id,
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });

      const events = (res.data.items || []).map(formatEvent);
      return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
    }
  );

  // --- calendar_search ---
  server.tool(
    "calendar_search",
    "Search calendar events by keyword.",
    {
      query: z.string().describe("Search keyword"),
      time_min: z.string().optional().describe("Start of range (ISO 8601)"),
      time_max: z.string().optional().describe("End of range (ISO 8601)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ query, time_min, time_max, calendar_id, account }) => {
      const { client } = await getAuthClient(account);
      const calendar = google.calendar({ version: "v3", auth: client });

      const res = await calendar.events.list({
        calendarId: calendar_id,
        q: query,
        timeMin: time_min || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        timeMax: time_max || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });

      const events = (res.data.items || []).map(formatEvent);
      return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
    }
  );

  // --- calendar_get ---
  server.tool(
    "calendar_get",
    "Get full details of a specific calendar event.",
    {
      event_id: z.string().describe("Event ID"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ event_id, calendar_id, account }) => {
      const { client } = await getAuthClient(account);
      const calendar = google.calendar({ version: "v3", auth: client });

      const res = await calendar.events.get({
        calendarId: calendar_id,
        eventId: event_id,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(formatEvent(res.data), null, 2) }] };
    }
  );

  // --- calendar_create ---
  server.tool(
    "calendar_create",
    "Create a calendar event. Does NOT send invites by default.",
    {
      title: z.string().describe("Event title"),
      start: z.string().describe("Start time (ISO 8601, e.g. '2026-04-10T14:00:00-07:00')"),
      end: z.string().describe("End time (ISO 8601)"),
      description: z.string().optional().describe("Event description"),
      location: z.string().optional().describe("Event location"),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      send_invites: z.boolean().optional().default(false).describe("Send invite emails (default: false)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ title, start, end, description, location, attendees, send_invites, calendar_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const cal = google.calendar({ version: "v3", auth: client });

      const res = await cal.events.insert({
        calendarId: calendar_id,
        sendUpdates: send_invites ? "all" : "none",
        requestBody: {
          summary: title,
          start: { dateTime: start },
          end: { dateTime: end },
          description,
          location,
          attendees: attendees?.map((email) => ({ email })),
        },
      });

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "calendar_create",
        account: accountName,
        summary: `Event created: '${title}' at ${start}${send_invites ? " (invites sent)" : " (no invites)"}`,
        ids: [res.data.id || "unknown"],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Event created: "${title}" (ID: ${res.data.id}).${send_invites ? " Invites sent." : " No invites sent."}`,
          },
        ],
      };
    }
  );

  // --- calendar_update ---
  server.tool(
    "calendar_update",
    "Modify an existing calendar event. Does NOT notify attendees by default.",
    {
      event_id: z.string().describe("Event ID to update"),
      title: z.string().optional().describe("New title"),
      start: z.string().optional().describe("New start time (ISO 8601)"),
      end: z.string().optional().describe("New end time (ISO 8601)"),
      description: z.string().optional().describe("New description"),
      location: z.string().optional().describe("New location"),
      send_updates: z.boolean().optional().default(false).describe("Notify attendees (default: false)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ event_id, title, start, end, description, location, send_updates, calendar_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const cal = google.calendar({ version: "v3", auth: client });

      // Fetch current event to merge changes
      const current = await cal.events.get({ calendarId: calendar_id, eventId: event_id });
      const updated: any = { ...current.data };

      if (title !== undefined) updated.summary = title;
      if (start !== undefined) updated.start = { dateTime: start };
      if (end !== undefined) updated.end = { dateTime: end };
      if (description !== undefined) updated.description = description;
      if (location !== undefined) updated.location = location;

      const res = await cal.events.update({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: send_updates ? "all" : "none",
        requestBody: updated,
      });

      const changes = [title && "title", start && "start", end && "end", description && "description", location && "location"]
        .filter(Boolean)
        .join(", ");

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "calendar_update",
        account: accountName,
        summary: `Event updated (${changes}): '${res.data.summary}'`,
        ids: [event_id],
      });

      return {
        content: [{ type: "text" as const, text: `Event updated: "${res.data.summary}" (changed: ${changes})` }],
      };
    }
  );

  // --- calendar_flag_delete ---
  server.tool(
    "calendar_flag_delete",
    "Soft-delete: prepend 'DELETE - ' to event title. Does NOT actually delete the event.",
    {
      event_id: z.string().describe("Event ID to flag"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ event_id, calendar_id, account }) => {
      const { client, accountName } = await getAuthClient(account);
      const cal = google.calendar({ version: "v3", auth: client });

      const current = await cal.events.get({ calendarId: calendar_id, eventId: event_id });
      const originalTitle = current.data.summary || "(no title)";

      if (originalTitle.startsWith("DELETE - ")) {
        return {
          content: [{ type: "text" as const, text: `Event "${originalTitle}" is already flagged for deletion.` }],
        };
      }

      await cal.events.patch({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: "none",
        requestBody: { summary: `DELETE - ${originalTitle}` },
      });

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "calendar_flag_delete",
        account: accountName,
        summary: `Flagged for deletion: '${originalTitle}'`,
        ids: [event_id],
      });

      return {
        content: [
          { type: "text" as const, text: `Event flagged: "DELETE - ${originalTitle}". Review and delete manually in Google Calendar.` },
        ],
      };
    }
  );

  // --- calendar_availability ---
  server.tool(
    "calendar_availability",
    "Check free/busy status for a date or date range.",
    {
      date_start: z.string().describe("Start date/time (ISO 8601)"),
      date_end: z.string().optional().describe("End date/time (ISO 8601, defaults to end of start day)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ date_start, date_end, calendar_id, account }) => {
      const { client } = await getAuthClient(account);
      const cal = google.calendar({ version: "v3", auth: client });

      const startDate = new Date(date_start);
      const endDate = date_end
        ? new Date(date_end)
        : new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59);

      const res = await cal.freebusy.query({
        requestBody: {
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          items: [{ id: calendar_id }],
        },
      });

      const busy = res.data.calendars?.[calendar_id]?.busy || [];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { date_start, date_end: endDate.toISOString(), busy_blocks: busy, total_busy: busy.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
