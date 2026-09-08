import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext, RELEASE } from "clearcote";
import type { BrowserContext, Page } from "playwright-core";
import { cgroupMemoryMb, env, stealth, driverInfo, START_URLS, v8HeapMb, type PlatformKey } from "./config.js";
import { PROTOCOL_VERSION, type RemoteCmd, type ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { checkUploadAccess } from "./uploads.js";
import { asHumanPage, humanTap, humanType, jitter, readingPause, sleep, thinkingPause } from "./human.js";
import { describePlan, planSessionCookies } from "./sessionCookie.js";
import { ensureHumanized, humanizeContext, isHumanized } from "./humanizeAttach.js";
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
  type ActivityPhase,
  type AimResult,
  type TapReport,
} from "./tapAim.js";

/**
 * The rig drives the **Clearcote** browser the **nodriver** way: the binary is
 * launched directly by the Clearcote SDK (no WebDriver / chromedriver layer,
 * `--enable-automation` stripped, engine-level fingerprint spoofing compiled
 * into Chromium's C++), and every input goes out as native trusted events with
 * a human motor persona (`humanize`). No vanilla Chromium is ever launched.
 */
const BASE_LAUNCH_ARGS = [
  // Container runtime needs (the sandbox/uid sandbox and /dev/shm are absent in Docker).
  "--no-sandbox",
  "--disable-dev-shm-usage",
  // ---- Memory diet. A TikTok tab is 600-900 MB in one renderer; on a small
  // container the kernel OOM-kills that renderer => "Target crashed" and the
  // dock goes dark. None of these change anything a page can observe.
  // One renderer per site-instance, not per iframe-origin (TikTok embeds
  // dozens of third-party frames; each would be its own ~50 MB process).
  "--disable-features=IsolateOrigins,site-per-process,ProcessPerSiteUpToMainFrameThreshold",
  "--renderer-process-limit=3",
  // Cap on V8's heap per renderer — see `v8HeapMb()`. Too low and a heavy page
  // aborts its own renderer ("Target crashed", no kernel OOM); too high and the
  // kernel does the same thing more quietly. Scaled to the container at launch.
  // No GPU process on Xvfb (llvmpipe is CPU anyway): saves ~80-120 MB and
  // one more process that can be OOM-killed. Software compositing stays.
  "--disable-gpu",
  // Chrome's own OOM intervention: pause/kill bloated ad frames before the
  // kernel kills the whole tab. Merged with the SDK's own feature list.
  "--enable-features=OomIntervention,MemoryPurgeOnFreeze",
];

/** The memory-diet args, sized to the container this launch happens in. */
function launchArgs(): string[] {
  return [...BASE_LAUNCH_ARGS, `--js-flags=--max-old-space-size=${v8HeapMb()}`];
}

export interface RigClient {
  send: (msg: ServerMsg) => void;
}

