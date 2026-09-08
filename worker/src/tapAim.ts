/**
 * The page-side half of the deck's tap pipeline.
 *
 * Both functions here run **inside the browser**: Playwright serializes the
 * function and evaluates it in the page, so they may close over *nothing* —
 * every input arrives in the argument array, and they touch only `document` /
 * `window`. Kept in their own module (rather than inline in `browser.ts`)
 * because that same restriction makes them directly unit-testable against a
 * fake DOM: see `test/tapAim.test.mjs`.
 */

/** What counts as "a thing you can click". A selector, not a guess: see below. */
export const INTERACTIVE_SEL =
  "a,button,input,textarea,select,summary,label,iframe,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[onclick],[contenteditable=true]";

/** How far a press may be moved before we assume the user meant that spot. */
export const MAX_NUDGE_PX = 16;
/**
 * An interactive node covering more than this share of the viewport is a
 * *container* (a modal backdrop, a scroll pane), not the thing under your
 * thumb. Without this, every row of a modal is "inside" the click-anywhere
 * backdrop and the assist would refuse to fix anything — or, worse, an
 * assist that treats the backdrop as a target would fight a deliberate tap
 * on it (which is how these modals get dismissed).
 */
export const CONTAINER_VIEWPORT_RATIO = 0.6;

export type AimResult = { x: number; y: number; label: string; dx: number; dy: number } | null;

/** Where a labelled control is, in this frame's CSS px. */
export interface LabelTarget {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** False when only the text node was matched — the press relies on bubbling. */
  clickable: boolean;
}

/**
 * Where should the press ACTUALLY go?
 *
 * A thumb aims at a *row*; the pixel it hits is the gap between rows, the grey
 * padding inside a card, or the `<span>` holding the label while the click
 * handler lives on the parent `<div>` — which is exactly how TikTok's
 * "verify it's really you" list (Email / Password) is built. A raw pixel press
 * there is a well-formed, trusted click on nothing, indistinguishable from "the
 * browser is broken".
 *
 * So: if the point is already on a control, leave it alone, absolutely. If it is
 * not, look outward in cheap rings (up to `limit`, cardinal directions first
 * because list rows stack) and **clamp** the press into the nearest control's
 * box — clamped, never centred, because centring drags the tap across wide rows
 * the user had no argument with. Past `limit` the empty space was the intent, and
 * we say nothing.
 *
 * An interactive node covering more than `containerRatio` of the viewport is a
 * *container* (a modal backdrop, a scroll pane), not the thing under your thumb:
 * without that rule every row of a modal is "inside" the click-anywhere backdrop
 * so nothing is ever on target, and an assist that treated the backdrop as a
 * target would fight the deliberate tap on it that dismisses the modal.
 *
 * Everything it needs arrives in the argument tuple, and the body closes over
 * nothing but its own locals — Playwright stringifies this function and evaluates
 * it in the page, where this module does not exist. `test/tapAim.test.mjs` runs
 * the serialized source in a bare realm to keep that honest.
 *
 * Returns null when there is nothing to move.
 */
export function tapAim([px, py, sel, limit, containerRatio]: [number, number, string, number, number]): AimResult {
  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 900;
  const maxArea = vw * vh * containerRatio;
  /** The nearest interactive node at a point, ignoring viewport-filling containers. */
  const controlAt = (sx: number, sy: number): Element | null => {
    let node: Element | null = document.elementFromPoint(sx, sy);
    for (let hops = 0; hops < 8 && node; hops++) {
      if (node.matches?.(sel) || window.getComputedStyle(node as HTMLElement).cursor === "pointer") {
        const r = node.getBoundingClientRect();
        // `cursor: pointer` counts because that is how a hand-rolled <div
        // onClick> row advertises itself — often the only signal these
        // verify-identity rows give. A node with no box of its own is not
        // something a press can land on, so it does not rescue one either.
        if (r.width >= 1 && r.height >= 1 && r.width * r.height <= maxArea) return node;
        return null;
      }
      node = node.parentElement ?? (node.getRootNode() as ShadowRoot | null)?.host ?? null;
    }
    return null;
  };
  // Already on a control? Press exactly where the user aimed. This is the common
  // case and it must cost nothing but the hit test.
  const own = controlAt(px, py);
  if (own) {
    const r = own.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return null;
  }
  const UNIT = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.72, 0.72], [-0.72, 0.72], [0.72, -0.72], [-0.72, -0.72]];
  for (let d = 4; d <= limit; d += 4) {
    for (const [ux, uy] of UNIT) {
      const cand = controlAt(px + ux * d, py + uy * d);
      if (!cand) continue;
      const r = cand.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) continue; // inside it already: not a miss
      const nx = Math.min(Math.max(px, r.left + 2), r.right - 2);
      const ny = Math.min(Math.max(py, r.top + 2), r.bottom - 2);
      if (Math.hypot(nx - px, ny - py) > limit) continue;
      const label = cand.getAttribute("aria-label") || (cand.textContent || "").trim().slice(0, 24) || cand.tagName.toLowerCase();
      return { x: nx, y: ny, label, dx: nx - px, dy: ny - py };
    }
  }
  return null;
}

