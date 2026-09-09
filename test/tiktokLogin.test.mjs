import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/tiktokLogin.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" });
const { tiktokSignedInPage } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

function detect(url, { selectors = [], body = "" } = {}) {
  const parsed = new URL(url);
  const document = {
    body: { innerText: body },
    querySelector(selector) {
      return selectors.some((needle) => selector.includes(needle)) ? { tagName: "DIV" } : null;
    },
  };
  return vm.runInNewContext(`(${tiktokSignedInPage.toString()})()`, {
    location: { href: parsed.href, pathname: parsed.pathname, search: parsed.search },
    document,
  });
}

test("TikTok's explicit login wall always wins over stale Studio controls", () => {
  assert.equal(
    detect("https://www.tiktok.com/login?redirect_url=%2Ftiktokstudio%2Fcontent", {
      selectors: ['input[type="file"]'],
      body: "Upload another video",
    }),
    false
  );
});

test("consumer account chrome remains positive login evidence", () => {
  assert.equal(
    detect("https://www.tiktok.com/foryou", { selectors: ['data-e2e="profile-icon"'] }),
    true
  );
});

test("the avatar-less TikTok Studio content route stays signed in after publish", () => {
  assert.equal(detect("https://www.tiktok.com/tiktokstudio/content"), true);
});

test("a usable uploader and Studio's post-success copy are positive evidence", () => {
  assert.equal(
    detect("https://www.tiktok.com/tiktokstudio/upload", { selectors: ['data-e2e="post_video_button"'] }),
    true
  );
  assert.equal(
    detect("https://www.tiktok.com/upload", { body: "Your video has been uploaded to TikTok" }),
    true
  );
});

test("an arbitrary upload-looking URL without private controls is not enough", () => {
  assert.equal(detect("https://www.tiktok.com/upload"), false);
  assert.equal(
    detect("https://www.tiktok.com/tiktokstudio/content", { selectors: ['input[type="password"]'] }),
    false
  );
});

test("the page-side TikTok login probe stays self-contained for Playwright", () => {
  assert.doesNotThrow(() => detect("https://www.tiktok.com/tiktokstudio/content"));
});