/** Visual-viewport metrics, in CSS px — see Rig.viewportMetrics(). */
interface PageMetrics {
  w: number;
  h: number;
  ox: number;
  oy: number;
  scale: number;
  /** Vertical scroll offset, read in the same round-trip as the sizes. */
  sy: number;
  /** True when the page could not be asked (mid-navigation) and the numbers are
   * the last known or a default: fine for aiming, useless for change-detection. */
  stale?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * "used/limit MB (N OOM kills)" from the container's cgroup, or "" when not in
 * a cgroup-limited environment. Printed next to every crash so the deploy log
 * answers "was it memory?" without guessing.
 */
export function memoryReport(): { text: string; oomKills: number | null; tight: boolean } {
  const { limit, used, oomKills } = cgroupMemoryMb();
  if (!used && !limit) return { text: "", oomKills: null, tight: false };
  const headroom = limit && used ? limit - used : null;
  const tight = headroom !== null && headroom < 400;
  const text =
    `container memory ${used ?? "?"} MB of ${limit ? `${limit} MB` : "no limit"}` +
    `, kernel OOM kill(s): ${oomKills ?? "unknown"}` +
    (headroom !== null ? `, ${headroom} MB free` : "");
  return { text, oomKills, tight };
}

/**
 * What killed a renderer, honestly. A kernel OOM kill and a V8 heap abort look
 * identical from the outside ("Target crashed") and need opposite fixes — more
 * RAM vs a bigger `--max-old-space-size` — so the log says which one the cgroup
 * counters support instead of guessing "out-of-memory" every time.
 */
function crashVerdict(mem: { text: string; oomKills: number | null; tight: boolean }): string {
  if (mem.oomKills && mem.oomKills > 0) return `the kernel OOM-killed it (${mem.text})`;
  if (mem.tight) return `memory is nearly exhausted — the kernel will kill the next big allocation (${mem.text})`;
  return (
    `NOT a kernel OOM (${mem.text || "no cgroup limit"}) — the renderer ended itself, which on a heavy page ` +
    `means V8's ${v8HeapMb()} MB heap cap; raise STEALTH_V8_HEAP_MB or give the box more memory`
  );
}

/**
 * Boot-time preflight: say exactly where the browser binary is expected and
 * whether it is there. A deploy whose image was built without the browser (or
 * whose CLEARCOTE_CACHE_DIR points elsewhere) used to fail silently at the
 * first socket — now the deploy log says so on line 5.
 */
export function browserPreflight(): { ok: boolean; detail: string } {
  if (process.env.CLEARCOTE_BINARY) {
    const ok = fs.existsSync(process.env.CLEARCOTE_BINARY);
    return { ok, detail: `CLEARCOTE_BINARY=${process.env.CLEARCOTE_BINARY} (${ok ? "present" : "MISSING"})` };
  }
  if (!stealth.cacheDir) {
    return { ok: true, detail: "no CLEARCOTE_CACHE_DIR — the SDK will use its default cache and download on first launch (slow; fine locally)" };
  }
  const base = path.join(stealth.cacheDir, RELEASE.tag);
  const verified = fs.existsSync(path.join(base, ".verified"));
  const browserDir = path.join(base, "browser");
  const hasTree = fs.existsSync(browserDir);
  const ok = verified && hasTree;
  return {
    ok,
    detail: ok
      ? `Clearcote ${RELEASE.tag} (Chromium ${RELEASE.version}) cached at ${base}`
      : `browser cache ${base} is ${!hasTree ? "missing" : "unverified"} — the image must run \`node worker/download-browser.mjs\` at build time with the same CLEARCOTE_CACHE_DIR; first launch will try to download (${(RELEASE.size / 1e6).toFixed(0)} MB) and fail if the network is blocked`,
  };
}

/**
 * Where the press should actually go (aim correction) and what it hit
 * afterwards. Both are one CDP round-trip that evaluates `tapAim` / `tapProbe`
 * in the page — see tapAim.ts for the rules. Neither may fail a tap: a probe
 * that races a navigation simply means "press where the user aimed".
 */
async function resolveTapPoint(page: Page, x: number, y: number): Promise<AimResult> {
  return page
    .evaluate(tapAim, [x, y, INTERACTIVE_SEL, MAX_NUDGE_PX, CONTAINER_VIEWPORT_RATIO] as [number, number, string, number, number])
    .catch(() => null);
}

/**
 * Press the visible control that shows `label`, searching every frame of the
 * page. This is the coordinate-free path: the deck never says "x%, y%", the page
 * itself returns the box, so the letterbox, the window size, the pixel ratio and
 * any page zoom simply cannot get in the way. It is also the only path that works
 * when the control lives inside an iframe (the login/verify screens TikTok and IG
 * sometimes put in one), because the box is offset by the frame's own position.
 *
 * Returns a human-readable verdict: this is a thing the user is told, not a log
 * line they never see.
 */
async function pressLabel(page: Page, rawLabel: string): Promise<{ ok: boolean; detail: string; toast: string; tone: "ok" | "warn" }> {
  const label = rawLabel.trim();
  if (!label) return { ok: false, detail: "no label given", toast: "Nothing to tap — no label given", tone: "warn" };
  const args = [label, INTERACTIVE_SEL, CONTAINER_VIEWPORT_RATIO, TARGET_ATTR] as [string, string, number, string];
  for (const frame of page.frames()) {
    // First pass locates it and scrolls it into view; the page settles; the
    // second pass reads the box that is actually on screen when we press.
    const first = await frame.evaluate(findLabelTarget, args).catch(() => null);
    if (!first) continue;
    await sleep(jitter(120, 260));
    const t = (await frame.evaluate(findLabelTarget, args).catch(() => null)) ?? first;
    let ox = 0;
    let oy = 0;
    if (frame !== page.mainFrame()) {
      // A frame detached between the two passes (SPA re-render) is not an error,
      // it is just not the frame we press: skip it and keep looking.
      const box = await frame
        .frameElement()
        .then((h) => h.boundingBox())
        .catch(() => null);
      if (!box) continue;
      ox = Math.round(box.x);
      oy = Math.round(box.y);
    }
    const x = Math.round(t.x + ox);
    const y = Math.round(t.y + oy);

    // Did the page ANSWER? That is the only question worth asking after a press,
    // and it is what separates "the click missed" from "the click landed and this
    // UI ignores synthetic input". Watched in the frame that holds the control.
    const before = await frame.evaluate(activityProbe, ["start"] as [ActivityPhase]).catch(() => null);
    await humanTap(page, x, y);
    await sleep(jitter(260, 460));
    const peek = before ? await frame.evaluate(activityProbe, ["peek"] as [ActivityPhase]).catch(() => null) : null;
    const where = `${t.w}x${t.h}px at (${x},${y})${frame === page.mainFrame() ? "" : " via iframe"}`;
    // No fingerprint change and no DOM churn: the trusted press was ignored.
    const answered = !before || !peek || peek.fp !== before.fp || peek.mutations > 40;
    if (answered) {
      await frame.evaluate(activityProbe, ["end"] as [ActivityPhase]).catch(() => undefined);
      return {
        ok: true,
        detail: `pressed "${label}" (${where}, ${t.clickable ? "the row itself" : "its label"}) → the page answered`,
        toast: `Tapped "${label}" (${where})`,
        tone: "ok",
      };
    }

    // Escalate: activate the very element from the DOM side. Not a trusted event,
    // so it is never the first thing tried — but it reaches a row that an
    // overlay, a hit-test-less window or a target-restricted handler will not.
    const act = await frame.evaluate(activateMarked, [TARGET_ATTR] as [string]).catch(() => null);
    await sleep(jitter(240, 420));
    const done = await frame.evaluate(activityProbe, ["end"] as [ActivityPhase]).catch(() => null);
    const escalated = !!act && !!before && !!done && (done.fp !== before.fp || done.mutations > 40);
    const via = act ? `${act.tag}${act.label ? ` "${act.label}"` : ""} · ${act.events} DOM events` : "nothing was marked";
    return {
      ok: !!escalated,
      detail:
        `pressed "${label}" (${where}) → the page ignored the pointer press, so the element was activated from the DOM (${via})` +
        `${escalated ? " → that worked" : " → and that did nothing either"}`,
      toast: escalated
        ? `Tapped "${label}" — the pointer press was ignored, the DOM click worked`
        : `"${label}" was pressed but nothing on the page moved`,
      tone: escalated ? "ok" : "warn",
    };
  }
  return {
    ok: false,
    detail: `no visible control says "${label}"`,
    toast: `Nothing on this page says "${label}" — is that screen open?`,
    tone: "warn",
  };
}

export class Rig {
  platform: PlatformKey;
  store: Store;
  clients = new Set<RigClient>();
  context: BrowserContext | null = null;
  control: Page | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private loginTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private detectBusy = false;
  private idleBusy = false;
  private lastInputAt = 0;
  private pendingCmds = 0;
  /** See exec(): queued deck commands, drained one at a time. */
  private cmdQueue: { cmd: RemoteCmd; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private draining = false;
  /** In-flight launch (deduped: N sockets connecting at once = one browser). */
  private launching: Promise<BrowserContext> | null = null;
  /** Last fatal browser error, replayed to every socket that connects while
   * the browser is down — so the deck never sits on "waiting for first frame"
   * after a reconnect swallowed the original error. */
  private lastFatal: string | null = null;
  /** Raw CDP session used for screenshots (no Playwright screenshot pipeline:
   * that one waits for fonts/animations and can stall for minutes on a busy
   * page — the deck saw nothing for hours). */
  private shotSession: import("playwright-core").CDPSession | null = null;
  private shotBusy = false;
  private frameFailures = 0;
  private framesSent = 0;
  /** Last main-frame URL of the control tab (so a crashed tab reopens where it was). */
  private lastUrl = "";
  private crashes = 0;
  private recovering = false;
  /**
   * "Tap the verification method for me." The code/identity screen is the one
   * place a login stalls forever when a press does not land — a list of bare
   * <div> rows, each 62px tall, on a phone. So the deck can hand that screen
   * over entirely: the worker finds the row by its label and presses it, once
   * per screen, and only while a socket is connected (nothing taps the user's
   * account when nobody is watching).
   */
  private autoVerify = { on: false, label: "Email", sig: "", pressed: false, tries: 0 };
  /** How many looks in a row said "signed out" — see `detectLogin`. */
  private signedOutStreak = 0;
  /**
   * Set while the worker drives the *visible* tab itself (a manual publish). The
   * ambient loops stand down and login detection pauses for the duration: a page
   * mid-navigation has no avatar bar, and reading that as "signed out" is how a
   * publish disarmed its own engine.
   */
  private driving = false;
  /** The screen signature we last acted on, so one modal = at most a few presses. */

  constructor(platform: PlatformKey, store: Store) {
    this.platform = platform;
    this.store = store;
  }

  profileDir(): string {
    const dir = path.join(env.dataDir, `profile-${this.platform}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  broadcast(msg: ServerMsg) {
    for (const c of this.clients) {
      try {
        c.send(msg);
      } catch {
        /* drop dead sockets */
      }
    }
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launchContext().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /**
   * A profile carries Chromium's Singleton{Lock,Socket,Cookie} symlinks. On a
   * persistent volume they survive a crash/redeploy, and because they name the
   * OLD container's hostname, Chromium decides "the profile is in use on
   * another computer" and exits instead of starting. Always clear them: this
   * process is the only user of this profile.
   */
  private clearStaleLocks(profile: string) {
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        fs.rmSync(path.join(profile, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Chromium processes still holding this profile that are not ours.
   *
   * Only ever run with no live context, and matched on the profile path — no
   * other process on the box has that string in its command line, which is what
   * makes it safe to SIGKILL from here. Without this, one bad crash recovery can
   * leave a browser alive while the worker launches another on the same profile,
   * and the box spends the rest of its life OOMing itself.
   */
  private reapStrayBrowsers(profile: string): number {
    if (this.context || this.launching) return 0;
    let killed = 0;
    try {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        let cmd = "";
        try {
          cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch {
          continue; // it exited while we looked
        }
        if (!cmd.includes(profile)) continue;
        if (!/chrome|chromium|clearcote|headless_shell|zygote/i.test(cmd)) continue;
        try {
          process.kill(pid, "SIGKILL");
          killed++;
        } catch {
          /* already gone */
        }
      }
    } catch {
      return 0; // no /proc (a mac dev box): nothing to reap
    }
    return killed;
  }

  private async launchContext(): Promise<BrowserContext> {
    const profile = this.profileDir();
    const strays = this.reapStrayBrowsers(profile);
    if (strays) {
      this.status(`Reaping ${strays} orphaned browser process(es) still holding this profile…`);
      await sleep(600); // let the kernel finish releasing them before the next 600 MB
    }
    this.clearStaleLocks(profile);
    this.lastFatal = null;
    this.status(`Launching the Clearcote browser (${stealth.headless ? "headless" : "headed on Xvfb"}, ${stealth.platform} persona)…`);
    console.log(
      `[${this.platform}] launching Clearcote browser (persona: ${stealth.platform}, humanized input: ${stealth.humanize ? "on" : "off"}, light stealth: ${stealth.lightStealth ? "on" : "off"}, profile: ${profile})`
    );
    const t0 = Date.now();
    try {
      this.context = await launchPersistentContext(profile, {
        headless: stealth.headless,
        // Generous first-launch budget: a cold Railway volume + first profile
        // creation can exceed Playwright's default 30 s wait for the browser.
        timeout: 120_000,
        // NOTE: no explicit viewport — on a headed window the SDK forces
        // viewport: null (an emulated viewport on a real window is a tell);
        // when headless, the SDK fits window/screen geometry itself.
        ...(stealth.headless ? { viewport: { width: 1280, height: 900 } } : {}),
        locale: "en-US",
        timezoneId: stealth.timezone,
        args: launchArgs(),
        // Clearcote persona: one coherent, seed-stable machine identity per platform.
        fingerprint: stealth.seed(this.platform),
        platform: stealth.platform,
        lightStealth: stealth.lightStealth,
        timezone: stealth.timezone,
        acceptLanguage: stealth.acceptLanguage,
        // nodriver-style human input: trusted native events, motor persona, typos.
        humanize: stealth.humanize,
        showCursor: stealth.showCursor,
        // Where the verified binary lives (pre-downloaded in Docker builds).
        cacheDir: stealth.cacheDir,
        version: stealth.browserVersion,
        // Containers lack CAP_SYS_NICE: setpriority() returns EPERM, and the
        // Clearcote DCHECK build fatals on it. The shim (built into the
        // Docker image) makes it a harmless no-op, like release Chromium.
        ...(stealth.niceShim && fs.existsSync(stealth.niceShim)
          ? { env: { LD_PRELOAD: stealth.niceShim } }
          : {}),
      });
      this.control = null;
      // The SDK skips its own humanize install on persistent contexts
      // (context.browser() is null there) — see humanizeAttach.ts. Attach it
      // ourselves so every page really gets humanized, trusted input.
      humanizeContext(this.context, this.humanizeOpts());
      const mem = memoryReport();
      this.status(
        `Browser up in ${Math.round((Date.now() - t0) / 100) / 10}s — opening ${START_URLS[this.platform]} ` +
          `(V8 heap ${v8HeapMb()} MB per renderer${mem.text ? `, ${mem.text}` : ""})`
      );
      // If the browser dies later (OOM kill, crash), drop everything so the
      // next connect relaunches instead of screenshotting a corpse forever.
      this.context.on("close", () => {
        console.error(`[${this.platform}] browser closed unexpectedly — will relaunch on next connect`);
        this.lastFatal = "The browser process exited (crash or out-of-memory). Reconnecting will relaunch it.";
        this.broadcast({ type: "error", message: `Browser exited: ${this.lastFatal}` });
        this.teardown();
      });
      return this.context;
    } catch (err) {
      const raw = (err as Error).message || String(err);
      console.error(`[${this.platform}] Clearcote browser start failed: ${raw}`);
      let friendly: string;
      if (!stealth.headless && !process.env.DISPLAY) {
        friendly = `Headed mode needs a display — none is available (set STEALTH_HEADLESS=true or run under Xvfb). Underlying error: ${raw}`;
      } else if (/no build for|not (exist|found)/i.test(raw)) {
        friendly = `Clearcote browser unavailable: ${raw} — check CLEARCOTE_CACHE_DIR and rebuild the image (the browser is pre-downloaded at build time).`;
      } else if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(raw)) {
        friendly = `The Clearcote browser binary is not in the cache and could not be downloaded (${raw}). The Docker image pre-downloads it at build time into CLEARCOTE_CACHE_DIR — make sure the build ran \`node worker/download-browser.mjs\` and that CLEARCOTE_CACHE_DIR points at that directory at runtime.`;
      } else if (/Timeout .*exceeded|timed out/i.test(raw)) {
        friendly = `Clearcote browser did not come up within the launch timeout: ${raw} — the container is probably starved (Railway free/hobby CPU + a 150 MB Chromium). Give the service more resources or set STEALTH_HEADLESS=true.`;
      } else if (/SIGKILL|Target closed|browser has been closed/i.test(raw)) {
        friendly = `The browser process was killed right after start: ${raw} — almost always out-of-memory. Raise the service memory (Chromium wants ≥1 GB) or set STEALTH_HEADLESS=true.`;
      } else {
        friendly = `Clearcote launch failed: ${raw} — typical causes: missing Chromium runtime libs (compare with the Dockerfile apt list), no display in headed mode, or a damaged browser cache (delete it and relaunch to re-download).`;
      }
      this.lastFatal = friendly;
      throw new Error(friendly);
    }
  }

