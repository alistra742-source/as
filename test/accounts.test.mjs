import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../src/lib/accounts.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function(`${js}; return { accountRoomKey, cleanAccountName, accountNameTaken, roomAuthenticated, roomForAccount };`);
const { accountRoomKey, cleanAccountName, accountNameTaken, roomAuthenticated, roomForAccount } = load();

test("account labels are display-only, compact, and control-character free", () => {
  assert.equal(cleanAccountName("  donut\n\t account  "), "donut account");
  assert.equal(cleanAccountName("x".repeat(80)).length, 32);
  assert.equal(cleanAccountName(" \u0000 "), "");
});

test("duplicate account labels are rejected case-insensitively per platform", () => {
  const accounts = [{ id: "one", name: "Donut", platform: "tiktok", createdAt: 1, lastOpenedAt: null }];
  assert.equal(accountNameTaken(accounts, " donut "), true);
  assert.equal(accountNameTaken(accounts, "second"), false);
});

test("account room keys scope the same id to a platform", () => {
  assert.equal(accountRoomKey("tiktok", "acct-1"), "tiktok:acct-1");
  assert.notEqual(accountRoomKey("youtube", "acct-1"), accountRoomKey("tiktok", "acct-1"));
});

test("a YouTube OAuth grant authenticates only YouTube's destination", () => {
  const base = {
    session: { state: "open" },
    live: { youtubeOAuthConnected: true },
  };
  assert.equal(roomAuthenticated({ ...base, platform: "youtube" }), true);
  assert.equal(roomAuthenticated({ ...base, platform: "tiktok" }), false);
  assert.equal(roomAuthenticated({ ...base, platform: "instagram", session: { state: "logged-in" } }), true);
});

test("an open account room wins over its saved menu snapshot", () => {
  const account = { id: "acct-1", name: "donut", platform: "tiktok", createdAt: 1, lastOpenedAt: null };
  const open = { platform: "tiktok", marker: "open" };
  const old = { platform: "tiktok", marker: "saved" };
  assert.equal(roomForAccount("tiktok", account, "acct-1", open, { "tiktok:acct-1": old }).marker, "open");
  assert.equal(roomForAccount("tiktok", account, null, open, { "tiktok:acct-1": old }).marker, "saved");
});
