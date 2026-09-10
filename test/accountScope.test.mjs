import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/accountScope.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function("path", `${js}; return { LEGACY_ACCOUNT_ID, validAccountId, accountScopeKey, accountDataDir, accountProfileDir, accountDeletionPlan, parseAccountDir };`);
const { validAccountId, accountScopeKey, accountDataDir, accountProfileDir, accountDeletionPlan, parseAccountDir } = load(path);

test("account ids accept generated keys and refuse every path traversal shape", () => {
  assert.equal(validAccountId("acct-mk1_ab2"), "acct-mk1_ab2");
  for (const bad of ["", "../other", "a/b", "a.b", "a b", "a".repeat(65)]) {
    assert.equal(validAccountId(bad), null, bad);
  }
});

test("each platform account gets isolated state and profile paths", () => {
  assert.equal(accountScopeKey("tiktok", "acct-1"), "tiktok:acct-1");
  assert.equal(accountDataDir("/data", "tiktok", "acct-1"), path.join("/data", "accounts", "tiktok--acct-1"));
  assert.equal(accountProfileDir("/data", "tiktok", "acct-1"), path.join("/data", "accounts", "tiktok--acct-1", "profile"));
  assert.equal(accountProfileDir("/data", "tiktok", "default"), path.join("/data", "profile-tiktok"));
});

test("only valid persisted account directory names are discovered", () => {
  assert.deepEqual(parseAccountDir("instagram--acct-abc_1"), { platform: "instagram", accountId: "acct-abc_1" });
  assert.equal(parseAccountDir("../../youtube--oops"), null);
  assert.equal(parseAccountDir("unknown--acct-1"), null);
});

test("deletion plans are account-contained and never target the legacy data root", () => {
  const named = accountDeletionPlan("/data", "youtube", "acct-one");
  assert.equal(named.legacy, false);
  assert.equal(named.accountDir, path.join("/data", "accounts", "youtube--acct-one"));
  assert.equal(named.profileDir, path.join(named.accountDir, "profile"));

  const legacy = accountDeletionPlan("/data", "tiktok", "default");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.accountDir, null, "the shared /data root is never an rm target");
  assert.equal(legacy.profileDir, path.join("/data", "profile-tiktok"));
  assert.throws(() => accountDeletionPlan("/data", "youtube", "../instagram"), /Invalid account id/);
  assert.throws(() => accountDeletionPlan("/data", "other", "acct-one"), /Invalid account platform/);
});