  private humanizeOpts() {
    return { humanize: stealth.humanize, showCursor: stealth.showCursor, seed: stealth.seed(this.platform) };
  }

  /**
   * Live page metrics for input mapping: the VISUAL viewport (what the streamed
   * screenshot actually shows) and its offset from the layout viewport origin
   * (page zoom), in CSS px.
   *
   * Read fresh on every input — a window resize or a focus-zoom must not leave
   * the next press at stale coordinates — and on failure (mid-navigation,
   * target swap) fall back to the last good reading rather than a guessed
   * 1280x900, which is what made taps drift into the wrong third of the page
   * whenever a press raced a navigation.
   */
  private lastVp: PageMetrics | null = null;
  private async viewportMetrics(page: Page): Promise<PageMetrics> {
    for (let tries = 0; tries < 3; tries++) {
      const m = await page
        .evaluate(() => {
          // At page zoom `s` the visual viewport (what the screenshot shows)
          // covers innerWidth/s of layout CSS px, starting at its offset. At the
          // default s=1 that is exactly innerWidth/innerHeight — including the
          // classic scrollbar gutter, which the capture has and
          // `visualViewport.width` does not.
          const vv = window.visualViewport;
          const scale = vv?.scale || 1;
          return {
            w: Math.round((window.innerWidth || vv?.width || 1280) / scale),
            h: Math.round((window.innerHeight || vv?.height || 900) / scale),
            ox: Math.round(vv?.offsetLeft || 0),
            oy: Math.round(vv?.offsetTop || 0),
            scale,
            sy: Math.round(window.scrollY),
          } satisfies PageMetrics;
        })
        .catch(() => undefined);
      if (m && m.w > 1 && m.h > 1) {
        this.lastVp = m;
        return m;
      }
      await sleep(150); // off-protocol: a CDP round-trip per retry would itself be a tell
    }
    return (
      this.lastVp ?? {
        w: page.viewportSize()?.width ?? 1280,
        h: page.viewportSize()?.height ?? 900,
        ox: 0,
        oy: 0,
        scale: 1,
        sy: 0,
        stale: true,
      }
    );
  }

  /** Deck-visible progress line (also in the deploy log). */
  private status(text: string) {
    console.log(`[${this.platform}] ${text}`);
    this.broadcast({ type: "log", level: "info", text, at: Date.now() });
  }

  /**
   * Replace a crashed control tab with a fresh one at the same URL. Playwright
   * marks a crashed page permanently dead (every call throws "Target
   * crashed"), so the old page is closed and a new one takes over. Commands
   * queued meanwhile wait on `recovering` rather than failing.
   */
  private async recoverFromCrash(dead: Page, url: string) {
    if (this.recovering) return;
    this.recovering = true;
    this.shotSession = null;
    if (this.control === dead) this.control = null;
    try {
      await dead.close().catch(() => undefined);
      const ctx = this.context;
      if (!ctx) return;
      // Back off a little if it keeps dying: the 3rd crash in a row on the
      // same page is not a fluke, and hammering it just thrashes memory.
      if (this.crashes >= 3) await sleep(4000);
      const page = await ctx.newPage();
      await ensureHumanized(page, this.humanizeOpts());
      this.wireControlPage(page);
      this.control = page;
      void this.pushFrame();
      const target = this.crashes >= 3 && this.platform === "tiktok" ? START_URLS.tiktok : url;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      this.status(`Tab reopened after crash #${this.crashes} at ${target}`);
    } catch (e) {
      console.error(`[${this.platform}] tab recovery failed: ${(e as Error).message}`);
      this.broadcast({ type: "error", message: `Tab crashed and could not be reopened: ${(e as Error).message}. Reconnect to relaunch the browser.` });
      this.teardown();
    } finally {
      this.recovering = false;
    }
  }

  /**
   * Forget the dead browser without touching sockets — and take it down with us.
   *
   * Dropping the reference alone is how a "crash" turns into a spiral: the next
   * `ensureContext()` deletes the profile's SingletonLock and launches a *second*
   * Chromium on the same profile dir, so memory doubles, the two trees fight over
   * the profile, and every page starts dying. The close is best-effort and not
   * waited on — if the process is already gone it throws, and the reaper in
   * `launchContext` cleans up whatever is left.
   */
  private teardown() {
    this.stopLoops();
    this.shotSession = null;
    const orphan = this.context;
    this.context = null;
    this.control = null;
    if (orphan) void orphan.close({ reason: "worker dropped this browser" }).catch(() => undefined);
  }

