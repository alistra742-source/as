/**
 * Unit test for the caption-field picker — the code that decides where the
 * caption goes, and therefore whether a publish posts with one.
 *
 *   npm test
 *
 * The DOM below is TikTok's upload screen as it exists today: a wide
 * contenteditable under the word "Description", a search box in the header, and
 * an "Add comment" textbox in the side panel. All three are large, visible, and
 * editable-ish, so this is exactly the case a selector list gets wrong — and a
 * wrong guess here does not throw, it just posts a captionless video.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_ATTR,
  CAPTION_SELECTOR,
  collectEditableBoxes,
  pickEditableBox,
  scoreEditableBox,
} from "../worker/src/captionPick.ts";

/* ------------------------------- fake DOM -------------------------------- */

function box(rect, { tag = "DIV", attrs = {}, text = "", children = [], prev = null, disabled = false, editable = false } = {}) {
  const node = {
    tagName: tag,
    isContentEditable: editable,
    parentElement: null,
    previousElementSibling: prev,
    children,
    __attrs: { ...attrs },
    __text: text,
    __disabled: disabled,
    textContent: text,
    getBoundingClientRect: () => ({ ...rect, bottom: rect.top + rect.height, right: rect.left + rect.width }),
    getAttribute: (n) => (n in node.__attrs ? node.__attrs[n] : n === "disabled" && disabled ? "" : null),
    setAttribute: (n, v) => {
      node.__attrs[n] = String(v);
    },
    removeAttribute: (n) => {
      delete node.__attrs[n];
    },
    hasAttribute: (n) => n in node.__attrs || (n === "disabled" && disabled),
    // The picker asks for a labelled-by / a wrapping form field. `closest` here
    // understands only the [class*=…] shape it is actually used with, which is
    // enough to prove the lookup is attempted and cannot throw.
    closest: (sel) => {
      if (!/class\*=/.test(sel)) return null;
      const key = /class\*="([^"]+)"/.exec(sel)?.[1] || "";
      let n = node;
      while (n) {
        if ((n.__attrs.class || "").includes(key)) return n;
        n = n.parentElement;
      }
      return null;
    },
  };
  return node;
}

const VIEWPORT_H = 900;

function withDom(candidates) {
  for (const c of candidates) if (c.parentElement === null) c.parentElement = c.__parent ?? null;
  globalThis.document = {
    querySelectorAll: () => candidates,
    getElementById: (id) => candidates.find((c) => c.__attrs.id === id) ?? null,
  };
  globalThis.window = {
    innerHeight: VIEWPORT_H,
    getComputedStyle: (n) => ({ visibility: n.__hidden ? "hidden" : "visible", display: "block", pointerEvents: "auto" }),
  };
  return () => {
    delete globalThis.document;
    delete globalThis.window;
  };
}

/** Collect through the real page-side function, then score on the Node side. */
function pick(candidates) {
  const off = withDom(candidates);
  try {
    const boxes = collectEditableBoxes([CAPTION_SELECTOR, CANDIDATE_ATTR]);
    const best = pickEditableBox(boxes);
    return { boxes, best };
  } finally {
    off();
  }
}

function tiktokStudio() {
  const search = box({ left: 300, top: 12, width: 320, height: 36 }, { tag: "INPUT", attrs: { "aria-label": "Search", placeholder: "Search", type: "text" } });
  const captionWrap = box({ left: 60, top: 120, width: 560, height: 260 }, { attrs: { class: "outputs-caption-editor" } });
  const caption = box(
    { left: 72, top: 172, width: 536, height: 120 },
    { tag: "DIV", attrs: { role: "textbox", "data-e2e": "unknown-now-what-they-call-it", contenteditable: "true" }, text: "", editable: true }
  );
  caption.parentElement = captionWrap;
  const captionLabel = box({ left: 72, top: 140, width: 200, height: 24 }, { tag: "H3", text: "Description" });
  captionLabel.parentElement = captionWrap;
  captionWrap.children = [captionLabel, caption];
  captionWrap.previousElementSibling = null;
  caption.previousElementSibling = captionLabel;
  const comment = box(
    { left: 660, top: 820, width: 600, height: 48 },
    { tag: "DIV", attrs: { role: "textbox", "aria-label": "Add comment", contenteditable: "true" }, editable: true }
  );
  return { search, captionWrap, caption, captionLabel, comment, all: [search, captionWrap, captionLabel, caption, comment] };
}