export interface TapReport {
  under: string;
  focused: string;
  onField: boolean;
  interactive: boolean;
  scrollY: number;
  /** True when the control found here was marked for the DOM-side fallback. */
  marked: boolean;
}

/**
 * After the release: what is under the point, what took focus, was it a control
 * at all, and where the document is scrolled. This is what turns "I clicked
 * Password and nothing happened" into a sentence in the deploy log — and
 * `onField` is what raises the deck's device keyboard.
 */
export function tapProbe([px, py, sel, markAttr]: [number, number, string, string]): TapReport {
  const at = document.elementFromPoint(px, py);
  const desc = (n: Element | null) => {
    if (!n) return "nothing";
    const el = n as HTMLElement;
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${text}"`;
  };
  const isField = (n: Element | null) => {
    const el = n as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        el.getAttribute("contenteditable") === "true" ||
        el.getAttribute("role") === "textbox")
    );
  };
  let node: Element | null = at;
  let interactive = false;
  for (let hops = 0; hops < 8 && node; hops++) {
    if (node.matches?.(sel) || window.getComputedStyle(node as HTMLElement).cursor === "pointer") {
      interactive = true;
      break;
    }
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot | null)?.host ?? null;
  }
  // Leave the control marked so the caller can activate THIS node from the DOM
  // if it turns out the pointer press was ignored. One attribute, removed by
  // whichever path consumes it (or by the next locate).
  let marked = false;
  if (node) {
    try {
      node.setAttribute(markAttr, "1");
      marked = true;
    } catch {
      /* a node the framework refuses to touch: no fallback available */
    }
  }
  return {
    under: desc(at),
    focused: desc(document.activeElement),
    onField: isField(document.activeElement) || isField(at),
    interactive,
    marked,
    scrollY: window.scrollY,
  };
}

/**
 * Find a control by the TEXT it shows, and say where its centre is — the way a
 * person finds it, with no pixel maths anywhere in between.
 *
 * This exists because a coordinate tap has to survive the letterbox, the window
 * size, the device pixel ratio and page zoom before it can even reach the right
 * row. When the deck instead says "press the thing labelled Email", the page
 * itself answers with the box, and the press cannot miss by construction. It is
 * also the only path that works when the control is inside an iframe: the caller
 * runs this per frame and offsets the result by the frame's own box.
 *
 * The element is matched by the *smallest* node whose text starts with the label
 * (so "Email" finds the row's label, not the <body> that contains the word),
 * then climbed up to the nearest real click target — unless that target is a
 * viewport-filling container, in which case the label itself is pressed, since
 * click handlers bubble and React listeners live above it anyway.
 *
 * Same rule as `tapAim`: it is stringified into the page, so it closes over
 * nothing and takes everything — the selector, the container ratio, the name of
 * the attribute used to mark the winner — as arguments.
 */
export function findLabelTarget([text, sel, containerRatio, markAttr]: [string, string, number, string]): LabelTarget | null {
  const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(text);
  if (!want || !document.body) return null;
  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 900;
  const maxArea = vw * vh * containerRatio;
  const clickable = (el: Element) => {
    try {
      return el.matches(sel) || window.getComputedStyle(el as HTMLElement).cursor === "pointer";
    } catch {
      return false;
    }
  };
  let best: HTMLElement | null = null;
  let bestLen = Infinity;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    // aria-label / title first: an icon-only control ("Close", "Back") has no
    // text of its own at all, and those are exactly the deck's other buttons.
    const t = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent);
    // Only ever accept a tighter (shorter-text) match than what we have.
    if (!t || t.length >= bestLen) continue;
    // The label at the start, or a short string that contains it. The length cap
    // is the point: without it <body> "matches" everything and a "find the Email
    // row" press becomes a press in the middle of the page.
    if (!t.startsWith(want) && !(t.length <= want.length + 48 && t.includes(want))) continue;
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue; // hidden, collapsed, or an icon
    best = el as HTMLElement;
    bestLen = t.length;
  }
  if (!best) return null;
  // Climb onto the row or button that owns the handler — but only into a parent
  // that is still recognisably "the thing holding this label". The card around
  // it and the page behind it are not: their centre is nowhere near the label,
  // and a press there is a press on the backdrop. If nothing clickable turns up,
  // the label itself is pressed; a React handler above it still gets the event,
  // because clicks bubble.
  let target: HTMLElement = best;
  let found = clickable(best);
  for (let hops = 0; !found && hops < 4; hops++) {
    const parent = target.parentElement;
    if (!parent) break;
    const pr = parent.getBoundingClientRect();
    const cr = target.getBoundingClientRect();
    if (pr.width > cr.width * 3 || pr.height > cr.height * 3 || pr.width * pr.height > maxArea) break;
    target = parent;
    found = clickable(parent);
  }
  // Hand the chosen node to the next evaluate: a DOM element cannot cross that
  // boundary, so the mark is how `activateMarked` finds exactly this element.
  try {
    document.querySelector(`[${markAttr}]`)?.removeAttribute(markAttr);
    target.setAttribute(markAttr, "1");
  } catch {
    /* a node React owns may refuse; the coordinate press still works without it */
  }
  target.scrollIntoView({ block: "center", inline: "center" });
  const r = target.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: Math.round(r.width),
    h: Math.round(r.height),
    label: norm(target.getAttribute("aria-label") || target.textContent) || want,
    clickable: found,
  };
}

