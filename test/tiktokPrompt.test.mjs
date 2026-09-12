/**
 * TikTok's upload-editor product tour covers Description, audience and Post.
 * These tests pin the important distinction: click the visible Got it inside the
 * "New editing features added" card, never a same-named control elsewhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { TIKTOK_EDITING_TIP_ATTR, markTikTokEditingTipButton } from "../worker/src/tiktokPrompt.ts";

function el(tag, { text = "", attrs = {}, rect = { left: 0, top: 0, width: 200, height: 40 }, hidden = false, disabled = false } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    __text: text,
    __attrs: { ...attrs },
    __rect: rect,
    __hidden: hidden,
    disabled,
    get innerText() {
      return [node.__text, ...node.children.map((c) => c.innerText)].filter(Boolean).join(" ");
    },
    get textContent() {
      return node.innerText;
    },
    getAttribute: (name) => (name in node.__attrs ? node.__attrs[name] : null),
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

  globalThis.document = {
    body,
    documentElement: html,
    querySelectorAll: (selector) => {
      if (selector === 'button, [role="button"]') {
        return all.filter((node) => node.tagName === "BUTTON" || node.__attrs.role === "button");
      }
      if (selector === "*") return all;
      const attr = /^\[([^\]=]+)(?:=[^\]]+)?\]$/.exec(selector)?.[1];
      return attr ? all.filter((node) => attr in node.__attrs) : [];
    },
  };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 900,
    getComputedStyle: (node) => ({
      display: node.__hidden ? "none" : "block",
      visibility: node.__hidden ? "hidden" : "visible",
      opacity: node.__hidden ? "0" : "1",
      pointerEvents: node.__hidden ? "none" : "auto",
    }),
  };
  return () => {
    delete globalThis.document;
    delete globalThis.window;
  };
}

function editingTip({ hidden = false, semantic = true } = {}) {
  const backdrop = el("div", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const card = el("div", { rect: { left: 450, top: 170, width: 202, height: 254 } });
  const title = el("h3", { text: "New editing features added", rect: { left: 470, top: 298, width: 170, height: 22 } });
  const copy = el("p", { text: "Now it’s easier than ever before to create professional and engaging videos." });
  const button = el(semantic ? "button" : "div", {
    text: "Got it",
    attrs: semantic ? {} : { class: "pink-acknowledgement" },
    rect: { left: 462, top: 385, width: 177, height: 27 },
    hidden,
  });
  append(card, title, copy, button);
  append(backdrop, card);
  return { backdrop, card, title, button };
}

function find(body) {
  const off = withDom(body);
  try {
    return markTikTokEditingTipButton([TIKTOK_EDITING_TIP_ATTR]);
  } finally {
    off();
  }
}

test("marks the visible Got it button in the New editing features card", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const tip = editingTip();
  append(body, tip.backdrop);
  const result = find(body);
  assert.deepEqual(result, { tag: "BUTTON", label: "Got it", width: 177, height: 27 });
  assert.equal(tip.button.__attrs[TIKTOK_EDITING_TIP_ATTR], "1");
});

test("does not click an unrelated exact Got it control", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const ordinaryCard = el("div", { text: "Cookie preferences" });
  const ordinary = el("button", { text: "Got it" });
  append(ordinaryCard, ordinary);
  append(body, ordinaryCard);
  assert.equal(find(body), null);
  assert.equal(ordinary.__attrs[TIKTOK_EDITING_TIP_ATTR], undefined);
});

test("title elsewhere on the page is not enough — it must share the local card", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const heading = el("h2", { text: "New editing features added" });
  const otherPanel = el("section", { text: "Some other setting" });
  const button = el("button", { text: "Got it" });
  append(otherPanel, button);
  append(body, heading, otherPanel);
  assert.equal(find(body), null, "their first shared ancestor is body, which the finder rejects");
});

test("skips a hidden stale copy and marks the visible modal", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const stale = editingTip({ hidden: true });
  const live = editingTip();
  append(body, stale.backdrop, live.backdrop);
  const result = find(body);
  assert.ok(result);
  assert.equal(stale.button.__attrs[TIKTOK_EDITING_TIP_ATTR], undefined);
  assert.equal(live.button.__attrs[TIKTOK_EDITING_TIP_ATTR], "1");
});

test("supports TikTok styling a plain div as the acknowledgement", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const tip = editingTip({ semantic: false });
  append(body, tip.backdrop);
  const result = find(body);
  assert.equal(result?.tag, "DIV");
  assert.equal(tip.button.__attrs[TIKTOK_EDITING_TIP_ATTR], "1");
});

test("the page-side finder is self-contained when Playwright serializes it", () => {
  const body = el("body", { rect: { left: 0, top: 0, width: 1280, height: 900 } });
  const tip = editingTip();
  append(body, tip.backdrop);
  const off = withDom(body);
  try {
    const result = vm.runInNewContext(`(${markTikTokEditingTipButton.toString()})(["${TIKTOK_EDITING_TIP_ATTR}"])`, {
      document: globalThis.document,
      window: globalThis.window,
    });
    assert.equal(result?.label, "Got it");
    assert.equal(tip.button.__attrs[TIKTOK_EDITING_TIP_ATTR], "1");
  } finally {
    off();
  }
});
