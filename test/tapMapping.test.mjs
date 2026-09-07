/**
 * Unit test for the deck's tap geometry — the mapping that decides which part of
 * the remote page a tap in the live viewport points at. No DOM needed: the
 * functions are pure geometry, and a black bar is just a rectangle.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { displayedImageRect, markerPercent, pointToPageFraction } from "../src/lib/tapMapping.ts";

// A headed Chromium whose content area is NOT the 64/45 the deck used to assume.
const PAGE = { w: 1264, h: 695 };
const BOX = { left: 0, top: 0, width: 900, height: (900 * 45) / 64 };

/** Forward map: where in the box a point of the page is displayed. */
function screenOf(px, py) {
  const img = displayedImageRect(BOX, PAGE);
  return { x: img.left + (px / PAGE.w) * img.width, y: img.top + (py / PAGE.h) * img.height };
}

test("the letterboxed image is centred inside the box", () => {
  const img = displayedImageRect(BOX, PAGE);
  assert.ok(img.height < BOX.height, "a wider page than the box means black bars top and bottom");
  assert.equal(Math.round(img.top), Math.round((BOX.height - img.height) / 2));
  assert.equal(Math.round(img.width), BOX.width, "fitted to width, so no side bars");
});

test("a tap round-trips to the exact page point it was aimed at", () => {
  for (const [px, py] of [
    [120, 170], // a modal's back arrow, near the top
    [430, 351], // the middle row of the modal
    [430, 421], // the row under it
    [620, 653], // the footer link at the bottom
  ]) {
    const s = screenOf(px, py);
    const f = pointToPageFraction(BOX, PAGE, s.x, s.y);
    assert.ok(f, `(${px},${py}) is inside the image`);
    assert.equal(Math.round(f.x * PAGE.w), px);
    assert.equal(Math.round(f.y * PAGE.h), py);
  }
});

test("the naive box-relative mapping is what made taps miss", () => {
  // This is the old behaviour, reproduced here so the regression stays fixed:
  // divide by the BOX, not by the displayed image. The skew is zero at the
  // vertical centre and grows towards the edges — exactly the "some buttons
  // work, the login rows do not" report.
  let worst = 0;
  for (let py = 0; py <= PAGE.h; py += 5) {
    const s = screenOf(400, py);
    const old = { x: s.x / BOX.width, y: s.y / BOX.height };
    worst = Math.max(worst, Math.abs(old.y * PAGE.h - py));
  }
  assert.ok(worst > 30, `expected a skew of dozens of page pixels, got ${Math.round(worst)}`);
});

test("before the frame's size is known, the box is used as-is", () => {
  const f = pointToPageFraction(BOX, null, BOX.width / 2, BOX.height / 2);
  assert.deepEqual(f, { x: 0.5, y: 0.5 });
});

test("a tap on the black bar is not a tap on the page", () => {
  const img = displayedImageRect(BOX, PAGE);
  assert.equal(pointToPageFraction(BOX, PAGE, BOX.width / 2, img.top - 4), null, "above the image");
  assert.equal(pointToPageFraction(BOX, PAGE, BOX.width / 2, img.top + img.height + 4), null, "below the image");
  assert.ok(pointToPageFraction(BOX, PAGE, BOX.width / 2, img.top + 4), "just inside still counts");
});

test("a tall page gets side bars instead, and those are handled too", () => {
  const tall = { w: 700, h: 900 };
  const img = displayedImageRect(BOX, tall);
  assert.ok(img.width < BOX.width, "narrower than the box: pillarboxed");
  const s = { x: img.left + 0.25 * img.width, y: img.top + 0.75 * img.height };
  const f = pointToPageFraction(BOX, tall, s.x, s.y);
  assert.ok(f);
  assert.equal(Math.round(f.x * tall.w), Math.round(0.25 * tall.w));
  assert.equal(Math.round(f.y * tall.h), Math.round(0.75 * tall.h));
});

test("the press marker sits under the finger even with bars", () => {
  const img = displayedImageRect(BOX, PAGE);
  const p = markerPercent(BOX, BOX.width / 2, img.top + 2);
  assert.equal(Math.round(p.x), 50);
  assert.ok(p.y > 0 && p.y < 50, "the marker is placed where the touch was, not at the page point");
});
