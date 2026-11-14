import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthClient } from "./auth.js";

const CONTACT_CACHE_MS = 10 * 60 * 1000;
const contactCache = new Map<string, { at: number; emails: Set<string> }>();

export function clearContactEmailCache(): void {
  contactCache.clear();
}

/**
 * Every email address in the owner's saved Google Contacts ("My Contacts"),
 * lowercased. Cached in memory for 10 minutes per `cacheKey` (use the account
 * name) so one account's contacts are never reused for another.
 * Deliberately NEVER reads otherContacts: Gmail adds anyone who emails the
 * owner there, so a stranger could add themselves.
 */
export async function getContactEmails(
  auth: any,
  cacheKey = "default",
  peopleApi?: any
): Promise<Set<string>> {
  const hit = contactCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CONTACT_CACHE_MS) return hit.emails;

  const people = peopleApi ?? google.people({ version: "v1", auth });
  const emails = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res: any = await people.people.connections.list({
      resourceName: "people/me",
      pageSize: 1000,
      personFields: "emailAddresses",
      pageToken,
    });
    for (const p of res.data.connections || []) {
      for (const e of p.emailAddresses || []) {
        if (e.value) emails.add(String(e.value).toLowerCase());
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  contactCache.set(cacheKey, { at: Date.now(), emails });
  return emails;
}

function formatContact(person: any) {
  return {
    name: person.names?.[0]?.displayName || "(no name)",
    emails: (person.emailAddresses || []).map((e: any) => e.value),
    phones: (person.phoneNumbers || []).map((p: any) => p.value),
    organization: person.organizations?.[0]?.name || "",
    title: person.organizations?.[0]?.title || "",
    notes: person.biographies?.[0]?.value || "",
  };
}

export function registerContactsTools(server: McpServer): void {
  // --- contacts_search ---
  server.tool(
    "contacts_search",
    "Search Google Contacts by name, email, or phone number.",
    {
      query: z.string().describe("Search query (name, email, or phone)"),
      account: z.string().optional().describe("Account name (default: primary)"),
      max_results: z.coerce.number().optional().default(10).describe("Max results (default 10)"),
    },
    async ({ query, account, max_results }) => {
      const { client } = await getAuthClient(account);
      const people = google.people({ version: "v1", auth: client });

      const res = await people.people.searchContacts({
        query,
        pageSize: max_results,
        readMask: "names,emailAddresses,phoneNumbers,organizations,biographies",
      });

      const contacts = (res.data.results || [])
        .filter((r: any) => r.person)
        .map((r: any) => formatContact(r.person));

      return { content: [{ type: "text" as const, text: JSON.stringify(contacts, null, 2) }] };
    }
  );

  // --- contacts_list ---
  server.tool(
    "contacts_list",
    "List Google Contacts, optionally filtered by contact group.",
    {
      group: z.string().optional().describe("Contact group name to filter by"),
      account: z.string().optional().describe("Account name (default: primary)"),
      max_results: z.coerce.number().optional().default(25).describe("Max results (default 25)"),
    },
    async ({ group, account, max_results }) => {
      const { client } = await getAuthClient(account);
      const people = google.people({ version: "v1", auth: client });

      const res = await people.people.connections.list({
        resourceName: "people/me",
        pageSize: max_results,
        personFields: "names,emailAddresses,phoneNumbers,organizations,biographies",
        sortOrder: "LAST_NAME_ASCENDING",
      });

      let contacts = (res.data.connections || []).map(formatContact);

      if (group) {
        // Filter by group would require listing groups first — for now, filter by org name
        const lowerGroup = group.toLowerCase();
        contacts = contacts.filter(
          (c) =>
            c.organization.toLowerCase().includes(lowerGroup) ||
            c.name.toLowerCase().includes(lowerGroup)
        );
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(contacts, null, 2) }] };
    }
  );
}
