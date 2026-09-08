/**
 * Unit test for the page-side tap logic, run against a hand-built fake DOM — no
 * browser needed, so it runs anywhere:
 *
 *   npm test
 *
 * The DOM below mirrors what the deck actually has to survive: TikTok's
 * "verify it's really you" list (plain <div> rows with cursor:pointer and the
 * handler on the parent of the label span), rows separated by a hairline gap,
 * and a click-anywhere backdrop that must never be mistaken for a target.
 */
import test from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import {
  CONTAINER_VIEWPORT_RATIO,
  INTERACTIVE_SEL,
  MAX_NUDGE_PX,
  TARGET_ATTR,
  activateMarked,
  activityProbe,
  findLabelTarget,
  tapAim,
  tapProbe,
} from "../worker/src/tapAim.ts";

const VIEWPORT = { w: 1280, h: 900 };

/* ------------------------------- fake DOM -------------------------------- */

function el(tag, rect, { cursor = "auto", attrs = {}, text = "", id = "" } = {}) {
  const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.right - rect.left, height: rect.bottom - rect.top };
  const node = {
    tagName: tag.toUpperCase(),
    id,
    innerText: text,
    textContent: text,
    isContentEditable: false,
    parentElement: null,
    __cursor: cursor,
    __attrs: attrs,
    getBoundingClientRect: () => box,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => {
      attrs[n] = v;
    },
    removeAttribute: (n) => {
      delete attrs[n];
    },
    hasAttribute: (n) => n in attrs,
    __events: [],
    dispatchEvent(ev) {
      this.__events.push(ev);
      return true;
    },
    closest(sel) {
      const tag = sel.replace(/\[.*$/, "").toLowerCase();
      let n = this;
      while (n) {
        if (n.tagName?.toLowerCase() === tag && (!sel.includes("[") || n.getAttribute(sel.match(/\[(\w+)/)[1]) !== null)) return n;
        n = n.parentElement;
      }
      return null;
    },
    getClientRects: () => (box.width >= 1 && box.height >= 1 ? [box] : []),
    scrollIntoView: () => {},
    getRootNode: () => ({}),
    matches(sel) {
      return sel
        .split(",")
        .map((s) => s.trim())
        .some((part) =>
          part.startsWith("[")
            ? (() => {
                const [name, value] = part.slice(1, -1).split("=");
                const v = attrs[name];
                return value ? v === value.replace(/"/g, "") : v !== undefined && v !== null;
              })()
            : part.toLowerCase() === tag.toLowerCase()
        );
    },
  };
  return node;
}

/** A document whose elementFromPoint is driven by a list of boxes (last wins). */
function domFor(nodes, { activeElement = null, scrollY = 0 } = {}) {
  const hit = (x, y) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const r = nodes[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return nodes[i];
    }
    return null;
  };
  return {
    document: {
      elementFromPoint: hit,
      activeElement,
      documentElement: { clientWidth: VIEWPORT.w, clientHeight: VIEWPORT.h },
      // findLabelTarget walks the DOM the way a person scans a screen.
      body: { querySelectorAll: () => nodes, innerText: "" },
      title: "TikTok",
      // `activateMarked` looks up the node the finder marked.
      querySelector: (sel) => {
        const m = /^\[(\w[-\w]*)\]$/.exec(sel || "");
        if (!m) return null;
        return nodes.find((n) => n.__attrs?.[m[1]] !== undefined && n.__attrs[m[1]] !== null) ?? null;
      },
    },
    window: {
      getComputedStyle: (n) => ({ cursor: n?.__cursor ?? "auto" }),
      innerWidth: VIEWPORT.w,
      innerHeight: VIEWPORT.h,
      scrollY,
    },
  };
}

function withDom(nodes, opts) {
  const dom = domFor(nodes, opts);
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  return () => {
    delete globalThis.document;
    delete globalThis.window;
  };
}

const aim = (x, y) => tapAim([x, y, INTERACTIVE_SEL, MAX_NUDGE_PX, CONTAINER_VIEWPORT_RATIO]);

/** The modal, as TikTok renders it. */
function verifyModal() {
  const backdrop = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h }, { attrs: { onclick: "close()" } });
  const card = el("div", { left: 200, top: 150, right: 700, bottom: 470 });
  const title = el("h2", { left: 230, top: 180, right: 500, bottom: 215 }, { text: "Verify it's really you" });
  const email = el("div", { left: 220, top: 260, right: 680, bottom: 322 }, { cursor: "pointer", text: "Email a***2@gmail.com" });
  const emailIcon = el("span", { left: 236, top: 280, right: 256, bottom: 300 });
  const password = el("div", { left: 220, top: 330, right: 680, bottom: 392 }, { cursor: "pointer", text: "Password" });
  const pwLabel = el("span", { left: 270, top: 345, right: 360, bottom: 375 }, { text: "Password" });
  const hairline = el("div", { left: 220, top: 322, right: 680, bottom: 330 });
  const next = el("button", { left: 220, top: 410, right: 680, bottom: 452 }, { text: "Next" });
  email.parentElement = card;
  emailIcon.parentElement = email;
  password.parentElement = card;
  pwLabel.parentElement = password;
  hairline.parentElement = card;
  next.parentElement = card;
  title.parentElement = card;
  card.parentElement = backdrop;
  backdrop.parentElement = null;
  return { backdrop, card, title, email, emailIcon, password, pwLabel, hairline, next, all: [backdrop, card, title, email, emailIcon, password, pwLabel, hairline, next] };
}

