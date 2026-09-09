import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/mediaEnhance.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function(`${js}; return { planVideoEnhancement };`);
const { planVideoEnhancement } = load();

const probe = (patch = {}) => ({
  width: 1080,
  height: 1920,
  duration: 24,
  frameRate: 30,
  bitRate: 8_000_000,
  codec: "h264",
  ...patch,
});

test("the observed 540P TikTok source becomes a 1080x1920 upload master", () => {
  const plan = planVideoEnhancement(probe({ width: 540, height: 960, bitRate: 1_600_000 }), 82);
  assert.equal(plan.apply, true);
  assert.equal(plan.targetWidth, 1080);
  assert.equal(plan.targetHeight, 1920);
  assert.ok(plan.brightness >= 0.05);
  assert.ok(plan.gamma > 1);
  assert.ok(plan.denoise);
  assert.ok(plan.sharpen >= 0.7);
  assert.match(plan.reason, /below a 1080p master/);
  assert.match(plan.reason, /exposure correction/);
});

test("a dark 1080p source is corrected without claiming it is low-resolution", () => {
  const plan = planVideoEnhancement(probe(), 60);
  assert.equal(plan.apply, true);
  assert.equal(plan.brightness, 0.08);
  assert.ok(!plan.reason.includes("below a 1080p"));
});

test("a clean bright 1080p H.264 source is preserved to avoid generation loss", () => {
  const plan = planVideoEnhancement(probe(), 132);
  assert.equal(plan.apply, false);
  assert.match(plan.reason, /already sharp/);
});

test("a non-H.264 source is normalized even when its resolution and lighting are good", () => {
  const plan = planVideoEnhancement(probe({ codec: "vp9" }), 132);
  assert.equal(plan.apply, true);
  assert.match(plan.reason, /platform-safe H\.264 master/);
});

test("landscape masters retain landscape orientation", () => {
  const plan = planVideoEnhancement(probe({ width: 1280, height: 720 }), 120);
  assert.equal(plan.targetWidth, 1920);
  assert.equal(plan.targetHeight, 1080);
});