  /**
   * Called for every socket that authenticates. Idempotent: if the browser is
   * already up it just makes sure frames are flowing to the new client; if a
   * launch is in progress it joins it; if the last launch failed it replays
   * the error to THIS socket and retries the launch (nothing else would).
   */
  async openControlSession(): Promise<Page> {
    if (this.control && !this.control.isClosed()) {
      this.startLoops();
      void this.pushFrame(); // don't make a reconnecting deck wait a full interval
      return this.control;
    }
    if (this.lastFatal) {
      this.broadcast({ type: "error", message: `Browser start failed: ${this.lastFatal} — retrying…` });
    }
    const ctx = await this.ensureContext();
    if (this.control && !this.control.isClosed()) return this.control; // raced with a parallel connect
    // Reuse the page Chromium opens with the profile instead of adding a
    // second one: a persistent context always starts with one (about:blank)
    // tab, and a headed extra window on Xvfb only slows the first paint.
    const existing = ctx.pages()[0];
    const page = existing && !existing.isClosed() ? existing : await ctx.newPage();
    this.control = page;
    const humanized = await ensureHumanized(page, this.humanizeOpts());
    console.log(`[${this.platform}] control tab input: ${humanized ? "Clearcote humanized (trusted, persona-driven)" : "PLAIN PLAYWRIGHT — humanize wrapper not active"}`);
    this.wireControlPage(page);
    this.broadcast({
      type: "ready",
      sessionId: `rig-${this.platform}`,
      url: START_URLS[this.platform],
      driver: driverInfo(),
      // `proto` again, because this second `ready` overwrites the first in the
      // deck: leave it out and a current worker is reported as "older than this
      // deck" the moment its tab opens.
      proto: PROTOCOL_VERSION,
    });
    // Frames FIRST — the deck must see the tab (even blank) while the site
    // loads; a slow/blocked TikTok load used to look identical to a dead worker.
    this.startLoops();
    void this.pushFrame();
    try {
      await page.goto(START_URLS[this.platform], { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      console.warn(`[${this.platform}] first navigation did not settle: ${(e as Error).message}`);
      /* page may be mid-challenge or slow; frames still stream */
    }
    return page;
  }

  /** Event wiring shared by the first control tab and any crash-replacement tab. */
  private wireControlPage(page: Page) {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      this.broadcast({ type: "nav", url, title: url });
      void this.detectLogin();
    });
    page.on("close", () => {
      if (this.control === page) this.control = null;
      this.shotSession = null;
    });
    // The renderer died (OOM kill / SIGSEGV). The browser itself is fine —
    // open a fresh tab at the same URL instead of failing every command with
    // "Target crashed" until someone restarts the service.
    page.on("crash", () => {
      const url = this.lastUrl || START_URLS[this.platform];
      const mem = memoryReport();
      const why = crashVerdict(mem);
      console.error(`[${this.platform}] TAB CRASHED (renderer killed) at ${url} — ${why}`);
      this.broadcast({
        type: "log",
        level: "warn",
        text: `⚠️ The ${this.platform} tab crashed at ${url.replace(/^https:\/\//, "").slice(0, 48)} — ${why}. Reopening it…`,
        at: Date.now(),
      });
      this.crashes += 1;
      void this.recoverFromCrash(page, url);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.lastUrl = frame.url();
    });
  }

  /**
   * Wait for a crashed tab to be replaced (or make one if nothing will). A
   * publish that lost its page mid-flight is recoverable — the video is already
   * downloaded — but only if it waits for the reopen instead of failing on the
   * dead target.
   */
  async waitForRecovery(maxMs = 25_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (!this.recovering && this.control && !this.control.isClosed()) return true;
      await sleep(400);
    }
    if (this.control && !this.control.isClosed()) return true;
    try {
      await this.openControlSession();
      return !!this.control && !this.control.isClosed();
    } catch {
      return false;
    }
  }

