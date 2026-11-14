import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Isolate config BEFORE any src module that touches config is imported.
const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "config-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;

const { addAccount, loadConfig, hashEmail } = await import("./config.js");
const { GuardError } = await import("./guards.js");

test("addAccount saves a new name", async () => {
  const cfg = await addAccount("primary", "a@example.com");
  assert.equal(cfg.accounts["primary"].emailHash, hashEmail("a@example.com"));
  const reloaded = await loadConfig();
  assert.equal(reloaded.accounts["primary"].emailHash, hashEmail("a@example.com"));
});

test("addAccount with same name and same email succeeds (re-auth)", async () => {
  await addAccount("primary", "a@example.com");
  const cfg = await addAccount("primary", "a@example.com");
  assert.equal(cfg.accounts["primary"].emailHash, hashEmail("a@example.com"));
});

test("addAccount with same name and different email throws and does not re-bind", async () => {
  await addAccount("primary", "a@example.com");
  await assert.rejects(
    () => addAccount("primary", "b@example.com"),
    (err: unknown) => {
      assert.ok(err instanceof GuardError);
      assert.match(err.message, /already bound to a different Google account/);
      assert.match(err.message, /new name/);
      assert.doesNotMatch(err.message, /example\.com/);
      return true;
    }
  );
  const reloaded = await loadConfig();
  assert.equal(reloaded.accounts["primary"].emailHash, hashEmail("a@example.com"));
});