/**
 * The attribute that carries a located element across to the next evaluate. A
 * DOM node cannot cross the boundary, so the finder marks the node it chose and
 * the activator looks the mark up. Marking happens *before* the activity watch
 * starts, so it is never mistaken for the page responding.
 */
export const TARGET_ATTR = "data-vd-tap";

/** `"start"` installs, `"peek"` reads without stopping, `"end"` reads and tears down. */
export type ActivityPhase = "start" | "peek" | "end";

/**
 * Phase of the "did the page do ANYTHING?" probe, run in the frame that holds the
 * control: `"start"` installs a MutationObserver and fingerprints the screen,
 * `"end"` collects the count and re-fingerprints it.
 *
 * A press that produces no change is the whole complaint behind "I clicked
 * Password and nothing happened", and it is the only honest way to know whether
 * to leave the page alone or escalate. Fingerprinting the visible text (rather
 * than trusting mutation counts alone) is deliberate: hover styles churn the DOM
 * constantly and would report success for a click that did nothing.
 */
export function activityProbe([phase]: [ActivityPhase]): { mutations: number; fp: string } {
  const fingerprint = () => {
    try {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 600);
      const focus = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
      return `${document.title}|${text}|${Math.round(window.scrollY)}|${focus}`;
    } catch {
      // A frame that is detaching mid-probe has no readable text; the throw
      // itself is a strong hint something happened, so say so.
      return "unreadable";
    }
  };
  const w = window as unknown as { __vdWatch?: { n: number; obs?: MutationObserver } };
  if (phase === "start") {
    try {
      w.__vdWatch?.obs?.disconnect();
    } catch {
      /* stale observer from a previous press */
    }
    const st = { n: 0, obs: undefined as MutationObserver | undefined };
    try {
      st.obs = new MutationObserver((recs) => {
        st.n += recs.length;
      });
      st.obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      /* detached document: the fingerprint alone still works */
    }
    w.__vdWatch = st;
    return { mutations: 0, fp: fingerprint() };
  }
  const st = w.__vdWatch;
  const read = { mutations: st?.n ?? 0, fp: fingerprint() };
  if (phase === "end") {
    try {
      st?.obs?.disconnect();
    } catch {
      /* already gone */
    }
    delete w.__vdWatch;
  }
  return read;
}

/**
 * Activate the marked control from the DOM side: a full pointer + mouse sequence
 * dispatched on the node itself, with the event bubbling up to wherever the
 * framework parked its handler.
 *
 * This is the escape hatch for the case a coordinate press cannot reach: an
 * invisible layer above the modal, a row that only answers events whose `target`
 * is the element it listens on, a window that lost its hit-test surface. It is
 * NOT a trusted event (`isTrusted === false`) and it is never used first — only
 * after a real, humanized, trusted press on the same element demonstrably did
 * nothing, and only for a control the user named. Stealth says nothing else; a
 * stuck login says everything.
 *
 * An `<a href>` in the chain is reported so the caller can navigate if the
 * synthetic click is ignored too.
 */
export function activateMarked([attr]: [string]): { label: string; events: number; href: string; tag: string } | null {
  const el = document.querySelector(`[${attr}]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Structural, not `typeof PointerEvent`: these constructors take their own
  // init dicts, and the only thing this function needs is `new (type, init)`.
  type Ctor = new (type: string, init?: Record<string, unknown>) => Event;
  const PE = (globalThis as { PointerEvent?: Ctor }).PointerEvent;
  const ME = (globalThis as { MouseEvent?: Ctor }).MouseEvent;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
  let fired = 0;
  const fire = (type: string, Ctor?: Ctor) => {
    if (!Ctor) return;
    try {
      el.dispatchEvent(new Ctor(type, { ...base, buttons: type.endsWith("up") || type === "click" ? 0 : 1 }));
      fired += 1;
    } catch {
      /* a constructor this engine dislikes is not worth failing over */
    }
  };
  fire("pointerover", PE);
  fire("pointerenter", PE);
  fire("pointerdown", PE);
  fire("mouseover", ME);
  fire("mousedown", ME);
  fire("pointerup", PE);
  fire("mouseout", ME);
  fire("mouseup", ME);
  fire("click", ME);
  el.removeAttribute(attr);
  const link = (el.closest?.("a[href]") ?? null) as HTMLAnchorElement | null;
  const text = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  return { label: text.slice(0, 48), events: fired, href: link?.href || "", tag: el.tagName.toLowerCase() };
}
