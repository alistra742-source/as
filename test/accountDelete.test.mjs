import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const worker = fs.readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
const deck = fs.readFileSync(new URL("../src/state/deck.ts", import.meta.url), "utf8");
const menu = fs.readFileSync(new URL("../src/components/AccountMenu.tsx", import.meta.url), "utf8");
const store = fs.readFileSync(new URL("../worker/src/store.ts", import.meta.url), "utf8");
const oauth = fs.readFileSync(new URL("../worker/src/youtubeOAuth.ts", import.meta.url), "utf8");

test("account deletion API is authenticated and validates the full scope", () => {
  const route = worker.slice(worker.indexOf('url.pathname === "/api/accounts/delete"'), worker.indexOf('url.pathname === "/callback"'));
  assert.match(route, /authorizedHttp\(req\)/);
  assert.match(route, /PLATFORMS\.includes/);
  assert.match(route, /validAccountId/);
  assert.match(route, /deleteAccount\(platform, accountId\)/);
  assert.match(route, /deleted: \{ platform, accountId \}/);
});

test("runtime teardown precedes scoped disk deletion and busy publishes are not torn down", () => {
  const body = worker.slice(worker.indexOf("async function performAccountDeletion"), worker.indexOf("function deleteAccount("));
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `missing ${needle}`);
    return index;
  };
  assert.ok(at("engine.stop()") < at("engine.isBusy()"));
  assert.ok(at("engine.isBusy()") < at("runtime.rig.destroy()"));
  assert.ok(at("runtime.rig.destroy()") < at("closeAccountTorProxy"));
  assert.ok(at("closeAccountTorProxy") < at("fsp.rm(plan.accountDir"));
  assert.doesNotMatch(body, /fsp\.rm\(env\.dataDir/);
  assert.match(body, /legacyStore\.resetPlatform\(platform\)/);
  assert.match(body, /fsp\.rm\(plan\.profileDir/);
});

test("terminal Rig deletion rejects queued input and cannot relaunch the profile", () => {
  const browser = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
  const destroy = browser.slice(browser.indexOf("async destroy()"), browser.indexOf("async close()", browser.indexOf("async destroy()")));
  assert.match(destroy, /this\.destroyed = true/);
  assert.match(destroy, /this\.cmdQueue\.splice\(0\)/);
  assert.match(destroy, /await this\.inputTail/);
  assert.match(browser, /if \(this\.destroyed\) throw new Error\("This account runtime was deleted"\)/);
});

test("legacy state reset changes one platform and is synchronously persisted", () => {
  const body = store.slice(store.indexOf("resetPlatform("), store.indexOf("rig(p:", store.indexOf("resetPlatform(")));
  assert.match(body, /this\.data\.rigs\[p\] = blankRig\(\)/);
  assert.match(body, /this\.data\.posts\[p\] = \[\]/);
  assert.match(body, /this\.data\.engines\[p\] = freshEngine\(\)/);
  assert.match(body, /clearTimeout\(this\.saveTimer\)/);
  assert.match(body, /renameSync/);
});

test("legacy reset really preserves the other two platform records on disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viraldeck-delete-"));
  try {
    const stripped = stripTypeScriptTypes(store, { mode: "strip" })
      .replace(/^import[^;]+;\s*/gm, "")
      .replace(/export /g, "");
    const Store = new Function(
      "fs",
      "path",
      "accountDataDir",
      "LEGACY_ACCOUNT_ID",
      "env",
      `${stripped}; return Store;`
    )(
      fs,
      path,
      (dataRoot, platform, accountId) => accountId === "default" ? dataRoot : path.join(dataRoot, "accounts", `${platform}--${accountId}`),
      "default",
      { dataDir: root }
    );
    const state = new Store();
    state.data.rigs.tiktok.loggedIn = true;
    state.data.posts.tiktok = [{ id: "remove" }];
    state.data.engines.tiktok.running = true;
    state.data.rigs.instagram.loggedIn = true;
    state.data.posts.instagram = [{ id: "keep" }];
    state.data.engines.youtube.message = "keep-youtube";
    state.save();
    state.resetPlatform("tiktok");

    const persisted = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
    assert.equal(persisted.rigs.tiktok.loggedIn, false);
    assert.deepEqual(persisted.posts.tiktok, []);
    assert.equal(persisted.engines.tiktok.running, false);
    assert.equal(persisted.rigs.instagram.loggedIn, true);
    assert.equal(persisted.posts.instagram[0].id, "keep");
    assert.equal(persisted.engines.youtube.message, "keep-youtube");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("YouTube destructive cleanup invalidates pending callbacks and removes credentials", () => {
  const body = oauth.slice(oauth.indexOf("export async function purgeYouTubeOAuthAccount"));
  assert.match(body, /accountGenerations\.set/);
  assert.match(body, /marker\.accountId === accountId/);
  assert.match(body, /disconnectYouTubeOAuth\(accountId\)/);
  assert.match(oauth, /accountGenerations\.get\(payload\.accountId\).*generation/s);
});

test("the UI requires confirmation and removes local state only after exact server acknowledgement", () => {
  assert.match(menu, /role="alertdialog"/);
  assert.match(menu, /Delete account/);
  assert.match(menu, /This cannot be undone/);
  assert.match(menu, /deleteAccount\(platform, confirming\.id\)/);

  const action = deck.slice(deck.indexOf("deleteAccount: async"), deck.indexOf("selectAccount:", deck.indexOf("deleteAccount: async")));
  const ack = action.indexOf("result.deleted?.accountId !== accountId");
  const remove = action.indexOf("withoutAccount(");
  assert.ok(ack >= 0 && remove > ack, "client state removal must follow scope-matching worker acknowledgement");
  assert.match(action, /authorization: `Bearer \$\{token\}`/);
});
