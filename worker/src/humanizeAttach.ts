/**
 * Guarantee the Clearcote humanize wrapper is attached to every page we use.
 *
 * WHY THIS FILE EXISTS — the bug that made clicks "not go through":
 *
 * `launchPersistentContext()` ends with
 *     installHumanizeOnContext(context, { humanize, showCursor, seed })
 * which does `const b = browser ?? context.browser()` and only attaches the
 * wrapper `if (b)`. Playwright documents `context.browser()` as **null for a
 * persistent context** — so on exactly the launch path we use, the wrapper
 * was never installed. Nothing errors; `page.mouse` is just plain Playwright.
 *
 * Plain Playwright `mouse.down()` presses at its *own* tracked (x, y). Our tap
 * does `move(x, y)` → `down()` → `up()`, so single taps usually still hit —
 * but anything that assumed the wrapper's guarantees (the re-pin before the
 * press, the humanized glide, tremor, key-hold dwell, eased wheel) was simply
 * not there. And when the cursor tracking diverged from what the page thought
 * (a navigation between move and press, a frame swap, a queued scroll), the
 * press landed at a stale point — the "I'm clicking Password and nothing
 * happens" symptom. Also: every input was a robotic, instant, untrusted-looking
 * event — the opposite of what the stealth stack promises.
 *
 * The SDK's per-page `attachHumanize(browser, page, opts)` does not need a
 * browser at all (the argument is only used for the optional PRO engine-side
 * click routing, which falls back gracefully). So we call it ourselves for
 * every page, idempotently (the SDK guards on `page.__clearcoteHumanized`).
 *
 * `humanize.js` is not part of the package's public `exports`, so it is
 * resolved relative to the package's own entry point rather than by subpath.
 */
import type { BrowserContext, Page } from "playwright-core";

type AttachFn = (browser: unknown, page: Page, opts: { humanize: boolean; showCursor?: boolean; seed?: string }) => Promise<void>;

let attachPromise: Promise<AttachFn | null> | null = null;

async function loadAttach(): Promise<AttachFn | null> {
  if (attachPromise) return attachPromise;
  attachPromise = (async () => {
    try {
      // ESM resolution honours the package's `exports` map (the package is
      // ESM-only, so createRequire().resolve would not). The entry point is
      // …/node_modules/clearcote/dist/index.js; humanize.js sits beside it.
      const entry = import.meta.resolve("clearcote");
      const humanizeUrl = new URL("./humanize.js", entry).href;
      const mod = (await import(humanizeUrl)) as { attachHumanize?: AttachFn };
      if (typeof mod.attachHumanize !== "function") throw new Error("attachHumanize export missing");
      return mod.attachHumanize;
    } catch (e) {
      console.error(`[humanize] could not load Clearcote's humanize module — input will be plain Playwright: ${(e as Error).message}`);
      return null;
    }
  })();
  return attachPromise;
}

export interface HumanizeAttachOpts {
  humanize: boolean;
  showCursor: boolean;
  seed: string;
}

/** Attach (idempotently) to one page. Returns true when the wrapper is active. */
export async function ensureHumanized(page: Page, opts: HumanizeAttachOpts): Promise<boolean> {
  const attach = await loadAttach();
  if (!attach) return false;
  try {
    await attach(null, page, opts);
    return (page as unknown as { __clearcoteHumanized?: boolean }).__clearcoteHumanized === true;
  } catch (e) {
    console.error(`[humanize] attach failed on a page: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Cover a whole context: every existing page now, every future page as it
 * appears (popups, engine tabs, crash-replacement tabs). Idempotent per page.
 */
export function humanizeContext(ctx: BrowserContext, opts: HumanizeAttachOpts): void {
  for (const p of ctx.pages()) void ensureHumanized(p, opts);
  ctx.on("page", (p) => void ensureHumanized(p, opts));
}

/** Is the SDK wrapper active on this page? (Diagnostics + boot log.) */
export function isHumanized(page: Page): boolean {
  return (page as unknown as { __clearcoteHumanized?: boolean }).__clearcoteHumanized === true;
}
