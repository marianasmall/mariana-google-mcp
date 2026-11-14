import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { getContactEmails, clearContactEmailCache } = await import("./contacts.js");

function fakePeople(pages: any[][]) {
  let calls = 0;
  const reqs: any[] = [];
  return {
    api: {
      people: {
        connections: {
          list: async (p: any) => {
            reqs.push(p);
            const i = calls++;
            return {
              data: {
                connections: pages[i].map((e) => ({ emailAddresses: [{ value: e }] })),
                nextPageToken: i < pages.length - 1 ? `t${i + 1}` : undefined,
              },
            };
          },
        },
      },
    } as any,
    count: () => calls,
    reqs,
  };
}

test("getContactEmails pages through connections, lowercases, caches per key", async () => {
  clearContactEmailCache();
  const f = fakePeople([["A@Example.com"], ["b@example.com"]]);
  const s1 = await getContactEmails({} as any, "acct1", f.api);
  assert.deepEqual([...s1].sort(), ["a@example.com", "b@example.com"]);
  assert.equal(f.reqs[0].pageSize, 1000);
  assert.equal(f.reqs[0].personFields, "emailAddresses");
  await getContactEmails({} as any, "acct1", f.api);
  assert.equal(f.count(), 2, "second call served from cache");

  const g = fakePeople([["c@example.com"]]);
  const s2 = await getContactEmails({} as any, "acct2", g.api);
  assert.deepEqual([...s2], ["c@example.com"], "other account is not served acct1's set");
});
