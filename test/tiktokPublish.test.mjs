import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  TIKTOK_POST_ATTR,
  isTikTokPublishResponseUrl,
  markTikTokPostButton,
  parseTikTokPublishResponse,
  readTikTokPublishUi,
} from "../worker/src/tiktokPublish.ts";

function el(
  tag,
  {
    text = "",
    attrs = {},
    rect = { left: 100, top: 400, width: 220, height: 48 },
    hidden = false,
    disabled = false,
    className = "",
  } = {}
) {
  const node = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    __text: text,
    __attrs: { ...attrs },
    __rect: rect,
    __hidden: hidden,
    disabled,
    className,
    get innerText() {
      return [node.__text, ...node.children.map((child) => child.innerText)].filter(Boolean).join(" ");
    },
    get textContent() {
      return node.innerText;
    },
    getAttribute: (name) => (name in node.__attrs ? node.__attrs[name] : null),
    hasAttribute: (name) => name in node.__attrs,
    setAttribute: (name, value) => {
      node.__attrs[name] = String(value);
    },
    removeAttribute: (name) => {
      delete node.__attrs[name];
    },
    getBoundingClientRect: () => ({
      ...node.__rect,
      right: node.__rect.left + node.__rect.width,
      bottom: node.__rect.top + node.__rect.height,
    }),
  };
  return node;
}

function append(parent, ...children) {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
  return parent;
}

function withDom(body) {
  const html = el("html", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  html.clientWidth = 1280;
  html.clientHeight = 900;
  append(html, body);
  const all = [];
  const walk = (node) => {
    all.push(node);
    for (const child of node.children) walk(child);
  };
  walk(html);
  const document = {
    body,
    documentElement: html,
    querySelectorAll: (selector) => {
      if (selector === 'button, [role="button"]') {
        return all.filter((node) => node.tagName === "BUTTON" || node.__attrs.role === "button");
      }
      const attr = /^\[([^\]=]+)(?:=[^\]]+)?\]$/.exec(selector)?.[1];
      return attr ? all.filter((node) => attr in node.__attrs) : [];
    },
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    getComputedStyle: (node) => ({
      display: node.__hidden ? "none" : "block",
      visibility: node.__hidden ? "hidden" : "visible",
      opacity: node.__hidden ? "0" : "1",
      pointerEvents: node.__hidden ? "none" : "auto",
    }),
  };
  globalThis.document = document;
  globalThis.window = window;
  return { document, window, off: () => (delete globalThis.document, delete globalThis.window) };
}

function find(body, enabledOnly = false) {
  const dom = withDom(body);
  try {
    return markTikTokPostButton([TIKTOK_POST_ATTR, enabledOnly]);
  } finally {
    dom.off();
  }
}

test("prefers Studio's post_video_button over an unrelated Post text button", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const navPost = el("button", { text: "Post", rect: { left: 20, top: 20, width: 90, height: 32 } });
  const submit = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button", "aria-disabled": "false" } });
  append(body, navPost, submit);
  const result = find(body);
  assert.equal(result?.dataE2e, "post_video_button");
  assert.equal(result?.enabled, true);
  assert.equal(submit.__attrs[TIKTOK_POST_ATTR], "1");
  assert.equal(navPost.__attrs[TIKTOK_POST_ATTR], undefined);
});

test("enabled-only wait remains null while the named Studio control is aria-disabled", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const decoy = el("button", { text: "Post" });
  const submit = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button", "aria-disabled": "true" } });
  append(body, decoy, submit);
  const observed = find(body, false);
  assert.equal(observed?.enabled, false);
  assert.equal(observed?.disabledBy, "aria-disabled=true");
  assert.equal(find(body, true), null, "must not fall through to the enabled text decoy");
});

test("enabled-only wait starts succeeding when TikTok flips aria-disabled to false", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const submit = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button", "aria-disabled": "true" } });
  append(body, submit);
  assert.equal(find(body, true), null);
  submit.__attrs["aria-disabled"] = "false";
  const ready = find(body, true);
  assert.equal(ready?.enabled, true);
  assert.equal(submit.__attrs[TIKTOK_POST_ATTR], "1");
});

test("also honors Studio's data-disabled readiness attribute", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const submit = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button", "data-disabled": "true" } });
  append(body, submit);
  assert.equal(find(body, true), null);
  assert.equal(find(body, false)?.disabledBy, "data-disabled=true");
  submit.__attrs["data-disabled"] = "false";
  assert.equal(find(body, true)?.enabled, true);
});

test("retains legacy post_button and exact semantic fallback without broad text matching", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const posts = el("button", { text: "Posts" });
  const legacy = el("button", { text: "Send", attrs: { "data-e2e": "post_button" } });
  append(body, posts, legacy);
  assert.equal(find(body)?.dataE2e, "post_button");

  delete legacy.__attrs["data-e2e"];
  assert.equal(find(body), null, "Posts, Send and other partial labels are not submit controls");
});

