import { google, calendar_v3 } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthClient } from "./auth.js";
import { logAction } from "./logger.js";
import { GuardError, assertAttendeesAllowed } from "./guards.js";
import { loadConfig, getAllowedAttendees } from "./config.js";
import { getContactEmails } from "./contacts.js";

function guardErrorResult(err: unknown) {
  if (err instanceof GuardError) {
    return { content: [{ type: "text" as const, text: err.message }], isError: true as const };
  }
  return null;
}

/** Injection points so tests never touch Google. Defaults are the real thing. */
export interface CalendarDeps {
  getAuthClient?: typeof getAuthClient;
  getContactEmails?: (auth: any, cacheKey: string) => Promise<Set<string>>;
  makeCalendar?: (auth: any) => calendar_v3.Calendar;
}

/**
 * Throws GuardError unless the signed-in user OWNS the calendar. An injected
 * agent must not write to calendars shared with the owner by other people.
 * Returns the calendarList entry so callers can learn the owner's address.
 */
async function fetchOwnedCalendarEntry(
  calendar: calendar_v3.Calendar,
  calendarId: string
): Promise<calendar_v3.Schema$CalendarListEntry> {
  const res = await calendar.calendarList.get({ calendarId });
  if (res.data.accessRole !== "owner") {
    throw new GuardError(
      "Writes are only allowed on calendars the owner owns. This calendar is not owned by the owner; use calendar_id primary or ask the owner to make the change in Google Calendar."
    );
  }
  return res.data;
}

export async function assertOwnedCalendar(calendar: calendar_v3.Calendar, calendarId: string): Promise<void> {
  await fetchOwnedCalendarEntry(calendar, calendarId);
}

const CONTACT_LOOKUP_FAILED =
  "Couldn't check the owner's Google Contacts; create the event without guests and tell the owner to add them.";

interface Allowance {
  contacts: Set<string>;
  lookupFailed: boolean;
  allowed: string[];
  ownerEmail: string | null;
}

function isAllowedGuest(email: string, a: Allowance): boolean {
  const e = email.toLowerCase();
  if (a.ownerEmail && e === a.ownerEmail) return true;
  if (a.contacts.has(e)) return true;
  return a.allowed.some((x) => x.toLowerCase() === e);
}

function assertGuestsAllowed(attendees: string[], a: Allowance): void {
  const rest = attendees.filter((x) => !(a.ownerEmail && x.toLowerCase() === a.ownerEmail));
  try {
    assertAttendeesAllowed(rest, [...a.contacts, ...a.allowed]);
  } catch (err) {
    if (!(err instanceof GuardError)) throw err;
    if (a.lookupFailed) throw new GuardError(CONTACT_LOOKUP_FAILED);
    const bad = rest.find((x) => !isAllowedGuest(x, a)) ?? "that address";
    throw new GuardError(
      `Guest ${bad} is not in the owner's Google Contacts or on allowedAttendees. Create the event without that guest and tell the owner to add them in Google Calendar.`
    );
  }
}

const TEXT_EDIT_REFUSED =
  "This event has guests who are not in the owner's Google Contacts or on allowedAttendees, so title, description and location can't be changed here (guests would read the new text). Time changes are fine. Ask the owner to make that edit in Google Calendar.";

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