  async newEnginePage(): Promise<Page> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    await ensureHumanized(page, this.humanizeOpts());
    return page;
  }

  private startLoops() {
    if (!this.frameTimer) {
      this.frameTimer = setInterval(() => void this.pushFrame(), Math.max(400, env.frameIntervalMs));
    }
    if (!this.loginTimer) {
      this.loginTimer = setInterval(() => void this.tick(), 5000);
    }
    // Idle drift: a parked, perfectly still session is a bot tell. Small
    // ambient cursor motion + the occasional micro-scroll keep the account
    // looking lived-in between deck commands.
    if (!this.idleTimer && stealth.idleDrift) {
      this.idleTimer = setInterval(() => void this.idleDrift(), 60_000);
    }
  }

  stopLoops() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.loginTimer) {
      clearInterval(this.loginTimer);
      this.loginTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async idleDrift() {
    const page = this.control;
    if (!page || page.isClosed() || this.idleBusy || this.detectBusy) return;
    if (this.driving) return; // the worker is driving this tab; a stray wheel could cost a publish
    if (this.pendingCmds > 0) return; // never drift while commands are in flight
    if (Date.now() - this.lastInputAt < 45_000) return;
    this.idleBusy = true;
    try {
      // Drift shares the cursor with the deck — same lock, same one-at-a-time
      // guarantee, or the two glides overwrite each other's tracked position.
      await this.withInput(async () => {
        // A command queued while we were waiting for the lock outranks us:
        // the human is back, drop this drift round entirely.
        if (this.cmdQueue.length > 0) return;
        const hp = asHumanPage(page);
        // Ambient motion never clicks and never scrolls — pure pointer entropy.
        await hp.ambientMotion?.(Math.round(jitter(700, 1600)));
        if (Math.random() < 0.3) {
          // A tiny, human-scaled scroll — like a thumb resting on the feed.
          const dy = Math.round(jitter(50, 140)) * (Math.random() < 0.2 ? -1 : 1);
          await page.mouse.wheel(0, dy);
          await sleep(jitter(200, 700));
        }
      });
    } catch {
      /* best-effort ambient behavior */
    } finally {
      this.idleBusy = false;
    }
  }

  /**
   * One frame to every client. Uses a raw CDP `Page.captureScreenshot`
   * instead of Playwright's `page.screenshot()`: the latter serialises through
   * a task queue and waits for fonts, animations and a stable layout — on a
   * heavy, still-loading TikTok/YouTube page that can block for minutes, and
   * a timer that keeps stacking blocked screenshots never delivers anything.
   * The CDP call returns whatever is on screen right now, in ~20-60 ms.
   */
  private async pushFrame() {
    const page = this.control;
    if (this.clients.size === 0 || !page || page.isClosed() || this.shotBusy) return;
    this.shotBusy = true;
    try {
      if (!this.shotSession) {
        this.shotSession = await page.context().newCDPSession(page);
        await this.shotSession.send("Page.enable").catch(() => undefined);
      }
      const { data } = await this.shotSession.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 52,
        fromSurface: true,
        optimizeForSpeed: true,
      });
      this.broadcast({ type: "frame", data, at: Date.now() });
      this.frameFailures = 0;
      if (this.framesSent++ === 0) console.log(`[${this.platform}] first frame streamed to the deck`);
    } catch (e) {
      // Navigation in flight / target swapped: drop the session and rebuild
      // it next tick. Keep the noise out of the log unless it persists.
      this.shotSession = null;
      this.frameFailures += 1;
      if (this.frameFailures === 5 || this.frameFailures % 50 === 0) {
        console.warn(`[${this.platform}] ${this.frameFailures} consecutive frame captures failed: ${(e as Error).message}`);
      }
    } finally {
      this.shotBusy = false;
    }
  }

  /** 5 s heartbeat: has the login state changed, and is a verification screen up? */
  private async tick() {
    await this.detectLogin();
    await this.maybeAutoVerify();
  }

  /**
   * If the deck armed auto-tap and a "verify it's really you" / choose-a-method
   * screen is on screen, press the requested method. Deliberately bounded: three
   * presses per screen then silence, because a modal that ignores three presses
   * is not an aiming problem, and hammering a login endpoint is how accounts get
   * flagged.
   */
  private async maybeAutoVerify(): Promise<void> {
    const page = this.control;
    if (!this.autoVerify.on || !page || page.isClosed() || this.recovering || this.detectBusy) return;
    if (this.clients.size === 0) return; // never act on an account nobody is watching
    if (this.pendingCmds > 0) return; // a deck command outranks automation, always
    const sig = await page
      .evaluate(() => {
        const t = (document.body?.innerText || "").replace(/\s+/g, " ");
        const head = /verify it'?s really you|verify your identity|choose a(?: verification)? method|how should we verify/i.exec(t);
        if (!head) return "";
        const low = t.toLowerCase();
        const methods = ["email", "password", "sms", "text message", "passkey", "security key", "qr code"].filter((k) => low.includes(k));
        return `${head[0].toLowerCase()}|${methods.join(",")}`;
      })
      .catch(() => "");
    if (!sig) {
      this.autoVerify.sig = "";
      this.autoVerify.pressed = false;
      this.autoVerify.tries = 0; // screen gone — re-arm for the next one
      return;
    }
    if (this.autoVerify.sig !== sig) {
      this.autoVerify.sig = sig; // a different modal (or the methods changed): fresh budget
      this.autoVerify.pressed = false;
      this.autoVerify.tries = 0;
    }
    // One press per screen. A second press on the same row is not a retry, it is
    // a "resend the code" — which rate-limits the endpoint and, on TikTok, can
    // push the account into another challenge. Only a screen where the row was
    // never found gets looked at again.
    if (this.autoVerify.pressed || this.autoVerify.tries >= 3) return;
    this.autoVerify.tries += 1;
    const label = this.autoVerify.label;
    // Same input lock as a deck command: two glides on one page would overwrite
    // each other's tracked cursor position and the press would land elsewhere.
    const r = await this.withInput(() => pressLabel(page, label));
    if (r.ok) this.autoVerify.pressed = true;
    const n = this.autoVerify.tries;
    console.log(`[${this.platform}] auto-tap #${n}: ${r.detail}`);
    this.broadcast({ type: "log", level: r.ok ? "ok" : "warn", text: `${r.ok ? "✅" : "⚠️"} Auto-tap ${label}: ${r.detail}`, at: Date.now() });
    this.broadcast({ type: "toast", text: r.ok ? `Auto-tapped "${label}" — take it from here` : r.toast, tone: r.tone });
  }

  /** Best-effort "am I signed in" detection. Engines pause until this is true. */
  async detectLogin(): Promise<boolean> {
    const page = this.control;
    if (!page || page.isClosed() || this.detectBusy) return this.store.rig(this.platform).loggedIn;
    // A publish navigating the visible tab to /upload is not evidence about the
    // session. Hold the last answer until the tab is ours again.
    if (this.driving) return this.store.rig(this.platform).loggedIn;
    this.detectBusy = true;
    try {
      let logged = false;
      // "The avatar is missing" is weak evidence — it is missing while a page
      // hydrates, on a watch page, and on a tab that just restarted. A URL that is
      // the login wall is not. So the negative has to survive a few consecutive
      // looks before it is allowed to disarm the engine (see the streak below).
      const atLoginWall = await page
        .evaluate(() => /login|passport|\/accounts\/|ServiceLogin|signin|challenge/i.test(location.href))
        .catch(() => false);
      if (this.platform === "tiktok") {
        logged = await page.evaluate(() => {
          const u = location.href;
          if (u.includes("login") || u.includes("passport")) return false;
          return !!(
            document.querySelector(
              '[data-e2e="profile-icon"], [data-e2e="user-avatar"], a[data-e2e="user-avatar"], [data-e2e="upload-icon"]'
            ) ||
            (u.includes("/foryou") && !document.querySelector('[data-e2e="top-login-button"]'))
          );
        });
      } else if (this.platform === "instagram") {
        logged = await page.evaluate(() => {
          const u = location.href;
          if (u.includes("/accounts/login")) return false;
          return (
            !!document.querySelector(
              'a[href*="/direct/inbox/"], svg[aria-label="Home"], svg[aria-label="New post"], svg[aria-label="Search"]'
            ) || (!!document.querySelector("main") && !document.body.innerText.includes("Log in"))
          );
        });
      } else {
        // YouTube: signed in only when an avatar chip is present and no
        // top-bar “Sign in” entry remains.
        logged = await page.evaluate(() => {
          const u = location.href;
          if (/accounts\.google\.com|ServiceLogin|signin/i.test(u)) return false;
          const signedOut =
            !!document.querySelector(
              'a[aria-label="Sign in"], ytd-button-renderer a[href*="/signin"], a[href*="accounts.google.com"]'
            );
          if (signedOut) return false;
          return !!document.querySelector(
            "button#avatar-btn, a#avatar-btn, a[href^='/channel/'], img[src*='yt3.googleusercontent.com']"
          );
        });
      }
      const rig = this.store.rig(this.platform);
      const prev = rig.loggedIn;
      if (logged) {
        this.signedOutStreak = 0;
        if (!prev) {
          this.store.setLoggedIn(this.platform, true);
          this.broadcast({ type: "login", loggedIn: true });
          this.broadcast({ type: "log", level: "ok", text: `✅ Signed in detected on ${this.platform} — the engine may act.`, at: Date.now() });
        }
      } else if (atLoginWall || this.signedOutStreak >= 2) {
        this.signedOutStreak = 0;
        if (prev) {
          this.store.setLoggedIn(this.platform, false);
          this.broadcast({ type: "login", loggedIn: false });
          // A pasted session that dies within minutes of being installed is almost
          // never "the user logged out": the site ended it because the browser it
          // arrived in does not look like the browser it left. Say that, because
          // the alternative reading is "your cookie is wrong" and it is not.
          const freshCookie = rig.cookieAt && Date.now() - rig.cookieAt < 30 * 60_000;
          const text = freshCookie
            ? `⚠️ ${this.platform} ended the pasted session after it saw this browser. Re-paste it from a signed-in tab, or log in by hand once in this tab — a fresh login here is the profile the site already trusts.`
            : `Signed-out state on ${this.platform} — log in to arm the engine.`;
          this.broadcast({ type: "log", level: "warn", text, at: Date.now() });
          if (freshCookie) this.broadcast({ type: "toast", text: "The site ended the pasted session — paste it again or log in by hand", tone: "warn" });
        }
      } else {
        this.signedOutStreak += 1;
        if (prev) {
          this.broadcast({
            type: "log",
            level: "info",
            text: `Signed-in state uncertain on ${this.platform} (look ${this.signedOutStreak + 1}/3) — holding the engine until it is confirmed.`,
            at: Date.now(),
          });
        }
      }
      return logged;
    } catch {
      return this.store.rig(this.platform).loggedIn;
    } finally {
      this.detectBusy = false;
    }
  }

  /**
   * Run `fn` on the tab the deck is streaming, holding the input lock so the
   * user's own clicks queue politely behind it, and returning false when there is
   * no such tab (the caller then uses its own hidden one).
   *
   * This exists because a manual publish used to run in an invisible second tab:
   * the deck kept showing the For You page, the studio never appeared on screen,
   * and "I pressed Post and nothing happened" was a completely fair reading of
   * what the user could see. Watching it open the source, hand the file to the
   * studio and hit Post is both the reassurance and the debugging tool.
   */
  async withVisibleTab<T>(fn: (page: Page) => Promise<T>): Promise<{ ran: boolean; value?: T }> {
    const page = this.control;
    if (!page || page.isClosed() || this.driving || this.recovering) return { ran: false };
    this.driving = true;
    try {
      const value = await this.withInput(() => fn(page));
      return { ran: true, value };
    } finally {
      this.driving = false;
    }
  }

  /** What the deck's cookie panel should show: names and a date, never a value. */
  cookieState(): { appliedAt: number | null; names: string[]; expiresAt: number | null } {
    const r = this.store.rig(this.platform);
    return { appliedAt: r.cookieAt ?? null, names: r.cookieNames ?? [], expiresAt: r.cookieExpiresAt ?? null };
  }

  broadcastCookieState() {
    this.broadcast({ type: "cookie-state", ...this.cookieState() });
  }

  /**
   * Sign the profile in with a session cookie pasted into the deck — the way in
   * when clicking through the site's own login wall inside a streamed screenshot
   * refuses to behave. The cookie is written to the persistent *profile*, which is
   * what both the manual tab and every engine run already share, so one paste
   * covers all of it and survives a worker restart.
   *
   * It does not start anything. A signed-in profile only enables the deck's Start
   * button; the engine arms on that press and on nothing else, and this method
   * never calls into it. The pasted value is never stored, logged or broadcast:
   * `detail` and the toast speak in cookie names and dates only.
   */
  async applySessionCookie(raw: string): Promise<{ ok: boolean; detail: string }> {
    const plan = planSessionCookies(this.platform, raw);
    if (!plan.ok) {
      this.broadcast({ type: "log", level: "warn", text: `⚠️ Session cookie not applied: ${plan.detail}`, at: Date.now() });
      this.broadcast({ type: "toast", text: "That is not a session cookie", tone: "warn" });
      return { ok: false, detail: plan.detail };
    }
    try {
      const ctx = await this.ensureContext();
      await ctx.addCookies(
        plan.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }))
      );
      this.store.setCookie(this.platform, Date.now(), plan.names, plan.expiresAt);
      this.broadcastCookieState();
      this.broadcast({ type: "log", level: "info", text: `Session cookie installed — ${plan.detail}`, at: Date.now() });

      // Reload through the command queue, so installing a session can never yank
      // the page out from under a click that is mid-flight. If the tab is still
      // coming up because the deck only just connected, wait for that instead of
      // racing it with a second navigation of the same page.
      for (let i = 0; i < 40 && (!this.control || this.control.isClosed()); i++) await sleep(250);
      if (this.control && !this.control.isClosed()) await this.exec({ t: "navigate", url: START_URLS[this.platform] });
      else await this.openControlSession();

      let logged = false;
      for (let i = 0; i < 10 && !logged; i++) {
        await sleep(800); // sites decide "am I known" a beat after first paint
        logged = await this.detectLogin();
      }
      const detail = logged
        ? `Signed in on ${this.platform} — ${describePlan(plan)}. Nothing posts until you press Start.`
        : `${plan.detail} — installed, but the site still says signed out. An expired cookie, or one from another account?`;
      this.broadcast({ type: "log", level: logged ? "ok" : "warn", text: `${logged ? "✅" : "⚠️"} ${detail}`, at: Date.now() });
      this.broadcast({
        type: "toast",
        text: logged ? "Signed in with your cookie — press Start when you want the engine to run" : "Cookie set, but the site still shows you signed out",
        tone: logged ? "ok" : "warn",
      });
      return { ok: logged, detail };
    } catch (e) {
      const detail = `could not write cookies: ${(e as Error).message}`;
      this.broadcast({ type: "log", level: "err", text: `⚠️ ${detail}`, at: Date.now() });
      this.broadcast({ type: "toast", text: "The browser refused the cookie", tone: "warn" });
      return { ok: false, detail };
    }
  }

  /**
   * Empty this profile's cookie jar. Honest about what that means: it removes the
   * pasted session *and* the device ids the site uses to trust the browser, so the
   * next manual login may be asked to verify itself again.
   */
  async clearSessionCookies(): Promise<{ ok: boolean; detail: string }> {
    // Only the live profile can have its jar emptied (Playwright owns it), and
    // launching a browser just to clear cookies would look like a hang.
    if (!this.context) {
      this.broadcast({ type: "toast", text: "No browser running — open the live session to clear it", tone: "info" });
      return { ok: false, detail: "no browser context to clear" };
    }
    try {
      await this.context.clearCookies();
      this.store.setCookie(this.platform, null, [], null);
      this.broadcastCookieState();
      if (this.control && !this.control.isClosed()) {
        await this.exec({ t: "navigate", url: START_URLS[this.platform] });
        await sleep(1200);
        await this.detectLogin();
      }
      this.broadcast({ type: "log", level: "info", text: "Cookies cleared from this profile — engine paused until you sign in again.", at: Date.now() });
      this.broadcast({ type: "toast", text: "Signed out of this profile", tone: "info" });
      return { ok: true, detail: "cookie jar emptied" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /**
   * All deck commands (tap/scroll/type/key/navigate) run strictly one at a
   * time. The humanized cursor is a single shared resource: two concurrent
   * glides interleave native mouse moves and presses land in the wrong place.
   * Consecutive scrolls are coalesced (a drag sends dozens of tiny deltas) so
   * drag-scrolling stays fluid without breaking the one-at-a-time guarantee.
   */
  exec(cmd: RemoteCmd): Promise<void> {
    const last = this.cmdQueue[this.cmdQueue.length - 1];
    if (cmd.t === "scroll" && last && last.cmd.t === "scroll") {
      last.cmd.dy += cmd.dy; // merge into the queued scroll
      return Promise.resolve();
    }
    this.pendingCmds += 1;
    return new Promise<void>((resolve, reject) => {
      this.cmdQueue.push({ cmd, resolve, reject });
      void this.drain();
    }).finally(() => {
      this.pendingCmds -= 1;
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.cmdQueue.length > 0) {
        const item = this.cmdQueue.shift()!;
        try {
          await this.withInput(() => this.execInner(item.cmd));
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * One cursor per page, and everything that moves it shares this FIFO lock.
   *
   * Clearcote's humanize wrapper tracks a single position per page and re-pins
   * `mouse.down()` to *that* before pressing. So two interleaved inputs do not
   * merely look robotic — they overwrite each other's tracked position, and the
   * press fires wherever the OTHER glide last was. The one that can hit you
   * without any second caller is the idle drift: it starts on a timer, glides
   * for up to ~1.6 s, and its wheel even re-anchors the cursor mid-glide. A
   * drift that begins 20 ms before your tap = a trusted, humanized, perfectly
   * formed click on `<body>` instead of the Password row.
   */
  private inputTail: Promise<unknown> = Promise.resolve();
  private withInput<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inputTail.then(fn, fn);
    this.inputTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async execInner(cmd: RemoteCmd): Promise<void> {
    // A crashed tab is being replaced: hold the command briefly instead of
    // failing it with "Target crashed".
    for (let i = 0; i < 40 && (this.recovering || (!this.control && this.context)); i++) await sleep(250);
    const page = this.control;
    if (!page || page.isClosed()) throw new Error("Control page not open");
    this.lastInputAt = Date.now();
    switch (cmd.t) {
      case "ping":
        return;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        return;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        return;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        return;
      case "home":
        await page.goto(START_URLS[this.platform], { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        return;
      case "navigate":
        await thinkingPause(300, 900);
        await page.goto(cmd.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        return;
      case "check-upload": {
        // Ten seconds of truth instead of a 40-second publish that ends in a log
        // line: does the site let this session upload at all?
        const r = await checkUploadAccess(this.platform, page, (t) => this.status(t));
        this.broadcast({
          type: "log",
          level: r.ok ? "ok" : "warn",
          text: `${r.ok ? "✅" : "⚠️"} Upload access: ${r.verdict}`,
          at: Date.now(),
        });
        this.broadcast({
          type: "toast",
          text: r.ok
            ? "This session can post — the studio opened and took the file picker"
            : "TikTok/site is not letting this session post — see the log",
          tone: r.ok ? "ok" : "warn",
        });
        return;
      }
      case "click-label": {
        // The deck's "tap the Email option" button: locate by visible text, press
        // its centre. No fraction, no letterbox, no pixel ratio, no zoom.
        const r = await pressLabel(page, cmd.label);
        console.log(`[${this.platform}] click-label ${JSON.stringify(cmd.label)} → ${r.detail}`);
        this.broadcast({ type: "log", level: r.ok ? "ok" : "warn", text: `${r.ok ? "✅" : "⚠️"} ${r.detail}`, at: Date.now() });
        this.broadcast({ type: "toast", text: r.ok ? `Tapped "${cmd.label.trim()}"` : r.toast, tone: r.tone });
        return;
      }
      case "auto-verify": {
        this.autoVerify.on = !!cmd.on;
        const label = (cmd.label || "").trim();
        if (label) this.autoVerify.label = label;
        if (!cmd.on) {
          this.autoVerify.sig = "";
          this.autoVerify.pressed = false;
          this.autoVerify.tries = 0;
        }
        this.status(
          this.autoVerify.on
            ? `Auto-tap armed — I will press "${this.autoVerify.label}" myself when a verification screen is up.`
            : "Auto-tap disarmed — the deck is back to taps only."
        );
        // Not inside this command: pressLabel needs the input lock this very case
        // is holding. A beat later the queue is drained and it is free to act.
        if (this.autoVerify.on) setTimeout(() => void this.maybeAutoVerify(), 700);
        return;
      }
      case "tap": {
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) throw new Error("A tap needs numeric x/y fractions");
        // Convert the deck's fraction to CSS px through the page's own live
        // metrics (which also snapshot the scroll offset, pre-press), because the
        // two coordinate systems are not the same thing:
        // the SDK forces `viewport: null` on a headed window (so only the page
        // knows its real size — a guessed 1280x900 was quietly skewing every
        // press), and a login form that auto-focuses a field can zoom, which
        // offsets the *visual* viewport the screenshot shows from the *layout*
        // viewport Playwright presses into.
        const m = await this.viewportMetrics(page);
        let x = Math.round(clamp01(cmd.x) * m.w + m.ox);
        let y = Math.round(clamp01(cmd.y) * m.h + m.oy);
        if (!isHumanized(page)) await ensureHumanized(page, this.humanizeOpts());
        // Aim assist: a finger lands on the line between two rows, on the grey
        // padding inside a card, on the text label whose handler lives on its
        // parent. TikTok's "verify it's really you" list is exactly that — plain
        // <div> rows, handler up the tree — so a raw pixel press that misses the
        // handler's node does nothing at all. Clamp the press onto the nearest
        // control instead (see tapAim.ts).
        const aim = await resolveTapPoint(page, x, y);
        if (aim) {
          console.log(`[${this.platform}] tap nudged to "${aim.label}" (${aim.dx >= 0 ? "+" : ""}${Math.round(aim.dx)}px, ${aim.dy >= 0 ? "+" : ""}${Math.round(aim.dy)}px)`);
          x = aim.x;
          y = aim.y;
        }
        // Humanized single-glide press: the SDK moves the cursor there as
        // native trusted events (min-jerk path, tremor), then we press and
        // release with a human hold — see humanTap().
        const watch = await page.evaluate(activityProbe, ["start"] as [ActivityPhase]).catch(() => null);
        await humanTap(page, x, y);
        // What the press hit and what took focus — the deck's device-keyboard
        // hint, and the line that makes "I clicked X and nothing happened"
        // diagnosable from the deploy log instead of a mystery.
        const hit: TapReport = await page
          .evaluate(tapProbe, [x, y, INTERACTIVE_SEL, TARGET_ATTR] as [number, number, string, string])
          .catch(() => ({ under: "?", focused: "?", onField: false, interactive: true, marked: false, scrollY: 0 }));
        // The glide is a few hundred ms of native moves; if the document moved in
        // that window, the press landed somewhere else than the probe just
        // measured — which is the last way a well-formed click can still do
        // nothing, so say so in the log instead of leaving it a mystery.
        const shifted =
          !m.stale && Math.abs(m.sy - hit.scrollY) > 2 ? ` · page moved ${Math.round(hit.scrollY - m.sy)}px mid-press` : "";
        // "Did the page answer?" — the difference between a tap that missed and a
        // tap that landed on a UI ignoring pointer input. In the first case say
        // nothing more; in the second, activate the very node that was pressed.
        // That is the fallback that makes "I clicked Password and nothing
        // happened" work when the hit-test surface, not the aim, is the problem.
        const peek = watch ? await page.evaluate(activityProbe, ["peek"] as [ActivityPhase]).catch(() => null) : null;
        const responded = !watch || !peek || peek.fp !== watch.fp || peek.mutations > 40;
        let fallback = "";
        if (responded) {
          await page.evaluate(activityProbe, ["end"] as [ActivityPhase]).catch(() => undefined);
        } else if (!hit.marked) {
          await page.evaluate(activityProbe, ["end"] as [ActivityPhase]).catch(() => undefined);
          fallback = " · nothing landed on a control, so no DOM fallback was tried";
        } else {
          const act = await page.evaluate(activateMarked, [TARGET_ATTR] as [string]).catch(() => null);
          await sleep(jitter(240, 420));
          const done = await page.evaluate(activityProbe, ["end"] as [ActivityPhase]).catch(() => null);
          const worked = !!act && !!done && (done.fp !== watch.fp || done.mutations > 40);
          fallback = act
            ? ` · press ignored → DOM click on ${act.tag}${act.label ? ` "${act.label}"` : ""}${worked ? " worked" : " did nothing either"}`
            : " · press ignored and the control could not be marked for a DOM click";
          if (worked) {
            // The keyboard hint and the "what took focus" line have to be re-read:
            // the fallback, not the press, is what changed the page.
            const again: TapReport = await page
              .evaluate(tapProbe, [x, y, INTERACTIVE_SEL, TARGET_ATTR] as [number, number, string, string])
              .catch(() => hit);
            hit.focused = again.focused;
            hit.onField = again.onField;
          }
        }
        const where = `tap @ (${x},${y})${m.scale !== 1 ? ` [zoom ${m.scale.toFixed(2)}×]` : ""}`;
        const summary = `${where} → ${hit.under}${hit.interactive ? "" : " · NOT on an interactive element"}; focus: ${hit.focused}${shifted}${fallback}${isHumanized(page) ? "" : " [PLAIN input]"}`;
        console.log(`[${this.platform}] ${summary}`);
        if (shifted || fallback || !hit.interactive) this.broadcast({ type: "log", level: fallback.includes("worked") ? "ok" : "warn", text: `${fallback.includes("worked") ? "✅" : "⚠️"} ${summary}`, at: Date.now() });
        if (fallback.includes("ignored")) this.broadcast({ type: "toast", text: fallback.includes("worked") ? "Your tap was ignored by the page — activated it from the DOM instead" : "Your tap landed, but the page ignored it", tone: fallback.includes("worked") ? "ok" : "warn" });
        if (hit.onField) this.broadcast({ type: "input-focused" });
        return;
      }
      default: {
        // An old worker behind a new deck would otherwise swallow an unknown
        // command in silence — which looks exactly like "the button does
        // nothing". Say what is actually wrong: it needs a redeploy.
        const unknown = cmd as { t?: string };
        throw new Error(`This worker does not understand "${unknown.t ?? "?"}" (protocol v${PROTOCOL_VERSION}) — redeploy it`);
      }
      case "scroll":
        // Direct wheel — the SDK's humanize wrapper eases it into native
        // wheel deltas with mid-scroll pauses itself. No extra chunking so a
        // drag-scroll feels immediate and never backs up the command queue.
        await page.mouse.wheel(0, cmd.dy);
        return;
      case "type":
        // User-routed keystrokes: human inter-key timing, NO typos (the SDK
        // humanize wrapper still adds the per-key hold dwell, so these stay
        // native trusted key events).
        await humanType(page, cmd.text);
        return;
      case "key":
        await sleep(jitter(40, 160));
        await page.keyboard.press(cmd.key);
        return;
    }
  }

  async close() {
    this.stopLoops();
    this.clients.clear();
    const ctx = this.context;
    this.teardown();
    this.lastFatal = null;
    try {
      await ctx?.close();
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------ scraper helpers ---------------------------- */

export function parseCount(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "B" ? 1e9 : 1;
  return Math.round(n * mult);
}

export interface Candidate {
  url: string;
  title: string;
  likes: number;
  views: number;
  comments: number;
  commentSample: string;
}

const YT_SEARCH_QUERIES: Record<string, string[]> = {
  stories: ["faceless+storytime+shorts", "faceless+stories+shorts"],
  scary: ["scary+creepy+stories+shorts", "scary+stories+shorts"],
  facts: ["mind+blowing+facts+shorts", "amazing+facts+shorts"],
};

/** Scan the For You feed (or platform home) for candidate videos. */
export async function scrapeCandidates(
  page: Page,
  likesFloor: number,
  platform: "tiktok" | "instagram" | "youtube" = "tiktok",
  niche: string = "stories"
): Promise<Candidate[]> {
  if (platform === "youtube") return scrapeYouTubeCandidates(page, likesFloor, niche);
  const url =
    page.url().includes("tiktok.com")
      ? "https://www.tiktok.com/foryou"
      : page.url().includes("instagram.com")
        ? "https://www.instagram.com/reels/"
        : page.url();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await sleep(4000);

  // A human watches the feed before harvesting it: a few small scrolls with
  // reading pauses so the account's feed behavior matches a real viewer.
  await page.mouse.wheel(0, Math.round(jitter(300, 700)));
  await readingPause(500, 1600);
  await page.mouse.wheel(0, Math.round(jitter(400, 900)));
  await readingPause(700, 2200);

  const items = await page.evaluate(() => {
    const out: { url: string; label: string }[] = [];
    const hrefs = new Set<string>();
    const els = document.querySelectorAll("a[href*='/video/'], a[href*='/reel/']");
    for (const a of els) {
      const href = (a as HTMLAnchorElement).href.split("?")[0];
      if (hrefs.has(href)) continue;
      hrefs.add(href);
      out.push({ url: href, label: a.getAttribute("aria-label") || a.textContent || "" });
      if (out.length >= 40) break;
    }
    return out;
  });

  const candidates: Candidate[] = [];
  for (const it of items) {
    const likes = parseCount(it.label.match(/([\d.,]+[KMB]?)\s*likes?/i)?.[1]);
    const views = parseCount(it.label.match(/([\d.,]+[KMB]?)\s*views?/i)?.[1]);
    const comments = parseCount(it.label.match(/([\d.,]+[KMB]?)\s*comments?/i)?.[1]);
    if (likes && likes >= likesFloor) {
      candidates.push({
        url: it.url,
        title: it.label.slice(0, 160) || "Untitled clip",
        likes,
        views: views ?? 0,
        comments: comments ?? 0,
        commentSample: "",
      });
    }
  }
  return candidates.slice(0, 12);
}

/**
 * YouTube discovery: search Shorts in the active niche, then open each
 * candidate and read its like count (the 50K floor). Bounded to keep the
 * hourly cycle cheap; YouTube Shorts hide comments behind clicks so the
 * comment sample stays empty and Groq judges on stats + title.
 */
async function scrapeYouTubeCandidates(
  page: Page,
  likesFloor: number,
  niche: string
): Promise<Candidate[]> {
  const queries = YT_SEARCH_QUERIES[niche] ?? YT_SEARCH_QUERIES.stories;
  let hrefs: string[] = [];
  for (const q of queries) {
    await page
      .goto(`https://www.youtube.com/results?search_query=${q}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch(() => undefined);
    await sleep(3500);
    await page.evaluate(() => window.scrollBy(0, 2200)).catch(() => undefined);
    await readingPause(1200, 2600);
    hrefs = await page.evaluate(() => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href^="/shorts/"]'))) {
        const href = (a as HTMLAnchorElement).href.split("?")[0];
        if (seen.has(href)) continue;
        seen.add(href);
        out.push(href);
        if (out.length >= 14) break;
      }
      return out;
    });
    if (hrefs.length > 0) break;
  }

  const candidates: Candidate[] = [];
  for (const href of hrefs.slice(0, 8)) {
    if (candidates.length >= 8) break;
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await sleep(2400);
      const s = await page.evaluate(() => {
        const cnt = (raw: string | null | undefined): number | null => {
          if (!raw) return null;
          const m = String(raw).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
          if (!m) return null;
          const n = parseFloat(m[1]);
          const mult = m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "B" ? 1e9 : 1;
          return Math.round(n * mult);
        };
        let likes: number | null = null;
        for (const btn of Array.from(document.querySelectorAll("button[aria-label]"))) {
          const label = btn.getAttribute("aria-label") || "";
          const m = label.match(/along with\s*([\d.,]+\s*[KMB]?)/i);
          if (/like this video/i.test(label) && m) {
            likes = cnt(m[1]);
            break;
          }
        }
        const title = (document.title || "YouTube Short").replace(/\s*-\s*YouTube\s*$/, "").replace(/\s*#?shorts?\s*$/i, "").trim();
        return { likes, title: title || "YouTube Short" };
      });
      if (s.likes && s.likes >= likesFloor) {
        candidates.push({
          url: href,
          title: s.title.slice(0, 160),
          likes: s.likes,
          views: 0,
          comments: 0,
          commentSample: "",
        });
      }
    } catch {
      /* skip unreadable short */
    }
  }
  return candidates;
}

/** Read a few comments off a video page (best effort). */
export async function scrapeCommentSample(page: Page, url: string): Promise<string> {
  try {
    if (url.includes("youtube.com")) return ""; // Shorts comments need interaction; judged on stats.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await sleep(2000);
    return await page.evaluate(() => {
      const sels = [
        '[data-e2e="comment-item"] [data-e2e="comment-text"]',
        '[data-e2e="comment-item"]',
        'div[role="article"] span',
      ];
      for (const sel of sels) {
        const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 5);
        const text = nodes.map((n) => (n.textContent || "").trim()).filter(Boolean).join(" | ");
        if (text) return text.slice(0, 700);
      }
      return "";
    });
  } catch {
    return "";
  }
}

export interface VideoStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

/** Parse view/like/comment stats from a published video page. */
export async function readVideoStats(page: Page, url: string): Promise<VideoStats> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await sleep(1500);
  } catch {
    return { views: null, likes: null, comments: null };
  }
  try {
    return await page.evaluate(() => {
      const cnt = (s: string | null | undefined): number | null => {
        if (!s) return null;
        const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
        if (!m) return null;
        const n = parseFloat(m[1]);
        const mult = m[2]?.toUpperCase() === "K" ? 1e3 : m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "B" ? 1e9 : 1;
        return Math.round(n * mult);
      };
      if (location.hostname.endsWith("youtube.com")) {
        const yt = { views: null as number | null, likes: null as number | null, comments: null as number | null };
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          try {
            const data = JSON.parse(s.textContent || "{}") as {
              interactionStatistic?: { userInteractionCount?: unknown; interactionType?: { type?: string } }[];
              commentCount?: unknown;
            };
            for (const i of data.interactionStatistic ?? []) {
              const n = Number(i.userInteractionCount);
              if (!Number.isFinite(n)) continue;
              const t = String(i.interactionType?.type ?? "").toLowerCase();
              if (t.includes("watch") || t.includes("view")) yt.views = n;
            }
            const cc = Number(data.commentCount);
            if (Number.isFinite(cc) && cc > 0) yt.comments = cc;
          } catch {
            /* continue */
          }
        }
        for (const btn of Array.from(document.querySelectorAll("button[aria-label]"))) {
          const label = btn.getAttribute("aria-label") || "";
          const m = label.match(/like this video along with\s*([\d.,]+\s*[KMB]?)/i);
          if (m) {
            yt.likes = cnt(m[1]);
            break;
          }
        }
        if (yt.views == null) {
          const el = document.querySelector(
            ".view-count, ytd-watch-metadata #count yt-formatted-string, ytd-video-primary-info-renderer #count"
          );
          if (el) yt.views = cnt((el.textContent || "").match(/([\d.,]+\s*[KMB]?)/)?.[1]);
        }
        if (yt.comments == null) {
          const hdr = document.querySelector("ytd-comments-header-renderer #count, #comments-header #count");
          if (hdr) yt.comments = cnt((hdr.textContent || "").replace(/[^\d.,KMB]/g, ""));
        }
        return yt;
      }
      const pick = { views: null as number | null, likes: null as number | null, comments: null as number | null };
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const data = JSON.parse(s.textContent || "{}") as { interactionStatistic?: unknown };
          const st = data.interactionStatistic;
          if (Array.isArray(st)) {
            for (const i of st as { userInteractionCount?: unknown; interactionType?: unknown }[]) {
              const n = Number(i.userInteractionCount);
              if (!Number.isFinite(n)) continue;
              const t = String(
                (i.interactionType as { type?: string } | undefined)?.type || i.interactionType || ""
              ).toLowerCase();
              if (t.includes("watch") || t.includes("view")) pick.views = n;
              else if (t.includes("like")) pick.likes = n;
              else if (t.includes("comment")) pick.comments = n;
            }
          }
        } catch {
          /* continue */
        }
      }
      const body = document.body?.innerText?.slice(0, 3000) ?? "";
      const likes = body.match(/([\d.,]+[KMB]?)\s*likes?/i);
      const views = body.match(/([\d.,]+[KMB]?)\s*views?/i);
      const comments = body.match(/([\d.,]+[KMB]?)\s*comments?/i);
      if (pick.views == null && views) pick.views = cnt(views[1]);
      if (pick.likes == null && likes) pick.likes = cnt(likes[1]);
      if (pick.comments == null && comments) pick.comments = cnt(comments[1]);
      return pick;
    });
  } catch {
    return { views: null, likes: null, comments: null };
  }
}
