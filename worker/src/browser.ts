import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext, RELEASE } from "clearcote";
import type { BrowserContext, Page } from "playwright-core";
import { env, stealth, driverInfo, START_URLS, type PlatformKey } from "./config.js";
import type { RemoteCmd, ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { asHumanPage, humanTap, humanType, jitter, readingPause, sleep, thinkingPause } from "./human.js";

/**
 * The rig drives the **Clearcote** browser the **nodriver** way: the binary is
 * launched directly by the Clearcote SDK (no WebDriver / chromedriver layer,
 * `--enable-automation` stripped, engine-level fingerprint spoofing compiled
 * into Chromium's C++), and every input goes out as native trusted events with
 * a human motor persona (`humanize`). No vanilla Chromium is ever launched.
 */
const LAUNCH_ARGS = [
  // Container runtime needs (the sandbox/uid sandbox and /dev/shm are absent in Docker).
  "--no-sandbox",
  "--disable-dev-shm-usage",
];

export interface RigClient {
  send: (msg: ServerMsg) => void;
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

  private async launchContext(): Promise<BrowserContext> {
    const profile = this.profileDir();
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
        args: LAUNCH_ARGS,
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
      this.status(`Browser up in ${Math.round((Date.now() - t0) / 100) / 10}s — opening ${START_URLS[this.platform]}`);
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

  /** Deck-visible progress line (also in the deploy log). */
  private status(text: string) {
    console.log(`[${this.platform}] ${text}`);
    this.broadcast({ type: "log", level: "info", text, at: Date.now() });
  }

  /** Forget the dead browser without touching sockets. */
  private teardown() {
    this.stopLoops();
    this.shotSession = null;
    this.context = null;
    this.control = null;
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
    this.broadcast({
      type: "ready",
      sessionId: `rig-${this.platform}`,
      url: START_URLS[this.platform],
      driver: driverInfo(),
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

  async newEnginePage(): Promise<Page> {
    const ctx = await this.ensureContext();
    return ctx.newPage();
  }

  private startLoops() {
    if (!this.frameTimer) {
      this.frameTimer = setInterval(() => void this.pushFrame(), Math.max(400, env.frameIntervalMs));
    }
    if (!this.loginTimer) {
      this.loginTimer = setInterval(() => void this.detectLogin(), 5000);
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
    if (this.pendingCmds > 0) return; // never drift while commands are in flight
    if (Date.now() - this.lastInputAt < 45_000) return;
    this.idleBusy = true;
    try {
      const hp = asHumanPage(page);
      // Ambient motion never clicks and never scrolls — pure pointer entropy.
      await hp.ambientMotion?.(Math.round(jitter(700, 1600)));
      if (Math.random() < 0.3) {
        // A tiny, human-scaled scroll — like a thumb resting on the feed.
        const dy = Math.round(jitter(50, 140)) * (Math.random() < 0.2 ? -1 : 1);
        await page.mouse.wheel(0, dy);
        await sleep(jitter(200, 700));
      }
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

  /** Best-effort "am I signed in" detection. Engines pause until this is true. */
  async detectLogin(): Promise<boolean> {
    const page = this.control;
    if (!page || page.isClosed() || this.detectBusy) return this.store.rig(this.platform).loggedIn;
    this.detectBusy = true;
    try {
      let logged = false;
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
      const prev = this.store.rig(this.platform).loggedIn;
      if (logged !== prev) {
        this.store.setLoggedIn(this.platform, logged);
        this.broadcast({ type: "login", loggedIn: logged });
        this.broadcast({
          type: "log",
          level: logged ? "ok" : "warn",
          text: logged ? `✅ Signed in detected on ${this.platform} — the engine may act.` : `Signed-out state on ${this.platform} — log in to arm the engine.`,
          at: Date.now(),
        });
      }
      return logged;
    } catch {
      return this.store.rig(this.platform).loggedIn;
    } finally {
      this.detectBusy = false;
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
          await this.execInner(item.cmd);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async execInner(cmd: RemoteCmd): Promise<void> {
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
      case "tap": {
        // Real window size in CSS px (the SDK's own convention: with
        // viewport:null on a headed window, viewportSize() is null for life).
        const vp = await page
          .evaluate(() => [window.innerWidth, window.innerHeight])
          .catch(() => undefined);
        const width = vp?.[0] || page.viewportSize()?.width || 1280;
        const height = vp?.[1] || page.viewportSize()?.height || 900;
        const x = cmd.x * width;
        const y = cmd.y * height;
        // Humanized single-glide press: the SDK moves the cursor there as
        // native trusted events (min-jerk path, tremor), then we press and
        // release with a human hold — see humanTap().
        await humanTap(page, x, y);
        // If the tap landed in a text field, tell the deck so it can pop the
        // user's own device keyboard and route keystrokes to that field.
        const onField = await page
          .evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName;
            return (
              tag === "INPUT" ||
              tag === "TEXTAREA" ||
              el.isContentEditable ||
              el.getAttribute("contenteditable") === "true" ||
              el.getAttribute("role") === "textbox"
            );
          })
          .catch(() => false);
        if (onField) this.broadcast({ type: "input-focused" });
        return;
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
