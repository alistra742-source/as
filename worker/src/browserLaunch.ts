/**
 * Which browser actually gets launched, and how to make it fast.
 *
 * Two engines are supported, picked by `BROWSER_ENGINE`:
 *
 *   playwright  (default) — stock Chromium through Playwright's own
 *                 `launchPersistentContext`. Same persistent profile, same raw
 *                 CDP input path (`human.ts` glides the cursor and presses
 *                 natively either way), but no engine-level fingerprint patching.
 *                 It starts faster, uses less memory, cannot fatal on a DCHECK,
 *                 and the binary comes from Playwright's own download instead of
 *                 a 150 MB third-party build baked into the image.
 *   clearcote   — the anti-fingerprint Chromium build. Use it when a site has
 *                 started refusing the stock one; the persona is compiled into
 *                 that browser and it needs the `LD_PRELOAD` setpriority shim.
 *
 * The speed work lives here too, because almost all of it is *flags*, not code:
 * Chromium's own background chatter (component updates, optimization hints,
 * profile syncing, breakpad, the audio stack) costs a second or two on every
 * cold start in a container and buys nothing here, a `--host-resolver-rules`
 * blocklist stops ad/analytics hosts at resolution time so they never cost a
 * request, and a forced scale factor plus a fixed window size removes the layout
 * thrash a resize in the first second causes (which also used to move the page
 * under a tap mid-press).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";

export type BrowserEngineChoice = "playwright" | "clearcote";

export function browserEngine(): BrowserEngineChoice {
  return (process.env.BROWSER_ENGINE || "playwright").trim().toLowerCase() === "clearcote" ? "clearcote" : "playwright";
}

/**
 * The window we drive, from the Xvfb screen the entrypoint created (1280x900x24
 * by default). The launch must agree with it: a window bigger than the display is
 * clipped, and a page that gets resized a second after load drifts out from under
 * the deck's tap mapping.
 */
export function dockSize(): { width: number; height: number } {
  const m = /(\d{3,4})x(\d{3,4})/.exec(process.env.XVFB_SCREEN || "");
  return { width: m ? Number(m[1]) : 1280, height: m ? Number(m[2]) : 900 };
}

/**
 * Third parties that only ever cost time. Matched on hostname, never on path, and
 * never on a domain the site itself needs: every entry here is an ad, analytics,
 * attribution, error-reporting or A/B tag, so blocking it can slow a page down for
 * nobody but the site's own revenue team. TikTok/Instagram/YouTube *first-party*
 * hosts are deliberately absent — blocking those logs you out.
 */
export const BLOCKED_HOSTS = [
  "analytics.tiktok.com",
  "adn.tiktok.com",
  "ads.tiktok.com",
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "securepubads.g.doubleclick.net",
  "connect.facebook.net",
  "an.facebook.com",
  "sentry.io",
  "sentry-cdn.com",
  "browser.sentry-cdn.com",
  "hotjar.com",
  "fullstory.com",
  "amplitude.com",
  "api.segment.io",
  "cdn.segment.com",
  "mparticle.com",
  "chartbeat.com",
  "scorecardresearch.com",
  "quantserve.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "adnxs.com",
  "amazon-adsystem.com",
  "casalemedia.com",
  "rubiproject.com",
  "appsflyer.com",
  "branch.io",
  "optimizely.com",
  "newrelic.com",
  "nr-data.net",
  "crashlytics.com",
];

/**
 * Hosts to block, `--host-resolver-rules` style. Resolution-time blocking beats
 * request interception here: no per-request CDP round trip, it covers workers and
 * subresources the page adds later, and a refused lookup costs the page nothing.
 * Set `BLOCK_TRACKERS=off` (or `false`) if a site starts refusing to render.
 */
export function resolverRules(): string | null {
  const v = (process.env.BLOCK_TRACKERS || "on").toLowerCase();
  if (v === "off" || v === "false" || v === "0") return null;
  return BLOCKED_HOSTS.map((h) => `MAP ${h} 0.0.0.0`).join(", ");
}

/** One merged `--disable-features`, because the last one on the command line wins. */
function disableFeatures(diet: boolean): string {
  const f = [
    "Translate",
    "MediaRouter",
    "OptimizationHints",
    "LoadingOfPersistenceForBackForwardCache",
    "PrivacySandboxSettings4",
  ];
  if (diet) f.push("IsolateOrigins", "site-per-process", "ProcessPerSiteUpToMainFrameThreshold");
  return `--disable-features=${f.join(",")}`;
}

/**
 * The stock-Chromium launch args. Everything in here is either Chromium's own
 * overhead in a container, or geometry that would otherwise change under the
 * first tap.
 */
export function playwrightArgs(opts: { width: number; height: number; v8HeapMb: number; diet: boolean }): string[] {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // Headless/container hygiene: none of this is observable by a page, all of it
    // is a request or a process that a real desktop browser makes and we do not.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-breakpad",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    // A docked viewport that never changes size: no relayout at first paint, and
    // no scale factor surprises between the deck's pixels and the page's CSS px.
    "--force-device-scale-factor=1",
    `--window-size=${opts.width},${opts.height}`,
    `--window-position=0,0`,
    // A cache the profile can actually reuse across restarts (a Railway volume is
    // slow per byte, so fewer requests matters more than a big one).
    "--disk-cache-size=268435456",
    `--js-flags=--max-old-space-size=${opts.v8HeapMb}`,
    // The feed autoplays as soon as it is up; without this the player waits for a
    // gesture that a screenshot-only user cannot give.
    "--autoplay-policy=no-user-gesture-required",
    disableFeatures(opts.diet),
    "--enable-features=OomIntervention,MemoryPurgeOnFreeze",
  ];
  const rules = resolverRules();
  if (rules) args.push(`--host-resolver-rules=${rules}`);
  if (opts.diet) args.push("--renderer-process-limit=3");
  return args;
}

