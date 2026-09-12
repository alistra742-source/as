import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const browser = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
const start = browser.indexOf("async applySessionCookie(raw:");
const end = browser.indexOf("async clearSessionCookies()", start);
const apply = browser.slice(start, end);

function at(needle) {
  const index = apply.indexOf(needle);
  assert.notEqual(index, -1, `missing cookie-install step: ${needle}`);
  return index;
}

test("cookie import waits for the visible profile, blanks network activity, clears collisions, writes, then verifies", () => {
  assert.ok(at("await this.openControlSession()") < at('page.goto("about:blank"'));
  assert.ok(at('page.goto("about:blank"') < at("ctx.clearCookies({ name })"));
  assert.ok(at("ctx.clearCookies({ name })") < at("ctx.addCookies("));
  assert.ok(at("ctx.addCookies(") < at("cookieJarVerdict(await ctx.cookies(), plan, true)"));
  assert.ok(at("cookieJarVerdict(await ctx.cookies(), plan, true)") < at("page.goto(postCookieUrl(this.platform)"));
});

test("a replacement session fails closed and cannot inherit the old green login bit", () => {
  assert.ok(at("this.store.setLoggedIn(this.platform, false)") < at("ctx.addCookies("));
  assert.match(apply, /this\.sessionMutation = true/);
  assert.match(apply, /if \(wasLoggedIn\) this\.broadcast\(\{ type: "login", loggedIn: false \}\)/);
  assert.match(apply, /written\.exact !== written\.expected/);
});

test("TikTok import uses authenticated page/API evidence and keeps diagnostics secret-safe", () => {
  assert.match(browser, /https:\/\/www\.tiktok\.com\/profile/);
  assert.match(apply, /page\.evaluate\(tiktokLoginEvidencePage\)/);
  assert.match(apply, /page\.evaluate\(tiktokAccountProbePage\)/);
  assert.match(apply, /privateRouteRejected/);

  const catchBlock = apply.slice(apply.lastIndexOf("} catch {"));
  assert.doesNotMatch(catchBlock, /\.message|String\(.*(?:error|err|exception)/i);
  assert.match(catchBlock, /Never surface the raw Playwright exception/);
  assert.match(apply, /jar=\$\{retained\.scoped\}\/\$\{retained\.expected\}/);
});