/* --------------------------------- tests --------------------------------- */

test("the Description editor wins over the header search box and the comment box", () => {
  const s = tiktokStudio();
  const { best } = pick(s.all);
  assert.ok(best, "one of these three has to be picked, or the publish goes out captionless");
  assert.equal(best.id, s.all.indexOf(s.caption), "the wide contenteditable under the Description heading");
  assert.match(best.label, /Description/, "the label next to it is what identifies it");
});

test("candidates are tagged so the chosen one can be found again by id", () => {
  const s = tiktokStudio();
  const { boxes } = pick(s.all);
  assert.equal(boxes.length, 5, "everything the selector could plausibly mean is collected, including the wrapper");
  for (const b of boxes) {
    const node = s.all[b.id];
    assert.equal(node.__attrs[CANDIDATE_ATTR], String(b.id), `candidate ${b.id} carries its own id in the DOM`);
  }
  assert.ok(s.all.every((n) => n.__attrs[CANDIDATE_ATTR] !== undefined), "every candidate is marked, not just the winner");
});

test("a search box is never mistaken for a caption field", () => {
  const s = tiktokStudio();
  const { boxes } = pick(s.all);
  const search = boxes.find((b) => b.label.includes("Search"));
  assert.ok(search);
  assert.ok(scoreEditableBox(search) <= 0, "labelled Search, so it is disqualified rather than merely outranked");
});

test("the comment box loses even though it is wider", () => {
  const s = tiktokStudio();
  const { boxes, best } = pick(s.all);
  const comment = boxes.find((b) => b.label.includes("Add comment"));
  assert.ok(comment && comment.width > best.width, "the decoy really is the bigger box — size alone is not the answer");
  assert.notEqual(comment.id, best.id);
});

test("a disabled or off-screen field is not chosen", () => {
  const offscreen = box({ left: 60, top: -400, width: 560, height: 120 }, { attrs: { "aria-label": "Description", contenteditable: "true" }, editable: true });
  const disabled = box({ left: 60, top: 200, width: 560, height: 120 }, { attrs: { "aria-label": "Description", contenteditable: "true" }, editable: true, disabled: true });
  assert.equal(pick([offscreen, disabled]).best, null, "neither one is usable, so say so instead of typing into nothing");
});

test("nothing plausible returns null rather than a guess", () => {
  const only = box({ left: 300, top: 12, width: 320, height: 36 }, { tag: "INPUT", attrs: { "aria-label": "Search", type: "text" } });
  assert.equal(pick([only]).best, null);
  assert.equal(pick([]).best, null);
});

test("a plain textarea with a placeholder is enough on its own", () => {
  // Instagram's caption step: one textarea, no fancy attributes.
  const ta = box({ left: 40, top: 200, width: 420, height: 180 }, { tag: "TEXTAREA", attrs: { placeholder: "Caption", name: "alt" } });
  const { best } = pick([ta]);
  assert.ok(best, "a wide textarea saying Caption is the caption field");
  assert.equal(best.id, 0);
});

test("aria-labelledby is followed, because that is how the studio labels it now", () => {
  const heading = box({ left: 60, top: 100, width: 200, height: 24 }, { tag: "LABEL", text: "Add a description", attrs: { id: "desc-label" } });
  const field = box({ left: 60, top: 130, width: 520, height: 100 }, { tag: "DIV", attrs: { contenteditable: "true", "aria-labelledby": "desc-label" }, editable: true });
  const { best } = pick([heading, field]);
  assert.ok(best && best.id === 1, "the label is not a sibling here — only the id reference identifies the box");
  assert.match(best.label, /description/i);
});
