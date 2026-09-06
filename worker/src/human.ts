/**
 * Human-behavior helpers layered on top of Clearcote's `humanize` wrapper.
 *
 * The Clearcote SDK already rewrites every page.mouse.* / page.keyboard.* /
 * locator.* call into native trusted input with a seed-derived motor persona
 * (minimum-jerk cursor paths, Fitts timing, tremor, eased scrolls, key dwell,
 * typos). This module adds the *temporal* human layer the wrapper can't see:
 * thinking pauses, reading pauses, off-protocol sleeps (a `page.waitForTimeout`
 * is a CDP round-trip per call — bot detectors score protocol traffic, so all
 * waits here are plain `setTimeout`), and no-typo human typing for
 * user-routed keystrokes (the SDK's `keyboard.type` wrapper injects 2%
 * fat-finger typos — perfect for engine-typed captions, wrong for a password
 * the user is watching).
 *
 * nodriver philosophy: no WebDriver layer anywhere — every keystroke and
 * click below is a native, trusted input event.
 */
import type { Page } from "playwright-core";

/** Off-protocol sleep — never a CDP round-trip. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uniform jitter in [min, max). */
export const jitter = (min: number, max: number) => min + Math.random() * (max - min);

/** Gaussian-ish jitter around a center (sum of 3 uniforms → ~bell curve). */
export const gaussJitter = (center: number, spread: number) =>
  Math.max(0, center + (Math.random() + Math.random() + Math.random() - 1.5) * spread);

/** A short "the human is looking at the page" pause. */
export const readingPause = (min = 250, max = 900) => sleep(jitter(min, max));

/** A longer thinking pause before composing an action. */
export const thinkingPause = (min = 600, max = 2200) => sleep(jitter(min, max));

/** Extended page with the humanize extras Clearcote attaches at runtime. */
export interface HumanPage extends Page {
  /** Ambient cursor drift (never clicks, never scrolls) for pointer entropy. */
  ambientMotion?: (ms?: number) => Promise<void>;
  /** Per-load ambient cursor burst before the first goal action. */
  _clearcoteAutoAmbient?: boolean;
}

export const asHumanPage = (page: Page): HumanPage => page as HumanPage;

/**
 * Enable the per-load ambient cursor burst on this page: a behavioral
 * collector sees non-zero pointer entropy BEFORE the first goal action, which
 * is the single biggest reason a challenge/slider is shown to headless
 * automation.
 */
export function armAmbient(page: Page): void {
  const hp = asHumanPage(page);
  hp._clearcoteAutoAmbient = true;
}

/**
 * Type `text` with human inter-key timing but NO typos. Used for keystrokes
 * the user routed from the deck (logins, OTPs) — the SDK's `keyboard.type`
 * wrapper stays for engine-typed captions, where an auto-corrected typo is
 * desirable realism. Each key still goes through the SDK's `press` wrapper,
 * so it carries the persona's key-hold dwell and remains a trusted event.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  const keys = Array.from(text);
  for (let i = 0; i < keys.length; i++) {
    await page.keyboard.press(keys[i]);
    if (i < keys.length - 1) {
      // Inter-key flight: fast typist, slower on boundaries and after spaces.
      const ch = keys[i];
      let wait = jitter(38, 120);
      if (/\s/.test(ch)) wait += jitter(20, 90); // pause at word boundaries
      if (Math.random() < 0.05) wait += jitter(160, 420); // brief thinking pause
      await sleep(wait);
    }
  }
}

/**
 * Chunked human scroll: split a large delta into 2–3 bursts separated by
 * reading pauses — a person flicking a feed reads between flicks. Each burst
 * is dispatched through the SDK's humanized `mouse.wheel` (eased native wheel
 * deltas, occasional mid-scroll pauses).
 */
export async function humanScroll(page: Page, dy: number): Promise<void> {
  const abs = Math.abs(dy);
  if (abs < 240) {
    await page.mouse.wheel(0, dy);
    return;
  }
  const bursts = Math.random() < 0.5 ? 2 : 3;
  const perBurst = dy / bursts;
  for (let i = 0; i < bursts; i++) {
    await page.mouse.wheel(0, perBurst);
    if (i < bursts - 1) await readingPause(220, 700);
  }
}

/**
 * A human "tap": approach dwell (eyes land before the finger), click, then a
 * beat before the page reacts. The click itself is the SDK's humanized
 * move+press+release.
 */
export async function humanTap(page: Page, x: number, y: number): Promise<void> {
  await readingPause(140, 480);
  await page.mouse.click(x, y);
  await sleep(jitter(80, 260));
}
