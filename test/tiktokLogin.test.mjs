import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/tiktokLogin.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" });
const { tiktokLoginEvidencePage, tiktokAccountProbePage } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

function element(extra = {}) {
  return {
    tagName: "DIV",
    hidden: false,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{}];
    },
    ...extra,
  };
}

function detect(url, { selectors = [], body = "", hydration = null, globalData = null } = {}) {
  const parsed = new URL(url);
  const hydrationNode = hydration === null ? null : element({ textContent: JSON.stringify(hydration), innerText: "" });
  const document = {
    body: { innerText: body },
    querySelector(selector) {
      if (selector.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__")) return hydrationNode;
      return selectors.some((needle) => selector.includes(needle)) ? element() : null;
    },
    querySelectorAll(selector) {
      const hit = this.querySelector(selector);
      return hit ? [hit] : [];
    },
  };
  return vm.runInNewContext(`(${tiktokLoginEvidencePage.toString()})()`, {
    location: { href: parsed.href, pathname: parsed.pathname, search: parsed.search, hostname: parsed.hostname },
    document,
    ...(globalData === null ? {} : { window: { "__$UNIVERSAL_DATA$__": globalData } }),
  });
}

test("TikTok's explicit login wall always wins over stale Studio controls", () => {
  assert.equal(
    detect("https://www.tiktok.com/login?redirect_url=%2Ftiktokstudio%2Fcontent", {
      selectors: ['input[type="file"]'],
      body: "Upload another video",
    }).state,
    "signed-out"
  );
});

test("consumer account chrome remains positive login evidence", () => {
  assert.deepEqual(
    { ...detect("https://www.tiktok.com/foryou", { selectors: ['data-e2e="profile-icon"'] }) },
    { state: "signed-in", reason: "account-chrome" }
  );
});

test("TikTok app-context viewer identity works when current chrome has no old data-e2e selector", () => {
  const evidence = detect("https://www.tiktok.com/", {
    hydration: {
      __DEFAULT_SCOPE__: {
        "webapp.app-context": { user: { uid: "1234567890", uniqueId: "private-value-never-returned" } },
      },
    },
  });
  assert.deepEqual({ ...evidence }, { state: "signed-in", reason: "account-context" });
  assert.ok(!JSON.stringify(evidence).includes("private-value"));

  const fromRuntimeGlobal = detect("https://www.tiktok.com/", {
    globalData: { __DEFAULT_SCOPE__: { "webapp.app-context": { user: { secUid: "runtime-private-id" } } } },
  });
  assert.deepEqual({ ...fromRuntimeGlobal }, { state: "signed-in", reason: "account-context" });
  assert.ok(!JSON.stringify(fromRuntimeGlobal).includes("runtime-private"));
});

test("a generic public For You page and anonymous left-nav profile link are not authentication evidence", () => {
  assert.deepEqual(
    {
      ...detect("https://www.tiktok.com/foryou", {
        body: "Videos selected for you",
        selectors: ['data-e2e="nav-profile"'],
      }),
    },
    { state: "unknown", reason: "no-auth-evidence" }
  );
});

test("the avatar-less TikTok Studio content route stays signed in after publish", () => {
  assert.equal(detect("https://www.tiktok.com/tiktokstudio/content").state, "signed-in");
});

test("a usable uploader and Studio's post-success copy are positive evidence", () => {
  assert.equal(
    detect("https://www.tiktok.com/tiktokstudio/upload", { selectors: ['data-e2e="post_video_button"'] }).state,
    "signed-in"
  );
  assert.equal(
    detect("https://www.tiktok.com/upload", { body: "Your video has been uploaded to TikTok" }).state,
    "signed-in"
  );
});

test("an arbitrary upload-looking URL without private controls is not enough", () => {
  assert.equal(detect("https://www.tiktok.com/upload").state, "unknown");
  assert.equal(
    detect("https://www.tiktok.com/tiktokstudio/content", { selectors: ['input[type="password"]'] }).state,
    "signed-out"
  );
});

test("login chrome, conflicting chrome, and verification are distinguishable", () => {
  assert.deepEqual(
    { ...detect("https://www.tiktok.com/", { selectors: ['data-e2e="top-login-button"'] }) },
    { state: "signed-out", reason: "login-control" }
  );
  assert.deepEqual(
    {
      ...detect("https://www.tiktok.com/", {
        selectors: ['data-e2e="top-login-button"', 'data-e2e="profile-icon"'],
      }),
    },
    { state: "unknown", reason: "conflicting-ui" }
  );
  assert.deepEqual(
    { ...detect("https://www.tiktok.com/challenge", { body: "Security verification" }) },
    { state: "challenge", reason: "challenge" }
  );
});

test("the page-side TikTok probes stay self-contained for Playwright", async () => {
  assert.doesNotThrow(() => detect("https://www.tiktok.com/tiktokstudio/content"));

  const result = await vm.runInNewContext(`(${tiktokAccountProbePage.toString()})()`, {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({
      status: 200,
      async json() {
        return { message: "success", data: { user_id: "private-id", username: "private-name" } };
      },
    }),
  });
  assert.deepEqual({ ...result }, { state: "signed-in", httpStatus: 200 });
  assert.ok(!JSON.stringify(result).includes("private"), "account payload escaped the page probe");
});

test("the account probe maps rejection/challenge without returning TikTok's response", async () => {
  async function probe(status, payload) {
    return vm.runInNewContext(`(${tiktokAccountProbePage.toString()})()`, {
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async () => ({ status, async json() { return payload; } }),
    });
  }
  assert.deepEqual(
    { ...(await probe(401, { message: "login required", data: { description: "private server detail" } })) },
    { state: "signed-out", httpStatus: 401 }
  );
  assert.deepEqual(
    { ...(await probe(403, { message: "captcha required", data: { description: "private server detail" } })) },
    { state: "challenge", httpStatus: 403 }
  );
});