export function registerCalendarTools(server: McpServer, deps: CalendarDeps = {}): void {
  const authFor = deps.getAuthClient ?? getAuthClient;
  const contactsFor = deps.getContactEmails ?? ((auth: any, key: string) => getContactEmails(auth, key));
  const makeCal = deps.makeCalendar ?? ((auth: any) => google.calendar({ version: "v3", auth }));

  // Fails CLOSED: if the contacts lookup throws (e.g. missing scope), the set is
  // empty and guests pass only via allowedAttendees.
  async function buildAllowance(client: any, accountName: string, ownerEmail: string | null): Promise<Allowance> {
    let contacts = new Set<string>();
    let lookupFailed = false;
    try {
      contacts = await contactsFor(client, accountName);
    } catch {
      lookupFailed = true;
    }
    const config = await loadConfig();
    return { contacts, lookupFailed, allowed: getAllowedAttendees(config), ownerEmail: ownerEmail?.toLowerCase() ?? null };
  }

  // --- calendar_list ---
  server.tool(
    "calendar_list",
    "List upcoming calendar events.",
    {
      days_ahead: z.coerce.number().optional().default(7).describe("Days to look ahead (default 7)"),
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
    "Create a calendar event. Never sends invite emails. Guests must be in the owner's Google Contacts; otherwise create the event without them and tell the owner to add them. Only calendars the owner owns can be written to.",
    {
      title: z.string().describe("Event title"),
      start: z.string().describe("Start time (ISO 8601, e.g. '2026-04-10T14:00:00-07:00')"),
      end: z.string().describe("End time (ISO 8601)"),
      description: z.string().optional().describe("Event description"),
      location: z.string().optional().describe("Event location"),
      attendees: z
        .array(z.string())
        .optional()
        .describe("Guest email addresses. Each must be in the owner's Google Contacts or on allowedAttendees; no invite email is sent"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID (must be a calendar the owner owns)"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ title, start, end, description, location, attendees, calendar_id, account }) => {
      const { client, accountName } = await authFor(account);
      const cal = makeCal(client);

      let ownerCalendarId: string;
      try {
        const entry = await fetchOwnedCalendarEntry(cal, calendar_id);
        ownerCalendarId = calendar_id;
        if (attendees?.length) {
          const allowance = await buildAllowance(client, accountName, entry.primary ? entry.id ?? null : null);
          assertGuestsAllowed(attendees, allowance);
        }
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

      const res = await cal.events.insert({
        calendarId: ownerCalendarId,
        sendUpdates: "none",
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
        summary: `Event created: '${title}' at ${start} (no invites) calendarId=${calendar_id} attendees=${(attendees ?? []).join(",") || "none"}`,
        ids: [res.data.id || "unknown"],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Event created: "${title}" (ID: ${res.data.id}). No invites sent.`,
          },
        ],
      };
    }
  );

  // --- calendar_update ---
  server.tool(
    "calendar_update",
    "Modify an existing calendar event. Never notifies attendees. Guests must be in the owner's Google Contacts. If the event already has a guest who is not, title, description and location can't be changed (ask the owner to edit in Google Calendar); time changes are fine. Only calendars the owner owns can be written to.",
    {
      event_id: z.string().describe("Event ID to update"),
      title: z.string().optional().describe("New title"),
      start: z.string().optional().describe("New start time (ISO 8601)"),
      end: z.string().optional().describe("New end time (ISO 8601)"),
      description: z.string().optional().describe("New description"),
      location: z.string().optional().describe("New location"),
      attendees: z
        .array(z.string())
        .optional()
        .describe("Replace the guest list. Each must be in the owner's Google Contacts or on allowedAttendees; no email is sent"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID (must be a calendar the owner owns)"),
      account: z.string().optional().describe("Account name"),
    },
    async ({ event_id, title, start, end, description, location, attendees, calendar_id, account }) => {
      const { client, accountName } = await authFor(account);
      const cal = makeCal(client);

      let current: calendar_v3.Schema$Event;
      try {
        const entry = await fetchOwnedCalendarEntry(cal, calendar_id);
        const got = await cal.events.get({ calendarId: calendar_id, eventId: event_id });
        current = got.data;

        const allowance = await buildAllowance(client, accountName, entry.primary ? entry.id ?? null : null);
        if (attendees !== undefined) assertGuestsAllowed(attendees, allowance);

        const editsText = title !== undefined || description !== undefined || location !== undefined;
        if (editsText) {
          const hasOutsider = (current.attendees ?? []).some(
            (a) => !a.self && a.email && !isAllowedGuest(a.email, allowance)
          );
          if (hasOutsider) throw new GuardError(TEXT_EDIT_REFUSED);
        }
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

      // Merge changes into the current event
      const updated: any = { ...current };

      if (title !== undefined) updated.summary = title;
      if (start !== undefined) updated.start = { dateTime: start };
      if (end !== undefined) updated.end = { dateTime: end };
      if (description !== undefined) updated.description = description;
      if (location !== undefined) updated.location = location;
      if (attendees !== undefined) {
        const prior = new Map((current.attendees ?? []).map((a) => [String(a.email).toLowerCase(), a]));
        updated.attendees = attendees.map((email) => prior.get(email.toLowerCase()) ?? { email });
      }

      const res = await cal.events.update({
        calendarId: calendar_id,
        eventId: event_id,
        sendUpdates: "none",
        requestBody: updated,
      });

      const changes = [
        title && "title",
        start && "start",
        end && "end",
        description && "description",
        location && "location",
        attendees !== undefined && "attendees",
      ]
        .filter(Boolean)
        .join(", ");

      await logAction({
        timestamp: new Date().toISOString(),
        tool: "calendar_update",
        account: accountName,
        summary: `Event updated (${changes}): '${res.data.summary}' calendarId=${calendar_id} attendees=${attendees ? attendees.join(",") : "unchanged"}`,
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
      const { client, accountName } = await authFor(account);
      const cal = makeCal(client);

      try {
        await assertOwnedCalendar(cal, calendar_id);
      } catch (err) {
        const r = guardErrorResult(err);
        if (r) return r;
        throw err;
      }

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