/* --------------------------------- tests --------------------------------- */

test("a press already on the row is never moved", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    assert.equal(aim(400, 360), null, "dead centre of Password: nothing to fix");
    assert.equal(aim(300, 355), null, "on the row's own <span> label: the press already reaches the handler");
    assert.equal(aim(230, 430), null, "on a real <button>: untouched");
  } finally { off(); }
});

test("a press in the hairline gap between two rows is clamped onto a row", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    // 4px into an 8px gap, with a clickable backdrop under the whole page: the
    // point belongs to neither row, so it must end up on one of their edges —
    // never on the gap, and never on the backdrop.
    const a = aim(400, 326);
    assert.ok(a, "a press in the gap clicks nothing unless it is pulled onto a row");
    assert.ok(a.y === 320 || a.y === 332, `equidistant point picks one of the two edges, got ${a.y}`);
    assert.equal(a.x, 400, "the horizontal aim is preserved");
    // 2px closer to Email: Email wins, because it is the nearer control.
    const b = aim(400, 324);
    assert.ok(b && b.y === 320, "the nearer row is the one that gets the press");
    assert.ok(Math.abs(b.dy) <= MAX_NUDGE_PX, "and never further than the assist radius");
  } finally { off(); }
});

test("a press just below the Password row is pulled back onto it", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    const a = aim(400, 397); // 5px under the row, above the Next button
    assert.ok(a);
    assert.equal(a.y, 390);
    assert.match(a.label, /Password/);
  } finally { off(); }
});

test("a viewport-filling container is never mistaken for the target", () => {
  const box = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h }, { attrs: { onclick: "dismiss()" } });
  const off = withDom([box]);
  try {
    assert.equal(aim(900, 700), null, "tapping the backdrop to dismiss the modal stays a tap on the backdrop");
    const tiny = el("a", { left: 900 - 20, top: 700 - 40, right: 900 - 4, bottom: 700 - 24 }, { text: "far link" });
    tiny.parentElement = box;
    assert.equal(aim(900, 700), null, `further away than ${MAX_NUDGE_PX}px is a deliberate miss, not a near-miss`);
  } finally { off(); }
});

test("nothing found at all leaves the press exactly where it was aimed", () => {
  const feed = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h }, { text: "feed" });
  const off = withDom([feed]);
  try {
    assert.equal(aim(600, 400), null);
    assert.equal(aim(-40, -40), null, "off-window point: no crash, no nudge");
    assert.equal(tapProbe([600, 400, INTERACTIVE_SEL, TARGET_ATTR]).interactive, false, "a press on a plain node is the log line that explains a dead click");
  } finally { off(); }
});

