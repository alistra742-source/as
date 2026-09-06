import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext } from "clearcote";
import type { BrowserContext, Page } from "playwright-core";
import { env, stealth, driverInfo, START_URLS, type PlatformKey } from "./config.js";
import type { RemoteCmd, ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { asHumanPage, armAmbient, humanScroll, humanTap, humanType, jitter, readingPause, sleep, thinkingPause } from "./human.js";

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
    const profile = this.profileDir();
    console.log(
      `[${this.platform}] launching Clearcote browser (persona: ${stealth.platform}, humanized input: ${stealth.humanize ? "on" : "off"}, light stealth: ${stealth.lightStealth ? "on" : "off"}, profile: ${profile})`
    );
    try {
      this.context = await launchPersistentContext(profile, {
        headless: stealth.headless,
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
      });
      this.control = null;
      return this.context;
    } catch (err) {
      const raw = (err as Error).message || String(err);
      if (!stealth.headless && !process.env.DISPLAY) {
        throw new Error(
          `Headed mode needs a display — none is available (set STEALTH_HEADLESS=true or run under Xvfb). Underlying error: ${raw}`
        );
      }
      if (/no build for|not (exist|found)/i.test(raw)) {
        throw new Error(`Clearcote browser unavailable: ${raw} — check CLEARCOTE_CACHE_DIR and rebuild the image (the browser is pre-downloaded at build time).`);
      }
      throw new Error(
        `Clearcote launch failed: ${raw} — typical causes: missing Chromium runtime libs (compare with the Dockerfile apt list), no display in headed mode, or a damaged browser cache (delete it and relaunch to re-download).`
      );
    }
  }

  async openControlSession(): Promise<Page> {
    const ctx = await this.ensureContext();
    if (this.control && !this.control.isClosed()) return this.control;
    const page = await ctx.newPage();
    this.control = page;
    armAmbient(page);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      this.broadcast({ type: "nav", url, title: url });
      void this.detectLogin();
    });
    this.broadcast({
      type: "ready",
      sessionId: `rig-${this.platform}`,
      url: START_URLS[this.platform],
      driver: driverInfo(),
    });
    this.startLoops();
    try {
      await page.goto(START_URLS[this.platform], { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch {
      /* page may be mid-challenge; frames still stream */
    }
    return page;
  }

  async newEnginePage(): Promise<Page> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    armAmbient(page);
    return page;
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

  private async pushFrame() {
    const page = this.control;
    if (this.clients.size === 0 || !page || page.isClosed()) return;
    try {
      const shot = await page.screenshot({ type: "jpeg", quality: 52 });
      this.broadcast({ type: "frame", data: shot.toString("base64"), at: Date.now() });
    } catch {
      /* page navigating — skip this frame */
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

  async exec(cmd: RemoteCmd): Promise<void> {
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
        // Humanized: the SDK glides there (min-jerk path, tremor, dwell) and
        // presses with a human hold; we add the pre-tap "eyes on the target"
        // pause and a post-tap beat around it.
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
        // Human scroll: eased native wheel deltas with reading pauses between
        // bursts (the SDK adds per-step easing + mid-scroll pauses).
        await humanScroll(page, cmd.dy);
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
    try {
      await this.context?.close();
    } catch {
      /* already closed */
    }
    this.context = null;
    this.control = null;
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
