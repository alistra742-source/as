/**
 * Finding the caption box — the page-side half lives here so it can be tested.
 *
 * TikTok's studio used to expose `[data-e2e="post_caption_editable"]`. Then it
 * was a `textarea[id*=caption]`. Now it is a plain `div[contenteditable="true"]`
 * under a "Description" heading, and a list of yesterday's selectors is how a
 * publish ends up going out with no caption at all: nothing throws, the click
 * lands on whatever matched, and the video posts empty.
 *
 * So instead of matching a selector, this ranks *every* editable box on the page
 * by the label next to it and by its size, and picks the winner. Two shapes can
 * change that survive a redesign: "the box the UI calls Description" and "the box
 * you write a long thing in".
 *
 * `collectEditableBoxes` is evaluated **inside the browser**: it may import and
 * close over nothing, which is why the scoring is a separate pure function the
 * Node side runs on the plain data it returns. One ranking, one source of truth,
 * and it is unit-testable without a browser (`test/captionPick.test.mjs`).
 */

/** Everything that could conceivably be "the box you type into". */
export const CAPTION_SELECTOR = 'div[contenteditable="true"], [role="textbox"], textarea, input[type="text"]';

/** Marks a candidate during collection so the chosen one can be re-found by id. */
export const CANDIDATE_ATTR = "data-vd-caption-cand";

/** Above this many characters a single-line input is not a caption field. */
export const CAPTION_MAX_CHARS = 2200;

export interface EditableBox {
  /** Index of `data-vd-caption-cand`, i.e. the handle back to the real element. */
  id: number;
  tag: string;
  role: string;
  editable: boolean;
  /** Every piece of text the UI puts near a field, concatenated. */
  label: string;
  width: number;
  height: number;
  /** Below the top edge of the viewport (a scrolled-past field is not the target). */
  onScreen: boolean;
  /** The element itself says it is usable. */
  enabled: boolean;
  multiLine: boolean;
}

const DESCRIPTIVE = /descri|caption|what.?s on|add topic|write|describe|title/i;
/** The decoys on every one of these pages, in order of how often they win a bad guess. */
const DECOY = /search|comment|reply|username|password|email|phone|nickname|bio|link|url/i;

/**
 * How much this looks like "the box you write the caption in".
 * Positive means plausible; 0 or below means leave it alone.
 */
export function scoreEditableBox(b: EditableBox): number {
  if (!b.enabled || !b.onScreen) return -1;
  if (b.width < 120 || b.height < 12) return -1;
  const label = b.label || "";
  let s = 0;
  if (DESCRIPTIVE.test(label)) s += 40;
  if (DECOY.test(label)) s -= 60;
  // A real rich-text editor beats a plain input: TikTok, Instagram and the
  // YouTube description are all contenteditable now.
  if (b.editable) s += 14;
  if (b.role === "textbox") s += 8;
  if (b.multiLine) s += 6;
  if (b.tag === "TEXTAREA") s += 6;
  if (b.tag === "INPUT") s -= 8; // single-line inputs are search boxes until proven otherwise
  // The caption field is wide — a whole column of the form, not a chip. This is
  // the tiebreaker that does not depend on the site's own words.
  s += Math.min(24, Math.round(b.width / 34));
  return s;
}

/** The best candidate, or null when nothing on the page plausibly is one. */
export function pickEditableBox<T extends EditableBox>(boxes: T[]): T | null {
  let best: T | null = null;
  let bs = 0;
  for (const b of boxes) {
    const s = scoreEditableBox(b);
    if (s > bs) {
      bs = s;
      best = b;
    }
  }
  return best;
}

/**
 * PAGE-SIDE. Reads every editable box into plain data and tags it with `attr`.
 * Must stay self-contained: no imports, no closures, no shared helpers.
 */
export function collectEditableBoxes(opts: [selector: string, attr: string]): Array<EditableBox> {
  const selector = opts[0];
  const attr = opts[1];
  const out: Array<EditableBox> = [];
  const nodes = Array.from(document.querySelectorAll(selector));
  let id = 0;
  for (const raw of nodes) {
    const el = raw as HTMLElement;
    const r = el.getBoundingClientRect();
    const near: string[] = [];
    const labelFor = el.getAttribute("aria-labelledby");
    if (labelFor) {
      for (const ref of labelFor.split(/\s+/)) {
        const t = document.getElementById(ref)?.textContent || "";
        if (t) near.push(t);
      }
    }
    near.push(el.getAttribute("aria-label") || "");
    near.push(el.getAttribute("placeholder") || "");
    near.push(el.getAttribute("data-e2e") || "");
    near.push(el.getAttribute("data-testid") || "");
    near.push(el.getAttribute("name") || "");
    near.push(el.getAttribute("id") || "");
    // The labelling element for these editors is usually a sibling or a heading
    // above them, not an ancestor — look both ways, briefly.
    const wrap = el.closest('label, [class*="editor"], [class*="caption"], [class*="description"], [class*="text-field"], [class*="form"]');
    near.push((wrap?.textContent || "").slice(0, 160));
    let sib = el.previousElementSibling;
    for (let hops = 0; hops < 2 && sib; hops++, sib = sib.previousElementSibling) near.push(sib.textContent || "");
    const parent = el.parentElement;
    if (parent && parent.children.length <= 2) near.push((parent.textContent || "").slice(0, 80));

    const cs = window.getComputedStyle(el);
    out.push({
      id: id++,
      tag: el.tagName.toUpperCase(),
      role: el.getAttribute("role") || "",
      editable: el.getAttribute("contenteditable") === "true" || el.isContentEditable === true,
      label: near.join(" ").replace(/\s+/g, " ").trim().slice(0, 400),
      width: Math.round(r.width),
      height: Math.round(r.height),
      onScreen: r.top >= 0 && r.top < window.innerHeight && r.bottom > 0,
      enabled: !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" && cs.visibility !== "hidden" && cs.display !== "none" && cs.pointerEvents !== "none",
      multiLine: r.height >= 44 || el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true",
    });
    el.setAttribute(attr, String(out.length - 1));
  }
  return out;
}