test("zero-size controls and display:none rows are not nudged onto", () => {
  const hidden = el("div", { left: 0, top: 0, right: 400, bottom: 40 }, { cursor: "pointer", text: "hidden row" });
  const ghost = el("div", { left: 0, top: 0, right: 0, bottom: 0 }, { cursor: "pointer" });
  const off = withDom([hidden, ghost]);
  try {
    assert.equal(aim(200, 60), null, "a control with no box of its own is not something to land on");
  } finally { off(); }
});

test("the walk-up crosses a shadow boundary to find the host control", () => {
  const host = el("div", { left: 100, top: 300, right: 300, bottom: 350 }, { cursor: "pointer", text: "Use a passkey" });
  const inner = el("span", { left: 100, top: 352, right: 300, bottom: 400 });
  inner.getRootNode = () => ({ host });
  const off = withDom([host, inner]);
  try {
    const a = aim(150, 356); // on a node inside the shadow tree, 6px under the host row
    assert.ok(a, "the handler lives on the host, so the host is what has to be pressed");
    assert.equal(a.y, 348);
  } finally { off(); }
});

test("the report says whether the press landed on a control at all", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    const onRow = tapProbe([400, 360, INTERACTIVE_SEL, TARGET_ATTR]);
    const onPadding = tapProbe([660, 240, INTERACTIVE_SEL, TARGET_ATTR]); // card padding, inside the click-anywhere backdrop
    assert.equal(onRow.interactive, true);
    assert.match(onRow.under, /div "Password"/);
    // `interactive` is deliberately generous: a clickable *ancestor* counts, so
    // tapping a modal backdrop to dismiss it is not reported as a dead click.
    assert.equal(onPadding.interactive, true, "an ancestor with a handler still receives the press");
  } finally { off(); }
});

test("the report raises the device keyboard only for real fields", () => {
  const input = el("input", { left: 220, top: 400, right: 680, bottom: 440 }, { attrs: { placeholder: "Password" } });
  const off = withDom([input], { activeElement: input, scrollY: 120 });
  try {
    const r = tapProbe([300, 420, INTERACTIVE_SEL, TARGET_ATTR]);
    assert.equal(r.onField, true);
    assert.equal(r.focused, 'input "Password"', "the focused field is named by its placeholder, not left blank");
    assert.equal(r.scrollY, 120, "scroll offset is reported so a mid-press page move shows up in the log");
  } finally { off(); }
});

test("the container filter is a viewport ratio, not a guess about a specific site", () => {
  const maxArea = VIEWPORT.w * VIEWPORT.h * CONTAINER_VIEWPORT_RATIO;
  const wide = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: 300 }, { cursor: "pointer" }); // a real full-width bar
  assert.ok(wide.getBoundingClientRect().width * wide.getBoundingClientRect().height < maxArea, "a full-width bar must still count as a control");
  const page = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h }, { cursor: "pointer" });
  assert.ok(page.getBoundingClientRect().width * page.getBoundingClientRect().height > maxArea, "the page itself must not");
});

test("the serialized source is self-contained: it runs in a bare realm", () => {
  // Playwright stringifies these functions and evaluates them IN THE PAGE, where
  // this module does not exist. A reference to any module-scope constant would
  // therefore be a silent ReferenceError swallowed by the `.catch(() => null)`
  // — the assist would do nothing forever and the tests above would still pass,
  // because they import the module. So run the exact string that gets sent.
  const m = verifyModal();
  const dom = domFor(m.all);
  const ctx = { document: dom.document, window: dom.window };
  const args = JSON.stringify([400, 326, INTERACTIVE_SEL, MAX_NUDGE_PX, CONTAINER_VIEWPORT_RATIO]);
  const nudged = vm.runInNewContext(`(${tapAim.toString()})(${args})`, ctx);
  assert.ok(nudged && (nudged.y === 320 || nudged.y === 332), "aim assist works from its serialized form");
  const report = vm.runInNewContext(`(${tapProbe.toString()})(${JSON.stringify([400, 360, INTERACTIVE_SEL])})`, ctx);
  assert.equal(report.interactive, true, "the report works from its serialized form");
  assert.throws(() => vm.runInNewContext(`(${tapAim.toString()})(${args})`, { window: dom.window }), "…and really does need only document + window");
});

