/**
 * The one bit of geometry the live deck must get right: turning "the finger was
 * lifted here, in the widget that shows the remote page" into "the fraction of
 * the page that was pointed at".
 *
 * It is its own module because the whole class of "I tapped Password and nothing
 * happened" reports came from getting it wrong: the frame is `object-contain`
 * inside the viewport box, so unless the box already has the page's aspect
 * ratio, the image is letterboxed — and a `<img class="h-full w-full">` reports
 * the *box* rect, letterboxing included. Dividing by that (the old code) pulled
 * every tap toward the vertical centre of the box: ~16 px off on a login row,
 * ~40 px on the modal's back arrow, ~67 px near the footer, in page pixels.
 */

export interface BoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the letterboxed image sits inside its box, in CSS px. */
export function displayedImageRect(
  box: BoxRect,
  natural: { w: number; h: number } | null
): { left: number; top: number; width: number; height: number } {
  if (!natural || natural.w < 1 || natural.h < 1) return { left: box.left, top: box.top, width: box.width, height: box.height };
  // object-contain: scale to fit, then centre on both axes.
  const k = Math.min(box.width / natural.w, box.height / natural.h);
  const width = natural.w * k;
  const height = natural.h * k;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

export interface PageFraction {
  x: number;
  y: number;
}

/**
 * A pointer point in viewport coordinates → the fraction of the *page* it
 * points at, or null when it landed outside the image (a tap on the black bar
 * is not a tap on the page, and must not be clamped into one).
 */
export function pointToPageFraction(
  box: BoxRect,
  natural: { w: number; h: number } | null,
  clientX: number,
  clientY: number
): PageFraction | null {
  const img = displayedImageRect(box, natural);
  if (img.width < 1 || img.height < 1) return null;
  const x = (clientX - img.left) / img.width;
  const y = (clientY - img.top) / img.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

/**
 * Where to draw the "this is where your press landed" marker, as a percentage of
 * the box — so it lands on the pixel the user touched even when the image is
 * letterboxed.
 */
export function markerPercent(box: BoxRect, clientX: number, clientY: number): { x: number; y: number } {
  return { x: ((clientX - box.left) / box.width) * 100, y: ((clientY - box.top) / box.height) * 100 };
}