test("ignores hidden and off-screen text fallbacks, but can scroll to a named Studio control", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const hidden = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button" }, hidden: true });
  const textFallback = el("button", {
    text: "Post",
    rect: { left: 100, top: 1000, width: 220, height: 48 },
  });
  append(body, hidden, textFallback);
  assert.equal(find(body), null);

  const named = el("button", {
    text: "Post",
    attrs: { "data-e2e": "post_video_button", "aria-disabled": "false" },
    rect: { left: 100, top: 1000, width: 220, height: 48 },
  });
  append(body, named);
  assert.equal(find(body)?.dataE2e, "post_video_button");
});

test("the Post finder is self-contained when Playwright serializes it", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const submit = el("button", { text: "Post", attrs: { "data-e2e": "post_video_button", "aria-disabled": "false" } });
  append(body, submit);
  const dom = withDom(body);
  try {
    const result = vm.runInNewContext(`(${markTikTokPostButton.toString()})(["${TIKTOK_POST_ATTR}", true])`, {
      document: dom.document,
      window: dom.window,
    });
    assert.equal(result?.dataE2e, "post_video_button");
    assert.equal(result?.enabled, true);
  } finally {
    dom.off();
  }
});

test("recognizes current and legacy TikTok publish response endpoints only", () => {
  const publishing = [
    "https://www.tiktok.com/api/v1/item/create/?aid=1988",
    "https://www.tiktok.com/api/post/item_create/",
    "https://www.tiktok.com/web/project/post/create/",
    "https://www.tiktok.com/api/post/publish/",
    "https://www.tiktok.com/api/v1/web/project/post/",
    "https://www.tiktok.com/post/create",
    "https://www.tiktok.com/creation/publish",
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
  ];
  for (const url of publishing) assert.equal(isTikTokPublishResponseUrl(url), true, url);
  assert.equal(isTikTokPublishResponseUrl("https://www.tiktok.com/api/item/detail/?itemId=123"), false);
  assert.equal(isTikTokPublishResponseUrl("https://evil.example/api/v1/item/create"), false);
});

test("extracts a confirmed post ID or a publish rejection from endpoint JSON", () => {
  assert.deepEqual(parseTikTokPublishResponse('{"status_code":0,"item_id":"7491234567890123456"}', 200), {
    ok: true,
    postId: "7491234567890123456",
    liveUrl: "",
    error: "",
  });
  assert.deepEqual(
    parseTikTokPublishResponse('{"status_code":10201,"status_msg":"Video is still processing"}', 200),
    { ok: false, postId: "", liveUrl: "", error: "Video is still processing" }
  );
  assert.equal(parseTikTokPublishResponse('{"code":0,"data":{"status":"success"}}', 200).ok, true);
  assert.equal(parseTikTokPublishResponse('{"code":10001,"msg":"Copyright check failed"}', 200).ok, false);
  assert.equal(parseTikTokPublishResponse("{}", 200).ok, null, "an arbitrary 200 response is not success");
});

test("uses only a new success/failure message or a genuinely changed video URL", () => {
  assert.equal(
    readTikTokPublishUi("Your video has been uploaded", "Your video has been uploaded", "https://www.tiktok.com/upload", "https://www.tiktok.com/upload").ok,
    null,
    "pre-existing upload copy is not submission confirmation"
  );
  assert.equal(
    readTikTokPublishUi("Upload complete", "Upload complete Post published", "https://www.tiktok.com/upload", "https://www.tiktok.com/upload").ok,
    true
  );
  const destination = readTikTokPublishUi(
    "",
    "",
    "https://www.tiktok.com/tiktokstudio/upload",
    "https://www.tiktok.com/@creator/video/7491234567890123456"
  );
  assert.equal(destination.ok, true);
  assert.equal(destination.postId, "7491234567890123456");
  assert.equal(
    readTikTokPublishUi("", "", "https://www.tiktok.com/upload", "https://evil.example/video/7491234567890123456").ok,
    null,
    "a non-TikTok video-shaped redirect is not a destination"
  );
  const contentRedirect = readTikTokPublishUi(
    "Manage posts",
    "Manage posts",
    "https://www.tiktok.com/tiktokstudio/upload",
    "https://www.tiktok.com/tiktokstudio/content"
  );
  assert.equal(contentRedirect.ok, true);
  assert.match(contentRedirect.error, /Studio content/);
  assert.equal(
    readTikTokPublishUi("Manage posts", "Manage posts", "a", "a").ok,
    null,
    "a pre-existing nav label is not success"
  );
  assert.equal(readTikTokPublishUi("", "Upload another video", "a", "a").ok, true);
  assert.equal(readTikTokPublishUi("", "Something went wrong", "a", "a").ok, false);
  const loginBounce = readTikTokPublishUi(
    "",
    "Log in",
    "https://www.tiktok.com/tiktokstudio/upload",
    "https://www.tiktok.com/login/phone-or-email"
  );
  assert.equal(loginBounce.ok, false);
  assert.match(loginBounce.error, /sign-in/);
});