/* ------------------------- find-by-label (auto-tap) ------------------------ */

// The point of the label path is that no coordinate ever leaves the deck: the
// page is asked where "Email" is and the press goes to the middle of its answer.
test("the Email row is found by its text, and the press targets the whole row", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    const t = findLabelTarget(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(t, "the modal's first row says 'Email a***2@gmail.com'");
    assert.ok(t.clickable, "it climbed from the label onto the row that owns the handler");
    // The Email row is 220..680 x 260..322 in the fixture.
    assert.deepEqual([t.x, t.y, t.w, t.h], [450, 291, 460, 62]);
    assert.match(t.label, /email/);
  } finally { off(); }
});

test("the Password row is found too, and the two never collide", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    const t = findLabelTarget(["Password", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(t);
    assert.equal(t.y, 361, "the Password row's centre, not Email's");
    assert.equal(t.x, 450);
  } finally { off(); }
});

test("a match is only ever the smallest element that says it", () => {
  // <body> "contains" every label on the page; pressing the middle of the body
  // would be worse than not pressing at all.
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    // The <h2> heading (230..500 x 180..215): matched by its own text, and NOT
    // climbed onto the card around it — the card's centre is nowhere near it.
    const t = findLabelTarget(["Verify it's really you", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.deepEqual([t.x, t.y], [365, 197.5]);
    assert.equal(findLabelTarget(["totally absent option", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]), null);
  } finally { off(); }
});

test("icon-only controls are matched by their accessible name", () => {
  const card = el("div", { left: 100, top: 100, right: 700, bottom: 700 });
  const close = el("svg", { left: 640, top: 120, right: 672, bottom: 152 }, { attrs: { "aria-label": "Close" } });
  close.setAttribute?.("aria-label", "Close");
  close.parentElement = card;
  const off = withDom([card, close]);
  try {
    const t = findLabelTarget(["Close", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(t, "a control with no text still has a name, and the deck offers Close-style taps too");
    assert.deepEqual([t.x, t.y], [656, 136]);
  } finally { off(); }
});

test("it will not climb into a viewport-filling container", () => {
  const backdrop = el("div", { left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h }, { attrs: { onclick: "dismiss()" } });
  const text = el("p", { left: 200, top: 200, right: 300, bottom: 224 }, { text: "Email" });
  text.parentElement = backdrop;
  const off = withDom([backdrop, text]);
  try {
    const t = findLabelTarget(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(t);
    assert.equal(t.clickable, false, "stays on the label: the backdrop is the page, not the button");
    assert.deepEqual([t.x, t.y], [250, 212]);
  } finally { off(); }
});

test("it scrolls the control into view before answering", () => {
  const m = verifyModal();
  let scrolled = 0;
  m.password.scrollIntoView = () => {
    scrolled += 1;
  };
  const off = withDom(m.all);
  try {
    findLabelTarget(["Password", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.equal(scrolled, 1, "a row below the fold is useless until it is on screen");
  } finally { off(); }
});

test("hidden and zero-size matches are skipped", () => {
  const hidden = el("div", { left: 0, top: 0, right: 400, bottom: 40 }, { cursor: "pointer", text: "Email" });
  hidden.getClientRects = () => []; // display:none
  const off = withDom([hidden]);
  try {
    assert.equal(findLabelTarget(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]), null);
  } finally { off(); }
});

test("the label path is self-contained too — it is stringified into the page", () => {
  const m = verifyModal();
  const dom = domFor(m.all);
  const args = JSON.stringify(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
  const out = vm.runInNewContext(`(${findLabelTarget.toString()})(${args})`, {
    document: dom.document,
    window: { ...dom.window, innerWidth: VIEWPORT.w, innerHeight: VIEWPORT.h },
  });
  assert.ok(out && out.y === 291, "runs with only document + window in scope, exactly as Playwright sends it");
});

/* --------------- the DOM-side escalation (press ignored → click node) --------------- */

/** Minimal Event constructors: `activateMarked` reads them off `globalThis`. */
class FakeUIEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

/** Records what the page-side probe installed, so the test can "mutate" the DOM. */
const observers = [];
class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.active = true;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.active = false;
  }
  fire(n) {
    if (this.active) this.cb(Array.from({ length: n }, () => ({})));
  }
}

// activityProbe needs a MutationObserver for the whole file; tests that care about
// PointerEvent/MouseEvent still install and remove those around themselves.
globalThis.MutationObserver = FakeMutationObserver;

function withUIEvents(fn) {
  globalThis.MouseEvent = FakeUIEvent;
  globalThis.PointerEvent = FakeUIEvent;
  globalThis.MutationObserver = FakeMutationObserver;
  return async () => {
    try {
      return await fn();
    } finally {
      delete globalThis.MouseEvent;
      delete globalThis.PointerEvent;
      // MutationObserver stays for the whole file: activityProbe needs it too.
    }
  };
}

test("the report marks the control it found, for the fallback to use", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    const onRow = tapProbe([400, 360, INTERACTIVE_SEL, TARGET_ATTR]);
    assert.equal(onRow.marked, true, "a press on a real control can be escalated");
    assert.ok(m.password.hasAttribute(TARGET_ATTR), "the row itself carries the mark, not the label span");
    const dead = tapProbe([210, 240, INTERACTIVE_SEL, TARGET_ATTR]); // card padding, inside the backdrop
    assert.ok(dead.marked, "an ancestor with a handler is still a markable target");
  } finally {
    off();
  }
});

test("the label finder marks its answer and never leaves a stale mark", () => {
  const m = verifyModal();
  const off = withDom(m.all);
  try {
    findLabelTarget(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(m.email.hasAttribute(TARGET_ATTR));
    findLabelTarget(["Password", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    assert.ok(m.password.hasAttribute(TARGET_ATTR));
    assert.equal(m.email.hasAttribute(TARGET_ATTR), false, "exactly one marked node at a time");
  } finally {
    off();
  }
});

test("activation fires a full pointer + mouse sequence on the node itself", async () => {
  const m = verifyModal();
  const off = withDom(m.all);
  const done = withUIEvents(() => {
    findLabelTarget(["Password", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    const r = activateMarked([TARGET_ATTR]);
    assert.ok(r);
    assert.equal(r.tag, "div");
    assert.match(r.label, /password/i);
    assert.deepEqual(
      m.password.__events.map((e) => e.type),
      ["pointerover", "pointerenter", "pointerdown", "mouseover", "mousedown", "pointerup", "mouseout", "mouseup", "click"],
      "down and up on the same node, in order, or a framework will not call it a click"
    );
    assert.equal(m.password.__events.every((e) => e.bubbles && e.cancelable && e.composed), true, "must reach the delegated listener above it");
    assert.equal(m.password.__events.at(-1).buttons, 0, "a release must not report a held button");
    assert.equal(m.password.hasAttribute(TARGET_ATTR), false, "the mark is spent");
    return r;
  });
  try {
    await done();
  } finally {
    off();
  }
});

test("activation degrades to mouse events when the engine has no PointerEvent", async () => {
  const m = verifyModal();
  const off = withDom(m.all);
  const done = withUIEvents(() => {
    findLabelTarget(["Password", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR]);
    delete globalThis.PointerEvent; // an engine that predates it, or a stripped realm
    const r = activateMarked([TARGET_ATTR]);
    assert.ok(r);
    assert.deepEqual(m.password.__events.map((e) => e.type), ["mouseover", "mousedown", "mouseout", "mouseup", "click"]);
    assert.equal(r.events, 5, "every mouse event that engine has, and nothing it does not");
    globalThis.PointerEvent = FakeUIEvent;
    return r;
  });
  try {
    await done();
  } finally {
    off();
  }
});

test("an anchor in the chain is reported, so the caller can navigate if that fails too", async () => {
  const link = el("a", { left: 100, top: 100, right: 300, bottom: 140 }, { attrs: { href: "/login/email" }, text: "Email" });
  // A real <a> exposes the RESOLVED url as a property, which is what the caller
  // needs to navigate if the synthetic click is ignored too.
  link.href = "https://www.tiktok.com/login/email";
  const off = withDom([link]);
  const done = withUIEvents(() => {
    link.setAttribute(TARGET_ATTR, "1");
    return activateMarked([TARGET_ATTR]);
  });
  try {
    const r = await done();
    assert.equal(r.href, "https://www.tiktok.com/login/email");
  } finally {
    off();
  }
});

test("activation with nothing marked is a no-op, not an error", async () => {
  const m = verifyModal();
  const off = withDom(m.all);
  const done = withUIEvents(() => activateMarked([TARGET_ATTR]));
  try {
    assert.equal(await done(), null);
  } finally {
    off();
  }
});

test("the activity watch tells a press that landed from one that was ignored", async () => {
  const m = verifyModal();
  const off = withDom(m.all);
  observers.length = 0;
  try {
    const start = activityProbe(["start"]);
    assert.equal(start.mutations, 0);
    assert.match(start.fp, /TikTok/, "the fingerprint is the screen itself: title, text, scroll, focus");

    const obs = observers.at(-1);
    obs.fire(3);
    const peek = activityProbe(["peek"]);
    assert.equal(peek.mutations, 3);
    obs.fire(2);
    assert.equal(activityProbe(["peek"]).mutations, 5, "peek keeps watching — the fallback happens inside the same window");

    // The screen only "answered" when what is on it changed.
    globalThis.document.body.innerText = "Enter the code we sent to a***2@gmail.com";
    const end = activityProbe(["end"]);
    assert.notEqual(end.fp, start.fp, "a new screen changes the fingerprint");
    obs.fire(50);
    // After `end` there is no watch left to accumulate anything: an observer that
    // outlived the press would keep counting for the next one and lie about it.
    assert.equal(activityProbe(["peek"]).mutations, 0, "end tears the observer down");
    assert.equal(obs.active, false);
  } finally {
    activityProbe(["end"]);
    off();
  }
});

test("hover churn alone is not reported as a response", async () => {
  const m = verifyModal();
  const off = withDom(m.all);
  observers.length = 0;
  try {
    const start = activityProbe(["start"]);
    observers.at(-1).fire(6); // a row's :hover restyling, nothing more
    const peek = activityProbe(["peek"]);
    assert.equal(peek.fp, start.fp, "same screen");
    assert.ok(peek.mutations <= 40, "and no real DOM change — so the caller escalates");
  } finally {
    activityProbe(["end"]);
    off();
  }
});

test("the escalation functions are self-contained too", () => {
  const m = verifyModal();
  const dom = domFor(m.all);
  const sandbox = {
    document: dom.document,
    window: { ...dom.window, innerWidth: VIEWPORT.w, innerHeight: VIEWPORT.h },
    MutationObserver: FakeMutationObserver,
    MouseEvent: FakeUIEvent,
    PointerEvent: FakeUIEvent,
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const marked = vm.runInNewContext(
    `(${findLabelTarget.toString()})(${JSON.stringify(["Email", INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR])})`,
    sandbox
  );
  assert.ok(marked && marked.y === 291);
  const activated = vm.runInNewContext(`(${activateMarked.toString()})(${JSON.stringify([TARGET_ATTR])})`, sandbox);
  assert.equal(activated.tag, "div", "activateMarked runs in a bare realm, exactly as Playwright sends it");
  const watch = vm.runInNewContext(`(${activityProbe.toString()})(${JSON.stringify(["start"])})`, sandbox);
  assert.match(watch.fp, /TikTok/);
  assert.equal(vm.runInNewContext(`(${activityProbe.toString()})(${JSON.stringify(["end"])})`, sandbox).mutations, 0);
});
