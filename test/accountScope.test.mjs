import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/accountScope.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function("path", `${js}; return { LEGACY_ACCOUNT_ID, validAccountId, accountScopeKey, accountDataDir, accountProfileDir, parseAccountDir };`);
const { validAccountId, accountScopeKey, accountDataDir, accountProfileDir, parseAccountDir } = load(path);

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
