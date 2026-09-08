/**
 * TikTok occasionally puts this one-time product-tour card over the upload
 * editor after a file has been accepted:
 *
 *   New editing features added
 *   ...
 *   Got it
 *
 * It is a DOM modal, not a browser `dialog`, and while it is open every caption,
 * audience and Post click is intercepted by its backdrop.  This page-side finder
 * deliberately requires BOTH the exact acknowledgement label and the nearby
 * product-tour title.  A different "Got it" elsewhere on the page must never be
 * clicked just because it happens to use the same words.
 *
 * This module has no imports because the function is serialized into the page by
 * Playwright and is also unit-tested directly against a small fake DOM.
 */

export const TIKTOK_EDITING_TIP_ATTR = "data-vd-tiktok-editing-tip";

export interface TikTokEditingTipButton {
  tag: string;
  label: string;
  width: number;
  height: number;
}

/**
 * Find and mark the visible "Got it" control belonging to TikTok's editing-tip
 * card. The attribute carries the chosen DOM node across the next Playwright
 * call, just as `tapAim.ts` does for coordinate-free presses.
 */
export function markTikTokEditingTipButton([attr]: [string]): TikTokEditingTipButton | null {
  const norm = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const title = "new editing features added";
  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 900;

  // A prior attempt may have marked a node that React then kept around. Start
  // clean so the locator below can never click yesterday's hidden copy.
  try {
    for (const old of Array.from(document.querySelectorAll(`[${attr}]`))) old.removeAttribute(attr);
  } catch {
    /* The fixed attr is valid; a half-detached document is simply no match. */
  }

  const visible = (el: HTMLElement) => {
    try {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return (
        r.width >= 12 &&
        r.height >= 10 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < vw &&
        r.top < vh &&
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        s.opacity !== "0" &&
        s.pointerEvents !== "none"
      );
    } catch {
      return false;
    }
  };

  const inspect = (raw: HTMLElement[]): TikTokEditingTipButton | null => {
    const seen = new Set<HTMLElement>();
    for (let candidate of raw) {
      // If the text-only fallback found a <span>, prefer the semantic owner. A
      // click on the span would bubble too, but the owner's centre is more stable.
      let owner: HTMLElement | null = candidate;
      for (let hops = 0; owner && hops < 4; hops++) {
        if (owner.tagName === "BUTTON" || norm(owner.getAttribute("role")) === "button") break;
        owner = owner.parentElement;
      }
      if (owner && (owner.tagName === "BUTTON" || norm(owner.getAttribute("role")) === "button")) candidate = owner;
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      const label = norm(candidate.getAttribute("aria-label") || candidate.innerText || candidate.textContent);
      if (label !== "got it" || !visible(candidate)) continue;
      if ((candidate as HTMLButtonElement).disabled || norm(candidate.getAttribute("aria-disabled")) === "true") continue;

      // The title and button have to share a local card ancestor. Do not accept
      // <body>: it contains every phrase on the uploader and would turn this into
      // a global "click any Got it" rule.
      let node = candidate.parentElement;
      let belongsToTip = false;
      for (let hops = 0; node && hops < 12; hops++, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (norm(node.innerText || node.textContent).includes(title)) {
          belongsToTip = true;
          break;
        }
      }
      if (!belongsToTip) continue;

      try {
        candidate.setAttribute(attr, "1");
      } catch {
        continue;
      }
      const r = candidate.getBoundingClientRect();
      return {
        tag: candidate.tagName,
        label: "Got it",
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    return null;
  };

  // Semantic controls first. The all-elements pass is only for a TikTok build
  // that styles a plain text node as the acknowledgement control.
  const semantic = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  const found = inspect(semantic);
  if (found) return found;
  const exactText = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
    (el) => norm(el.getAttribute("aria-label") || el.innerText || el.textContent) === "got it"
  );
  return inspect(exactText);
}
