import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const browser = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
const panels = fs.readFileSync(new URL("../src/components/panels.tsx", import.meta.url), "utf8");
const engine = fs.readFileSync(new URL("../worker/src/engine.ts", import.meta.url), "utf8");

test("repeated upload-access checks are coalesced and cannot navigate over a publish", () => {
  const exec = browser.slice(browser.indexOf("exec(cmd: RemoteCmd)"), browser.indexOf("private async drain()"));
  assert.match(exec, /cmd\.t === "check-upload" && this\.uploadAccessPending/);
  assert.match(exec, /ignored the repeated request/);
  assert.match(exec, /this\.uploadAccessPending = true/);
  assert.match(exec, /this\.uploadAccessPending = false/);

  const commandDispatch = worker.slice(worker.indexOf('case "cmd":'), worker.indexOf('case "engine":'));
  assert.match(commandDispatch, /msg\.cmd\.t === "check-upload" && \(engine\.snapshot\(\)\.running \|\| engine\.isBusy\(\)\)/);
  assert.match(commandDispatch, /current publish keeps the browser until its receipt/);
});

test("upload probes and publishes freeze stale login detection", () => {
  const check = browser.slice(browser.indexOf('case "check-upload":'), browser.indexOf('case "click-label":'));
  assert.match(check, /this\.driving = true/);
  assert.match(check, /finally[\s\S]*this\.driving = false/);

  const detect = browser.slice(browser.indexOf("async detectLogin()"), browser.indexOf("async withVisibleTab"));
  const firstGuard = detect.indexOf("if (this.driving || this.sessionMutation)");
  const staleGuard = detect.lastIndexOf("if (this.driving || this.sessionMutation)");
  assert.ok(firstGuard >= 0 && staleGuard > firstGuard, "login detection must re-check ownership after its awaited DOM probe");
});

test("socket hibernation cannot close Chromium under a publish or capability probe", () => {
  const closeHandler = worker.slice(worker.indexOf('ws.on("close"'), worker.indexOf('ws.on("error"'));
  assert.match(closeHandler, /rig\.hasActiveWork\(\) \|\| engine\.isBusy\(\)/);
  assert.match(closeHandler, /setTimeout\(hibernateWhenIdle, 30_000\)/);
  assert.ok(
    closeHandler.indexOf("rig.hasActiveWork()") < closeHandler.indexOf("void rig.close()"),
    "browser-local work must be checked before hibernation"
  );
});

test("whole-browser loss relaunches immediately and retries the downloaded upload", () => {
  const recovery = browser.slice(browser.indexOf("async waitForRecovery"), browser.indexOf("async newEnginePage"));
  assert.match(recovery, /while \(!this\.destroyed && this\.recovering/);
  assert.doesNotMatch(recovery, /while \(!this\.destroyed && Date\.now\(\) - t0/);
  assert.match(recovery, /await this\.openControlSession\(\)/);

  const publish = engine.slice(engine.indexOf("private async publishPreparedVideo"), engine.indexOf("manualDiscoverPost"));
  assert.match(publish, /if \(!isTabGone\(err\)\) throw err/);
  assert.match(publish, /await this\.rig\.waitForRecovery\(\)/);
  assert.match(publish, /result = await attempt\(\)/);
  assert.match(publish, /retrying the same file once/i);
});

test("session mutation and upload capability controls are locked during engine/publish work", () => {
  const cookiePanel = panels.slice(panels.indexOf("export function SessionCookiePanel"));
  assert.match(cookiePanel, /disabled=\{!value\.trim\(\) \|\| running \|\| publishing \|\| busy !== null\}/);
  assert.match(cookiePanel, /disabled=\{!installed \|\| !live\.connected \|\| running \|\| publishing \|\| busy !== null\}/);
  assert.match(cookiePanel, /disabled=\{!live\.connected \|\| !loggedIn \|\| running \|\| publishing \|\| busy !== null\}/);
  assert.match(cookiePanel, /loading=\{busy === "check"\}/);
  assert.match(cookiePanel, /if \(busy\) return;[\s\S]*sendBusCmd\(p, accountId, \{ t: "check-upload" \}\)/);
  assert.match(cookiePanel, /setBusy\("check"\)/);
});