/**
 * The two things worth patching on a stock Chromium, and nothing more.
 *
 * `navigator.webdriver` is the one flag every bot check looks at first, and
 * `window.chrome` missing is the second. Faking plugin arrays, languages or
 * screen geometry is how you *create* tells — a mismatched hash is far more
 * suspicious than an unpatched one — so this stays deliberately small.
 */
export async function installStealthLite(ctx: BrowserContext): Promise<void> {
  await ctx
    .addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {
        /* an immutable property is not worth a failed navigation */
      }
      const w = window as unknown as { chrome?: Record<string, unknown> };
      if (!w.chrome) w.chrome = { runtime: {} };
    })
    .catch(() => undefined);
}

export interface PlaywrightLaunchOpts {
  profile: string;
  headless: boolean;
  locale: string;
  timezoneId: string;
  width: number;
  height: number;
  logFile?: string;
}

/** A missing binary is a deploy problem, so it gets a deploy-grade message. */
function browserMissingError(raw: string): string {
  return (
    `${raw}\n\nStock Chromium is not installed in this image. Fix: run ` +
    `\`node node_modules/playwright-core/cli.js install chromium\` at BUILD time (the Dockerfile does), ` +
    `or point CHROME_PATH at an existing Chromium binary, or set BROWSER_ENGINE=clearcote to use the ` +
    `anti-fingerprint build this image used to ship by default.`
  );
}

function findSystemChromium(): string | null {
  const pinned = (process.env.CHROME_PATH || "").trim();
  if (pinned && fs.existsSync(pinned)) return pinned;
  for (const c of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Launch stock Chromium on the persistent profile. The profile dir is the same one
 * Clearcote uses, so switching engines does not log anything out: cookies, local
 * storage and the site's own device trust survive the change.
 */
export async function launchPlaywrightContext(o: PlaywrightLaunchOpts): Promise<BrowserContext> {
  const { cgroupMemoryMb, v8HeapMb } = await import("./config.js");
  const { limit } = cgroupMemoryMb();
  const diet =
    (process.env.STEALTH_SITE_ISOLATION || "").toLowerCase() === "false"
      ? true
      : (process.env.STEALTH_SITE_ISOLATION || "").toLowerCase() === "true"
        ? false
        : limit !== null && limit < 3000;

  const args = playwrightArgs({
    width: o.width,
    height: o.height,
    v8HeapMb: v8HeapMb(),
    diet,
  });
  if (o.logFile) args.push("--enable-logging=file", `--log-file=${o.logFile}`, "--log-level=0");

  const base = {
    headless: o.headless,
    locale: o.locale,
    timezoneId: o.timezoneId,
    args,
    // A service worker would answer requests behind our back and make the first
    // load on a fresh profile slower, not faster.
    serviceWorkers: "block" as const,
    ignoreDefaultArgs: ["--enable-automation"],
    timeout: 120_000,
  };
  // A real window gets the window's own metrics (an emulated viewport on a headed
  // window is both a tell and a source of scroll-offset drift under a tap).
  const visual = o.headless ? { viewport: { width: o.width, height: o.height } } : { viewport: null as null | { width: number; height: number } };

  const attempt = async (executablePath?: string) =>
    chromium.launchPersistentContext(o.profile, { ...base, ...visual, ...(executablePath ? { executablePath } : {}) });

  try {
    return await attempt();
  } catch (err) {
    const raw = (err as Error).message || String(err);
    const sys = findSystemChromium();
    if (/install|executable doesn.t exist|browserType.launch/i.test(raw) && sys) return await attempt(sys);
    if (/install|executable doesn.t exist|browserType.launch/i.test(raw)) throw new Error(browserMissingError(raw));
    throw err;
  }
}

/** Where the Playwright Chromium lives, for the boot log and the preflight. */
export function playwrightChromiumPath(): { path: string | null; detail: string } {
  const pinned = (process.env.CHROME_PATH || "").trim();
  if (pinned) {
    const ok = fs.existsSync(pinned);
    return { path: ok ? pinned : null, detail: `CHROME_PATH=${pinned} (${ok ? "present" : "MISSING"})` };
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || "/root", ".cache", "ms-playwright");
  try {
    const hits = fs
      .readdirSync(root)
      .filter((d) => /^chromium(-headless-shell)?-\d+$/.test(d))
      .sort()
      .reverse();
    for (const dir of hits) {
      for (const rel of [path.join(dir, "chrome-linux", "chrome"), path.join(dir, "chrome-linux", "headless_shell")]) {
        const full = path.join(root, rel);
        if (fs.existsSync(full)) return { path: full, detail: `Playwright Chromium at ${full}` };
      }
    }
  } catch {
    /* nothing readable there — fall through */
  }
  const sys = findSystemChromium();
  if (sys) return { path: sys, detail: `system Chromium at ${sys}` };
  return { path: null, detail: `no Chromium found under ${root} — the image must run \`node node_modules/playwright-core/cli.js install chromium\` at build time` };
}
