import fs from "node:fs";
import path from "node:path";
import { launchPersistentContext, RELEASE } from "clearcote";
import { accountProfileDir, LEGACY_ACCOUNT_ID } from "./accountScope.js";
import { browserEngine, dockSize, installStealthLite, launchPlaywrightContext, playwrightChromiumPath } from "./browserLaunch.js";
import type { BrowserContext, Page } from "playwright-core";
import { cgroupMemoryMb, env, stealth, driverInfo, START_URLS, v8HeapMb, type PlatformKey } from "./config.js";
import { PROTOCOL_VERSION, type RemoteCmd, type ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { checkUploadAccess } from "./uploads.js";
import { asHumanPage, humanTap, humanType, jitter, readingPause, sleep, thinkingPause } from "./human.js";
import { describePlan, planSessionCookies, type CookiePlan } from "./sessionCookie.js";
import {
  tiktokAccountProbePage,
  tiktokLoginEvidencePage,
  type TikTokAccountProbe,
  type TikTokLoginEvidence,
} from "./tiktokLogin.js";
import { tiktokProfileItemsPage } from "./tiktokProfile.js";
import { accountTorProxy } from "./torProxy.js";
import {
  cleanDiscoveryTopic,
  directTopicProfileUrl,
  discoverySearchUrl,
  isTopicMatch,
  rankDiscoveryCandidates,
  topicRelevance,
  topicSearchAliases,
} from "./discovery.js";
import { ensureHumanized, humanizeContext, isHumanized } from "./humanizeAttach.js";
import { publicVideoStats } from "./videoStats.js";
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
 * Two engines, one rig. `BROWSER_ENGINE=playwright` (the default) drives stock
 * Chromium through Playwright; `BROWSER_ENGINE=clearcote` drives the
 * anti-fingerprint build the nodriver way (binary launched by the SDK, no
 * chromedriver layer, spoofing compiled into Chromium's C++).
 *
 * In both cases input goes out as native trusted CDP events with the human motor
 * persona from `human.ts`, the profile directory is the same, and everything
 * below this comment is engine-independent — the switch is a launch decision in
 * `launchContext()`, not a different code path.
 */
/**
 * Every flag here is a trade between memory and *stability*, and which side is
 * right depends on how big the container actually is.
 *
 * The diet flags (`--renderer-process-limit`, site-isolation off) were written for
 * 512 MB–1 GB boxes, where one renderer per site-instance is the difference between
 * a working session and an OOM loop. On a box with room they are a liability: hit a
 * hard renderer ceiling and Chromium **discards a renderer to stay under the
 * limit**, which reaches the deck as "Target crashed" with 7 GB free and no kernel
 * OOM — precisely the "site keeps crashing" report. A DCHECK-enabled build with
 * site isolation switched off also has more ways to end a frame than a release
 * build does. So: diet only when the box is actually small.
 */
function launchArgs(profile: string): string[] {
  const { limit } = cgroupMemoryMb();
  const small = limit !== null && limit < 3000;
  const args = [
    // Container runtime needs (the sandbox/uid sandbox and /dev/shm are absent in Docker).
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // No GPU process on Xvfb (llvmpipe is CPU anyway): saves ~80-120 MB and one
    // more process that can be killed. Software compositing stays.
    "--disable-gpu",
    // Tor carries TCP through the account proxy. Do not let QUIC or WebRTC open
    // a direct UDP side channel around that fixed proxy.
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    // V8's heap ceiling per renderer — see `v8HeapMb()`. Too low and a heavy page
    // aborts its own renderer; too high and the kernel does it more quietly.
    `--js-flags=--max-old-space-size=${v8HeapMb()}`,
    // Chrome's own OOM intervention: pause/kill bloated frames before the kernel
    // kills the whole tab. Merged with the SDK's own feature list.
    "--enable-features=OomIntervention,MemoryPurgeOnFreeze",
    // Chromium's own log, so a renderer death can be *quoted* instead of guessed
    // at (`chromeLogTail`). Not observable from page JS, so no fingerprint cost.
    "--enable-logging=file",
    // Absolute: a bare name would resolve against the process cwd, and then the
    // reader below (which looks in the profile) would find nothing.
    `--log-file=${path.join(profile, CHROME_LOG)}`,
    "--log-level=0",
  ];
  // An explicit choice beats the heuristic: `true` = never disable isolation,
  // `false` = always run the diet (a big box that wants to spend less memory).
  const iso = (process.env.STEALTH_SITE_ISOLATION || "").toLowerCase();
  const diet = iso === "true" ? false : iso === "false" ? true : small;
  if (diet) {
    args.push(
      // One renderer per site-instance instead of per iframe-origin: TikTok embeds
      // dozens of third-party frames, and each would be its own ~50 MB process.
      "--disable-features=IsolateOrigins,site-per-process,ProcessPerSiteUpToMainFrameThreshold",
      "--renderer-process-limit=3"
    );
  }
  return args;
}

/** Inside the profile dir, which is on the persistent volume and per-platform. */
const CHROME_LOG = "chrome-self.log";

/**
 * The last few lines of Chromium's own log that matter: a renderer death, a
 * crash-handler signal, an OOM note. Rendered into the deck's log so "the browser
 * keeps crashing" stops being a guess — the box either says `Received signal
 * 11` or it says `Out of memory`, and those need different fixes.
 */
function chromeLogTail(profile: string): string {
  try {
    const text = fs.readFileSync(path.join(profile, CHROME_LOG), "utf8");
    const hits = text
      .split(/\r?\n/)
      .filter((l) => /ERROR:|FATAL:|Received signal|Out of memory|oom|killed|crashed|discarded/i.test(l));
    if (!hits.length) return "";
    return hits.slice(-3).join(" | ").replace(/^\[[^\]]*\]\s*/, "").slice(0, 420);
  } catch {
    return "";
  }
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

interface CookieJarVerdict {
  expected: number;
  exact: number;
  scoped: number;
  sessionPresent: boolean;
}

/** Compare in memory only. Values are intentionally absent from the verdict. */
function cookieJarVerdict(
  jar: Array<{ name: string; value: string; domain: string; path: string }>,
  plan: CookiePlan,
  requireExactValue: boolean
): CookieJarVerdict {
  let exact = 0;
  let scoped = 0;
  for (const wanted of plan.cookies) {
    const atScope = jar.find(
      (actual) => actual.name === wanted.name && actual.domain === wanted.domain && actual.path === wanted.path
    );
    if (atScope) scoped += 1;
    if (atScope && (!requireExactValue || atScope.value === wanted.value)) exact += 1;
  }
  const sessionNeedle = (plan.sessionName || "").toLowerCase();
  return {
    expected: plan.cookies.length,
    exact,
    scoped,
    sessionPresent: !!sessionNeedle && jar.some((cookie) => cookie.name.toLowerCase() === sessionNeedle),
  };
}

/**
 * Where to land after a jar swap. TikTok's root and For You feed are public;
 * their generic content cannot prove authentication. `/profile` is a harmless
 * private-route canary: a valid session resolves to the viewer's profile, while
 * an anonymous browser is sent to login/For You.
 */
function postCookieUrl(platform: PlatformKey): string {
  return platform === "tiktok" ? "https://www.tiktok.com/profile" : START_URLS[platform];
}

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
function crashVerdict(mem: { text: string; oomKills: number | null; tight: boolean }, quoted = ""): string {
  const quote = quoted ? ` — chromium said: ${quoted}` : "";
  if (mem.oomKills && mem.oomKills > 0) return `the kernel OOM-killed it (${mem.text})${quote}`;
  if (mem.tight) return `memory is nearly exhausted, so the next big allocation dies (${mem.text})${quote}`;
  // A renderer cannot exhaust a 2.4 GB V8 heap inside a container using 400 MB.
  // Say so, and name what actually ends a renderer at 5% memory: Chromium's own
  // process limit (discarding a renderer to stay under `--renderer-process-limit`)
  // or a SIGSEGV in this build — both fixable without touching the box's size.
  const { used } = cgroupMemoryMb();
  if (used !== null && used < v8HeapMb() * 0.8) {
    return (
      `NOT memory (${mem.text || "no cgroup limit"}) — the browser ended this renderer on purpose: with ` +
      `${used} MB used it cannot have reached the ${v8HeapMb()} MB V8 cap, so the suspects are the renderer ` +
      `process limit, a SIGSEGV in this build, or the site's own anti-debug trap${
        stealthDietOn() ? " — set STEALTH_SITE_ISOLATION=true to drop the renderer ceiling" : ""
      }` +
      quote
    );
  }
  return (
    `NOT a kernel OOM (${mem.text}) — the renderer hit its own ceiling; V8's cap is ${v8HeapMb()} MB, raise ` +
    `STEALTH_V8_HEAP_MB if the page legitimately needs more` +
    quote
  );
}

/** Whether the small-container diet is in effect for this launch. */
function stealthDietOn(): boolean {
  const { limit } = cgroupMemoryMb();
  return limit !== null && limit < 3000;
}

/**
 * Boot-time preflight: say exactly where the browser binary is expected and
 * whether it is there. A deploy whose image was built without the browser (or
 * whose CLEARCOTE_CACHE_DIR points elsewhere) used to fail silently at the
 * first socket — now the deploy log says so on line 5.
 */
export function browserPreflight(): { ok: boolean; detail: string } {
  if (browserEngine() === "playwright") {
    const found = playwrightChromiumPath();
    return {
      ok: !!found.path,
      detail: `stock Chromium (BROWSER_ENGINE=playwright) — ${found.detail}. Persistent profiles in ${env.dataDir}, so a switch to/from clearcote keeps logins.`,
    };
  }
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
  readonly accountId: string;
  accountName: string;
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
  /** True only for an intentional hibernate/close; suppresses the crash alarm. */
  private closing = false;
  /** Account deletion is terminal for this Rig object. Unlike hibernation it
   * must reject queued work and can never relaunch the removed profile. */
  private destroyed = false;
  /** A reconnect that lands during hibernation waits for the old profile owner
   * to exit before launching another Chromium against the same disk profile. */
  private closeInFlight: Promise<void> | null = null;
  /**
   * "Tap the verification method for me." The code/identity screen is the one
   * place a login stalls forever when a press does not land — a list of bare
   * <div> rows, each 62px tall, on a phone. So the deck can hand that screen
   * over entirely: the worker finds the row by its label and presses it, once
   * per screen, and only while a socket is connected (nothing taps the user's
   * account when nobody is watching).
   */
  private autoVerify = { on: false, label: "Email", sig: "", pressed: false, tries: 0 };
  /** How many time-spaced looks in a row said "signed out" — see `detectLogin`. */
  private signedOutStreak = 0;
  private lastSignedOutLookAt = 0;
  /** Freeze ambient login reads while the tab is blanked and its cookie jar is replaced. */
  private sessionMutation = false;
  /**
   * Set while the worker drives the *visible* tab itself (a manual publish). The
   * ambient loops stand down and login detection pauses for the duration: a page
   * mid-navigation has no avatar bar, and reading that as "signed out" is how a
   * publish disarmed its own engine.
   */
  private driving = false;
  /** A Studio capability probe navigates the streamed tab. Coalesce repeated
   * button presses and freeze ambient login reads until that one probe ends. */
  private uploadAccessPending = false;
  /** The screen signature we last acted on, so one modal = at most a few presses. */

  constructor(
    platform: PlatformKey,
    store: Store,
    accountId = LEGACY_ACCOUNT_ID,
    accountName = "Default"
  ) {
    this.platform = platform;
    this.accountId = accountId;
    this.accountName = accountName.trim().slice(0, 48) || "Account";
    this.store = store;
  }

  /** Browser-local work that must finish before an idle socket disconnect may
   * hibernate Chromium. Engine jobs are tracked separately by GrowthEngine. */
  hasActiveWork(): boolean {
    return this.driving || this.sessionMutation || this.uploadAccessPending || this.pendingCmds > 0;
  }

  /** The label is display metadata, but a runtime discovered from disk before
   * the deck reconnects must still learn the real name rather than stay “Account”. */
  setAccountName(name: string) {
    this.accountName = name.trim().slice(0, 48) || this.accountName;
  }

  /** Each named account owns a persistent cookie/storage profile of its own. */
  profileDir(): string {
    const dir = accountProfileDir(env.dataDir, this.platform, this.accountId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private identitySeed(): string {
    return `${this.platform}-${this.accountId}`;
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
    if (this.destroyed) throw new Error("This account runtime was deleted");
    // Never overlap an intentional close with a relaunch of the same persistent
    // directory: Chromium's singleton lock is an identity boundary, not a retry.
    if (this.closeInFlight) await this.closeInFlight;
    if (this.destroyed) throw new Error("This account runtime was deleted");
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
  /**
   * Stock Chromium through Playwright, on the same profile dir.
   *
   * Everything after the launch is shared with the Clearcote path on purpose —
   * the frame stream, the crash wiring, the humanizer probe, the memory diet — so
   * the engine choice is a launch decision and nothing else. Switching to this
   * engine does not log anything out: the persistent profile is identical.
   */
  private async launchStockChromium(profile: string, t0: number, proxyServer?: string): Promise<BrowserContext> {
    const { width, height } = dockSize();
    try {
      this.context = await launchPlaywrightContext({
        profile,
        headless: stealth.headless,
        locale: "en-US",
        timezoneId: stealth.timezone,
        width,
        height,
        logFile: path.join(profile, CHROME_LOG),
        proxyServer,
      });
      await installStealthLite(this.context);
      this.control = null;
      // Same call as the Clearcote path: on stock Chromium the SDK wrapper is not
      // there, this returns false, and `human.ts` carries the input itself.
      humanizeContext(this.context, this.humanizeOpts());
      const mem = memoryReport();
      this.status(
        `Chromium up in ${Math.round((Date.now() - t0) / 100) / 10}s (Playwright driver, V8 heap ${v8HeapMb()} MB/renderer` +
          `${stealthDietOn() ? ", renderer limit 3 + site isolation off" : ""}${mem.text ? `, ${mem.text}` : ""}) — opening ${START_URLS[this.platform]}`
      );
      this.context.on("close", () => {
        if (this.closing) return;
        console.error(`[${this.platform}] browser closed unexpectedly — will relaunch on next connect`);
        this.lastFatal = "The browser process exited (crash or out-of-memory). Reconnecting will relaunch it.";
        this.broadcast({ type: "error", message: `Browser exited: ${this.lastFatal}` });
        this.teardown();
      });
      return this.context;
    } catch (err) {
      const raw = (err as Error).message || String(err);
      console.error(`[${this.platform}] Chromium start failed: ${raw}`);
      this.lastFatal = raw;
      throw new Error(`Could not launch Chromium: ${raw}`);
    }
  }

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
    // A fresh run's log only — otherwise the next crash quotes the last one.
    try {
      fs.writeFileSync(path.join(profile, CHROME_LOG), "");
    } catch {
      /* a read-only volume costs us the diagnostic, nothing else */
    }
    const strays = this.reapStrayBrowsers(profile);
    if (strays) {
      this.status(`Reaping ${strays} orphaned browser process(es) still holding this profile…`);
      await sleep(600); // let the kernel finish releasing them before the next 600 MB
    }
    this.clearStaleLocks(profile);
    this.lastFatal = null;

    // Resolve and verify the account's Tor bridge BEFORE creating Chromium. If
    // Tor is down this throws, leaving no browser process that could silently use
    // the worker host's public IP.
    this.status("Verifying this account's isolated Tor circuit…");
    const tor = await accountTorProxy(this.platform, this.accountId, (reason) => {
      this.status(`Tor preflight is rotating a slow circuit and retrying (${reason}).`);
    });
    if (tor) {
      this.status(`Tor circuit verified for this account (egress ${tor.egressIp}).`);
    } else {
      const warning = "Tor proxying is explicitly disabled by TOR_PROXY_ENABLED=false; browser traffic is direct.";
      console.warn(`[${this.platform}/${this.accountName}] ${warning}`);
      this.status(warning);
    }
    if (this.destroyed) throw new Error("This account runtime was deleted during browser startup");

    const engine = browserEngine();
    if (engine === "playwright") {
      this.status(`Launching stock Chromium through Playwright (${stealth.headless ? "headless" : "headed on Xvfb"})…`);
      console.log(`[${this.platform}] launching stock Chromium via Playwright (profile: ${profile})`);
    } else {
      this.status(`Launching the Clearcote browser (${stealth.headless ? "headless" : "headed on Xvfb"}, ${stealth.platform} persona)…`);
      console.log(
        `[${this.platform}] launching Clearcote browser (persona: ${stealth.platform}, humanized input: ${stealth.humanize ? "on" : "off"}, light stealth: ${stealth.lightStealth ? "on" : "off"}, profile: ${profile})`
      );
    }
    const t0 = Date.now();
    if (engine === "playwright") {
      return this.launchStockChromium(profile, t0, tor?.server);
    }
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
        args: [
          ...launchArgs(profile),
          ...(tor
            ? [`--proxy-server=${tor.server}`, "--proxy-bypass-list=<-loopback>"]
            : []),
        ],
        // Keep BrowserContext.request (used to retrieve source media) on the
        // same account bridge too; the explicit Chromium arg above is the
        // fail-closed belt, this context option is the API-request braces.
        ...(tor ? { proxy: { server: tor.server, bypass: "" } } : {}),
        // One coherent, seed-stable machine identity per isolated account.
        fingerprint: stealth.seed(this.identitySeed()),
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
          `(V8 heap ${v8HeapMb()} MB/renderer${stealthDietOn() ? ", renderer limit 3 + site isolation off" : ""}` +
          `${mem.text ? `, ${mem.text}` : ""})`
      );
      // If the browser dies later (OOM kill, crash), drop everything so the
      // next connect relaunches instead of screenshotting a corpse forever.
      this.context.on("close", () => {
        if (this.closing) return;
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
    return { humanize: stealth.humanize, showCursor: stealth.showCursor, seed: stealth.seed(this.identitySeed()) };
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
    if (this.destroyed || this.recovering) return;
    this.recovering = true;
    this.shotSession = null;
    if (this.control === dead) this.control = null;
    try {
      await dead.close().catch(() => undefined);
      const ctx = this.context;
      if (!ctx) return;
      // Back off harder as the streak grows: the 3rd crash on the same page is not
      // a fluke, and relaunching a 600 MB renderer every few seconds is how a
      // recoverable problem becomes a crash loop the user watches for an hour.
      if (this.crashes >= 6) {
        if (this.crashes === 6) {
          this.broadcast({
            type: "log",
            level: "warn",
            text:
              `⚠️ ${this.crashes} tab deaths in a row — slowing relaunches to one every 20s. Memory is not the ` +
              `limit (the numbers are in the line above), so this is the browser's own renderer policy or the ` +
              `site's anti-automation trap. Chromium's log tail is quoted there; the deck's browser tab is being ` +
              `kept open so you can act by hand if you want.`,
            at: Date.now(),
          });
        }
        await sleep(20_000);
      } else if (this.crashes >= 3) {
        await sleep(4000);
      }
      if (this.destroyed) return;
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
    if (this.destroyed) throw new Error("This account runtime was deleted");
    if (this.control && !this.control.isClosed()) {
      this.startLoops();
      void this.pushFrame(); // don't make a reconnecting deck wait a full interval
      return this.control;
    }
    if (this.lastFatal) {
      this.broadcast({ type: "error", message: `Browser start failed: ${this.lastFatal} — retrying…` });
    }
    const ctx = await this.ensureContext();
    if (this.destroyed) throw new Error("This account runtime was deleted during browser startup");
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
      if (this.destroyed) return;
      const url = this.lastUrl || START_URLS[this.platform];
      const mem = memoryReport();
      const quoted = chromeLogTail(this.profileDir());
      const why = crashVerdict(mem, quoted);
      console.error(`[${this.platform}] TAB CRASHED (renderer killed) at ${url} — ${why}`);
      this.broadcast({
        type: "log",
        level: "warn",
        text: `⚠️ The ${this.platform} tab crashed at ${url.replace(/^https:\/\//, "").slice(0, 48)} — ${why}${
          stealthDietOn() ? " (memory-diet flags are on: renderer limit 3 + site isolation off)" : ""
        }. Reopening it…`,
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
    // A renderer crash owns a bounded tab-reopen routine; let that finish. If
    // the whole context vanished, however, nobody is recovering it in place —
    // launch immediately instead of burning the full 25 seconds first.
    while (!this.destroyed && this.recovering && Date.now() - t0 < maxMs) {
      await sleep(400);
    }
    if (this.control && !this.control.isClosed()) return true;
    if (this.destroyed || this.recovering) return false;
    try {
      await this.openControlSession();
      return !!this.control && !this.control.isClosed();
    } catch {
      return false;
    }
  }

  async newEnginePage(): Promise<Page> {
    if (this.destroyed) throw new Error("This account runtime was deleted");
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

  /** Commit strong positive evidence once, shared by DOM and account-endpoint probes. */
  private acceptSignedInDetection(): void {
    this.signedOutStreak = 0;
    this.lastSignedOutLookAt = 0;
    const rig = this.store.rig(this.platform);
    if (rig.loggedIn) return;
    this.store.setLoggedIn(this.platform, true, this.accountName);
    this.broadcast({ type: "login", loggedIn: true });
    this.broadcast({ type: "log", level: "ok", text: `✅ Signed in detected on ${this.platform} — the engine may act.`, at: Date.now() });
  }

  /** Best-effort "am I signed in" detection. Engines pause until this is true. */
  async detectLogin(): Promise<boolean> {
    const page = this.control;
    if (this.destroyed) return false;
    if (!page || page.isClosed() || this.detectBusy) return this.store.rig(this.platform).loggedIn;
    // A publish navigating the visible tab to /upload, or an atomic cookie-jar
    // replacement blanking it for a moment, is not evidence about the session.
    // Hold the last answer until the tab is ours again.
    if (this.driving || this.sessionMutation) return this.store.rig(this.platform).loggedIn;
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
        const evidence = await page.evaluate(tiktokLoginEvidencePage);
        logged = evidence.state === "signed-in";
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
      if (this.destroyed) return false;
      // A publish/check can take ownership while the asynchronous DOM probe above
      // is in flight. Discard that stale look rather than applying uploader
      // navigation as a logout after `driving` became true.
      if (this.driving || this.sessionMutation) return this.store.rig(this.platform).loggedIn;
      const rig = this.store.rig(this.platform);
      const prev = rig.loggedIn;
      if (logged) {
        this.acceptSignedInDetection();
      } else if (!atLoginWall && Date.now() - this.lastSignedOutLookAt < 4000) {
        // Navigation emits several frame events in one render. They are one look,
        // not three independent observations; keep the previous trusted state.
        return prev;
      } else if (atLoginWall || this.signedOutStreak >= 2) {
        this.signedOutStreak = 0;
        this.lastSignedOutLookAt = 0;
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
        this.lastSignedOutLookAt = Date.now();
        this.signedOutStreak += 1;
        if (prev) {
          this.broadcast({
            type: "log",
            level: "info",
            text: `Signed-in state uncertain on ${this.platform} (look ${this.signedOutStreak}/3) — holding the engine until it is confirmed.`,
            at: Date.now(),
          });
        }
      }
      return this.store.rig(this.platform).loggedIn;
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
    if (this.destroyed) return { ran: false };
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
   * never calls into it. The raw paste is used only to write Chromium's cookie
   * jar; it is never put in app state, logged, or broadcast back. `detail` and
   * toasts contain names, counts, dates, and coarse authentication evidence only.
   */
  async applySessionCookie(raw: string): Promise<{ ok: boolean; detail: string }> {
    const plan = planSessionCookies(this.platform, raw);
    if (!plan.ok) {
      this.broadcast({ type: "log", level: "warn", text: `⚠️ Session cookie not applied: ${plan.detail}`, at: Date.now() });
      this.broadcast({ type: "toast", text: "That is not a usable session export", tone: "warn" });
      return { ok: false, detail: plan.detail };
    }

    let stage = "starting the account browser";
    let jarChanged = false;
    let installed = false;
    this.sessionMutation = true;
    try {
      const ctx = await this.ensureContext();
      // Applying is initiated from the room, so this normally reuses its visible
      // tab. Awaiting it here is important: writing while the first TikTok request
      // is still setting guest cookies lets that response overwrite the import.
      const page = await this.openControlSession();
      if (this.destroyed) throw new Error("account runtime deleted");

      let navigationStatus: number | null = null;
      let navigationSettled = true;
      await this.withInput(async () => {
        stage = "pausing the site before the jar swap";
        await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10_000 });

        stage = "removing stale same-name cookies";
        // A cookie swap is an identity boundary. Fail closed as soon as jar work
        // begins; even a later CDP error could occur after one name was removed.
        jarChanged = true;
        const wasLoggedIn = this.store.rig(this.platform).loggedIn;
        this.store.setLoggedIn(this.platform, false);
        this.signedOutStreak = 0;
        this.lastSignedOutLookAt = 0;
        if (wasLoggedIn) this.broadcast({ type: "login", loggedIn: false });

        // `addCookies()` replaces only an exact name+domain+path tuple. A stale
        // host-only `www.tiktok.com` session can otherwise coexist with a newly
        // imported `.tiktok.com` session and be sent first. Remove only names the
        // new plan owns; unrelated device/trust cookies survive a bare paste.
        for (const name of Array.from(new Set(plan.names))) await ctx.clearCookies({ name });

        stage = "writing the imported cookie scopes";
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

        stage = "verifying Chromium retained the import";
        const written = cookieJarVerdict(await ctx.cookies(), plan, true);
        if (written.exact !== written.expected) {
          // Counts and scopes are safe; never interpolate a value or Playwright's
          // raw error (validation errors can include the offending cookie object).
          throw new Error(`Chromium retained ${written.exact}/${written.expected} exact cookie scopes`);
        }
        installed = true;
        if (this.destroyed) throw new Error("account runtime deleted");
        this.store.setCookie(this.platform, Date.now(), plan.names, plan.expiresAt);
        this.broadcastCookieState();
        this.broadcast({ type: "log", level: "info", text: `Session cookie installed — ${plan.detail}`, at: Date.now() });

        stage = "loading the post-install account page";
        try {
          const response = await page.goto(postCookieUrl(this.platform), {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          navigationStatus = response?.status() ?? null;
        } catch {
          // A streaming page can keep loading forever even though its account
          // header rendered. Continue to evidence checks rather than turn a
          // navigation timeout into a misleading "browser refused the cookie".
          navigationSettled = false;
        }
      });
      this.sessionMutation = false;

      let logged = false;
      let pageEvidence: TikTokLoginEvidence = { state: "unknown", reason: "no-auth-evidence" };
      let accountProbe: TikTokAccountProbe = { state: "unknown", httpStatus: null };
      for (let i = 0; i < 12 && !logged; i++) {
        await sleep(750); // TikTok replaces its SSR/public header after hydration.
        if (this.platform === "tiktok") {
          pageEvidence = await page.evaluate(tiktokLoginEvidencePage).catch(() => ({
            state: "unknown" as const,
            reason: "no-auth-evidence" as const,
          }));
          if (pageEvidence.state === "signed-in") {
            this.acceptSignedInDetection();
            logged = true;
          }
        } else {
          logged = await this.detectLogin();
        }
      }

      // A current account endpoint separates “new markup fooled our selector”
      // from “TikTok really rejected this session”. It runs once per paste, never
      // in the ambient detector, and returns no account payload or identifiers.
      if (this.platform === "tiktok" && !logged && pageEvidence.state !== "challenge") {
        accountProbe = await page.evaluate(tiktokAccountProbePage).catch(() => ({
          state: "unknown" as const,
          httpStatus: null,
        }));
        if (accountProbe.state === "signed-in") {
          this.acceptSignedInDetection();
          logged = true;
        }
      }

      let privateRouteRejected = false;
      if (this.platform === "tiktok") {
        try {
          const finalPath = new URL(page.url()).pathname.toLowerCase();
          privateRouteRejected = finalPath === "/foryou" || finalPath.startsWith("/login") || finalPath.startsWith("/signup");
        } catch {
          /* an in-flight/blank URL stays inconclusive */
        }
      }
      const retained = cookieJarVerdict(await ctx.cookies(), plan, false);
      console.log(
        `[${this.platform}] cookie auth check: page=${pageEvidence.state}/${pageEvidence.reason}, ` +
          `account=${accountProbe.state}/http-${accountProbe.httpStatus ?? "none"}, ` +
          `private-route=${privateRouteRejected ? "rejected" : "not-rejected"}, ` +
          `jar=${retained.scoped}/${retained.expected}, session=${retained.sessionPresent ? "present" : "missing"}, ` +
          `navigation=${navigationSettled ? navigationStatus ?? "no-response" : "unsettled"}`
      );

      if (logged) {
        const detail =
          `Signed in on ${this.platform} — ${describePlan(plan)}. ` +
          `Authentication on ${this.platform} was confirmed, not inferred from cookie presence. ` +
          "Automatic posting stays off until Start; manual Post is available now.";
        this.broadcast({ type: "log", level: "ok", text: `✅ ${detail}`, at: Date.now() });
        this.broadcast({
          type: "toast",
          text: "Signed in with your cookie — press Start when you want the engine to run",
          tone: "ok",
        });
        return { ok: true, detail };
      }

      let detail: string;
      let toast: string;
      if (!retained.sessionPresent) {
        detail =
          `${plan.detail} — Chromium verified the write, but ${this.platform} removed ${plan.sessionName} during the account check. ` +
          "The service rejected this session for this browser identity. Export a fresh session from a currently signed-in web tab, " +
          "or sign in once in this account's live browser.";
        toast = "The site removed the session after import — use a fresh export or sign in here";
      } else if (pageEvidence.state === "challenge" || accountProbe.state === "challenge" || navigationStatus === 403 || navigationStatus === 429) {
        detail =
          `${plan.detail} — the browser retained ${retained.scoped}/${retained.expected} cookie scopes, but ${this.platform} requires a ` +
          "verification or anti-bot check on this Tor/browser identity. Complete that check in the live browser; pasting again will not solve it.";
        toast = "The cookie is present, but the site needs verification in the live browser";
      } else if (pageEvidence.state === "signed-out" || accountProbe.state === "signed-out" || privateRouteRejected) {
        const endpoint = accountProbe.httpStatus ? `; account check HTTP ${accountProbe.httpStatus}` : "";
        const pageReason = privateRouteRejected ? "private /profile check redirected to a signed-out route" : pageEvidence.reason;
        detail =
          `${plan.detail} — Chromium retained ${retained.scoped}/${retained.expected} cookie scopes, but ${this.platform} returned signed-out evidence ` +
          `(${pageReason}${endpoint}). The session is revoked, expired server-side, or bound to the source browser/network. ` +
          "Export it again from a currently signed-in web tab, or sign in once in this account's live browser.";
        toast = "The site rejected this session on the worker — use a fresh export or sign in here";
      } else {
        detail =
          `${plan.detail} — Chromium retained ${retained.scoped}/${retained.expected} cookie scopes, but ${this.platform} returned no authenticated ` +
          `account evidence (${pageEvidence.reason}; account check HTTP ${accountProbe.httpStatus ?? "unavailable"}). ` +
          "The cookie was written, but login is not safe to assume. Check the live browser and complete sign-in there if prompted.";
        toast = "Cookie retained, but login could not be confirmed — check the live browser";
      }
      this.broadcast({ type: "log", level: "warn", text: `⚠️ ${detail}`, at: Date.now() });
      this.broadcast({ type: "toast", text: toast, tone: "warn" });
      return { ok: false, detail };
    } catch {
      // Never surface the raw Playwright exception here. addCookies validation
      // errors can stringify the supplied cookie object, including its value.
      this.sessionMutation = false;
      if (jarChanged && !installed) {
        this.store.setCookie(this.platform, null, [], null);
        this.broadcastCookieState();
      }
      const detail = `${stage} failed; no cookie value was logged. Re-open the live browser and apply the export again.`;
      console.warn(`[${this.platform}] cookie install stopped at safe stage: ${stage}`);
      this.broadcast({ type: "log", level: "err", text: `⚠️ Session cookie not applied: ${detail}`, at: Date.now() });
      this.broadcast({ type: "toast", text: "The browser could not finish installing this session", tone: "warn" });
      return { ok: false, detail };
    } finally {
      this.sessionMutation = false;
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
      if (this.destroyed) throw new Error("This account runtime was deleted");
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
    if (this.destroyed) return Promise.reject(new Error("This account runtime was deleted"));
    if (cmd.t === "check-upload" && this.uploadAccessPending) {
      this.broadcast({
        type: "log",
        level: "info",
        text: "Upload access is already being checked — ignored the repeated request.",
        at: Date.now(),
      });
      return Promise.resolve();
    }
    if (cmd.t === "check-upload") this.uploadAccessPending = true;
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
      if (cmd.t === "check-upload") this.uploadAccessPending = false;
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
        // This probe navigates the visible tab through Studio. Treat it as worker
        // driving so a half-loaded /upload page cannot be mistaken for logout.
        // Repeated presses are coalesced in exec(), above.
        if (this.driving) {
          this.broadcast({
            type: "log",
            level: "info",
            text: "Upload access check skipped — a publish is already driving this browser tab.",
            at: Date.now(),
          });
          return;
        }
        this.driving = true;
        try {
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
        } finally {
          this.driving = false;
        }
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
        const was = this.autoVerify.on;
        const wasLabel = this.autoVerify.label;
        this.autoVerify.on = !!cmd.on;
        const label = (cmd.label || "").trim();
        if (label) this.autoVerify.label = label;
        if (!cmd.on) {
          this.autoVerify.sig = "";
          this.autoVerify.pressed = false;
          this.autoVerify.tries = 0;
        }
        // The deck re-pushes its auto-tap preference on every connect, and while the
        // browser is crash-looping that is a reconnect every few seconds — an
        // "armed" line each time, drowning the lines that matter. Say it on a
        // change, not on a repeat.
        if (this.autoVerify.on !== was || (this.autoVerify.on && this.autoVerify.label !== wasLabel)) {
          this.status(
            this.autoVerify.on
              ? `Auto-tap armed — I will press "${this.autoVerify.label}" myself when a verification screen is up.`
              : "Auto-tap disarmed — the deck is back to taps only."
          );
        }
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
          fallback = hit.rootish
            ? " · nothing above it is a control, so no DOM click was tried (a press here is the page ignoring the tap, not a miss by us)"
            : " · nothing landed on a control, so no DOM fallback was tried";
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
        const kind = hit.interactive ? (hit.container ? " (full-page container: this press dismisses the overlay)" : "") : " · NOT on an interactive element";
        const summary = `${where} → ${hit.under}${kind}; focus: ${hit.focused}${shifted}${fallback}${isHumanized(page) ? "" : " [PLAIN input]"}`;
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

  /** Terminal close used by account deletion, not idle hibernation. */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      await this.close();
      return;
    }
    this.destroyed = true;
    const error = new Error("This account runtime was deleted");
    for (const item of this.cmdQueue.splice(0)) item.reject(error);
    await this.close();
    // A command that was already holding the serialized input lock is forced to
    // fail by context.close(). Join it so no continuation can outlive disk rm.
    await this.inputTail.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    const task = (async () => {
      this.closing = true;
      this.stopLoops();
      // Do not clear clients: an authenticated socket can arrive in the tiny
      // gap between an idle check and context.close(). It should wait and then
      // relaunch this same profile, not become an untracked live connection.
      // A cold Chromium launch can outlive the 30-second hibernation grace. Join
      // it before teardown; otherwise it can finish after close(), take ownership
      // of the profile with no clients, and evade both hibernation and relaunch
      // serialization.
      if (!this.context && this.launching) await this.launching.catch(() => undefined);
      const ctx = this.context;
      this.teardown();
      this.lastFatal = null;
      try {
        await ctx?.close();
      } catch {
        /* already closed */
      } finally {
        this.closing = false;
      }
    })();
    this.closeInFlight = task;
    try {
      await task;
    } finally {
      if (this.closeInFlight === task) this.closeInFlight = null;
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

interface DiscoverySurfaceItem {
  url: string;
  label: string;
  likes?: number;
  views?: number;
  comments?: number;
}

const YT_SEARCH_QUERIES: Record<string, string[]> = {
  stories: ["faceless storytime shorts", "faceless stories shorts"],
  scary: ["scary creepy stories shorts", "scary stories shorts"],
  facts: ["mind blowing facts shorts", "amazing facts shorts"],
};

/** Search the exact custom topic, or scan the platform feed for a preset niche. */
export async function scrapeCandidates(
  page: Page,
  likesFloor: number,
  platform: "tiktok" | "instagram" | "youtube" = "tiktok",
  niche: string = "stories",
  rawTopic: string = "",
  log: (text: string) => void = () => undefined
): Promise<Candidate[]> {
  const topic = cleanDiscoveryTopic(rawTopic);
  if (platform === "youtube") return scrapeYouTubeCandidates(page, likesFloor, niche, topic);
  const searchUrl = topic
    ? discoverySearchUrl(platform, topic)
    : platform === "tiktok"
      ? "https://www.tiktok.com/foryou"
      : "https://www.instagram.com/reels/";
  const collectSurface = async (url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await sleep(4000);

    // A human watches the result surface before harvesting it: small scrolls with
    // reading pauses make lazy-loaded search/profile cards appear without a crawl.
    await page.mouse.wheel(0, Math.round(jitter(300, 700)));
    await readingPause(500, 1600);
    await page.mouse.wheel(0, Math.round(jitter(400, 900)));
    await readingPause(700, 2200);

    const rendered = await page.evaluate(() => {
      const out: DiscoverySurfaceItem[] = [];
      const hrefs = new Set<string>();
      const els = document.querySelectorAll("a[href*='/video/'], a[href*='/reel/']");
      for (const a of els) {
        const href = (a as HTMLAnchorElement).href.split("?")[0];
        if (hrefs.has(href)) continue;
        hrefs.add(href);
        const card =
          a.closest("[data-e2e='search_video-item-list'] > div, article, [data-e2e='user-post-item'], [role='listitem']") ||
          a.parentElement?.parentElement ||
          a;
        const label = [a.getAttribute("aria-label"), a.getAttribute("title"), card.textContent]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        out.push({ url: href, label: label.slice(0, 600) });
        if (out.length >= 40) break;
      }
      return out;
    });

    const parsed = new URL(url);
    if (platform !== "tiktok" || !/^\/@[^/]+\/?$/i.test(parsed.pathname)) return rendered;
    const handle = decodeURIComponent(parsed.pathname.slice(2)).replace(/\/$/, "");
    const structured = await page.evaluate(tiktokProfileItemsPage, handle).catch(() => [] as DiscoverySurfaceItem[]);
    const prioritized = [...structured].sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
    return [...prioritized, ...rendered].filter(
      (item, index, all) => all.findIndex((other) => other.url === item.url) === index
    );
  };

  // A topic such as `drdonutt` is also a creator handle. Search pages are often
  // client-rendered or challenge-gated in datacenter Chromium, while the signed-in
  // creator profile still exposes stable /video/ anchors. Profile results come
  // first so exact creator clips are inspected before looser keyword matches.
  const profileUrl = topic ? directTopicProfileUrl(platform, topic) : null;
  const profileItems = profileUrl ? await collectSurface(profileUrl) : [];
  const profileAboveFloor = profileItems.filter((item) => (item.likes ?? 0) >= likesFloor).length;
  const searchItems = profileUrl === searchUrl || profileAboveFloor >= 4 ? [] : await collectSurface(searchUrl);
  const items = [...profileItems, ...searchItems].filter(
    (item, index, all) => all.findIndex((other) => other.url === item.url) === index
  );
  if (topic) {
    log(
      `Discovery surfaces for “${topic}”: ${profileItems.length} direct-profile link${profileItems.length === 1 ? "" : "s"}` +
        `${searchItems.length ? ` + ${searchItems.length} search-result link${searchItems.length === 1 ? "" : "s"}` : ""}.`
    );
  }

  const ordered = topic
    ? items
        .map((item, index) => ({ item, index, relevance: topicRelevance(topic, item.label, item.url) }))
        // Search cards may render only a thumbnail/count until opened. Keep them
        // in this bounded set, then enforce exact relevance on full metadata.
        .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
        .map(({ item }) => item)
    : items;
  const candidates: Candidate[] = [];
  let inspected = 0;
  let readableLikes = 0;
  let aboveFloor = 0;
  for (const it of ordered.slice(0, topic ? 10 : 40)) {
    inspected += 1;
    let title = it.label.slice(0, 160) || "Untitled clip";
    let likes = it.likes ?? parseCount(it.label.match(/([\d.,]+[KMB]?)\s*likes?/i)?.[1]);
    let views = it.views ?? parseCount(it.label.match(/([\d.,]+[KMB]?)\s*views?/i)?.[1]);
    let comments = it.comments ?? parseCount(it.label.match(/([\d.,]+[KMB]?)\s*comments?/i)?.[1]);
    // Search cards often expose views but not likes. Open only entries without
    // structured profile counters; item_list rows already identify the exact post.
    if (topic && it.likes === undefined) {
      const stats = await readVideoStats(page, it.url);
      likes = stats.likes ?? likes;
      views = stats.views ?? views;
      comments = stats.comments ?? comments;
      const detail = await page
        .evaluate(() => {
          const title = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
          const description = document
            .querySelector('meta[property="og:description"], meta[name="description"]')
            ?.getAttribute("content");
          return (title || description || document.title || "").replace(/\s+/g, " ").trim();
        })
        .catch(() => "");
      if (detail) title = detail.slice(0, 160);
    }
    if (likes !== null) readableLikes += 1;
    if (likes !== null && likes >= likesFloor) aboveFloor += 1;
    if (likes && likes >= likesFloor && (!topic || isTopicMatch(topic, title, it.url))) {
      candidates.push({
        url: it.url,
        title,
        likes,
        views: views ?? 0,
        comments: comments ?? 0,
        commentSample: "",
      });
      if (candidates.length >= 4) break;
    }
  }
  if (topic) {
    log(
      `Inspected ${inspected} “${topic}” link${inspected === 1 ? "" : "s"}: ` +
        `${readableLikes} exposed like counts, ${aboveFloor} met the ${likesFloor.toLocaleString()}+ floor, ` +
        `${candidates.length} also passed exact relevance.`
    );
  }
  const ranked = rankDiscoveryCandidates(candidates, topic).slice(0, 12);
  // Instagram/TikTok search markup can be unavailable even to a signed-in
  // datacenter browser. Cross-source YouTube Shorts are still valid inputs to all
  // three uploaders and provide an exact-query fallback rather than reverting to
  // an unrelated personalized feed.
  if (topic && ranked.length < 4) {
    const youtube = await scrapeYouTubeCandidates(page, likesFloor, niche, topic);
    log(`Cross-source YouTube Shorts fallback added ${youtube.length} quality-approved “${topic}” result${youtube.length === 1 ? "" : "s"}.`);
    return rankDiscoveryCandidates([...ranked, ...youtube], topic).slice(0, 12);
  }
  return ranked;
}

/**
 * YouTube discovery: exact free-text query when present, otherwise a preset.
 * Every candidate is opened to enforce the account's likes floor before ranking.
 */
async function scrapeYouTubeCandidates(
  page: Page,
  likesFloor: number,
  niche: string,
  topic = ""
): Promise<Candidate[]> {
  const queries = topic
    ? Array.from(new Set(topicSearchAliases(topic).flatMap((alias) => [alias, `${alias} shorts`])))
    : YT_SEARCH_QUERIES[niche] ?? YT_SEARCH_QUERIES.stories;
  let hrefs: string[] = [];
  for (const query of queries) {
    await page
      .goto(discoverySearchUrl("youtube", query), { waitUntil: "domcontentloaded", timeout: 45_000 })
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
  for (const href of hrefs.slice(0, 10)) {
    if (candidates.length >= 8) break;
    try {
      const stats = await readVideoStats(page, href);
      const title = await page
        .evaluate(() => {
          const meta = document.querySelector('meta[property="og:title"]');
          return (meta?.getAttribute("content") || document.title || "YouTube Short")
            .replace(/\s*-\s*YouTube\s*$/, "")
            .replace(/\s+/g, " ")
            .trim();
        })
        .catch(() => "YouTube Short");
      if (
        stats.likes &&
        stats.likes >= likesFloor &&
        (!topic || isTopicMatch(topic, title, href))
      ) {
        candidates.push({
          url: href,
          title: title.slice(0, 160),
          likes: stats.likes,
          views: stats.views ?? 0,
          comments: stats.comments ?? 0,
          commentSample: "",
        });
      }
    } catch {
      /* skip unreadable short */
    }
  }
  return rankDiscoveryCandidates(candidates, topic);
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

export async function readVideoStats(page: Page, url: string): Promise<VideoStats> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await sleep(1500);
  } catch {
    return { views: null, likes: null, comments: null };
  }

  if (!new URL(page.url()).hostname.endsWith("youtube.com")) {
    try {
      const evidence = await page.evaluate(() => {
        const texts = (selectors: string[]) => {
          const values: string[] = [];
          const seen = new Set<Element>();
          for (const selector of selectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              if (seen.has(element)) continue;
              seen.add(element);
              const value = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              if (value) values.push(value.slice(0, 240));
            }
          }
          return values;
        };
        const jsonTexts: string[] = [];
        for (const script of Array.from(document.scripts)) {
          const text = script.textContent || "";
          if (!/(?:diggCount|playCount|commentCount|likeCount|video_view_count|aweme_id)/.test(text)) continue;
          if (text.length > 2_500_000) continue;
          jsonTexts.push(text);
          if (jsonTexts.length >= 8) break;
        }
        return {
          videoId: location.pathname.match(/\/(?:video|reel|p)\/([a-z0-9_-]+)/i)?.[1] || "",
          descriptions: Array.from(
            document.querySelectorAll('meta[property="og:description"], meta[name="description"], meta[property="og:title"]')
          )
            .map((meta) => meta.getAttribute("content") || "")
            .filter(Boolean)
            .slice(0, 6),
          bodyText: (document.body?.innerText || "").slice(0, 20_000),
          likeTexts: texts([
            '[data-e2e="like-count"]',
            '[data-e2e="browse-like-count"]',
            '[data-testid="like-count"]',
            '[aria-label*=" likes" i]',
            'button[aria-label*="like" i]',
          ]),
          viewTexts: texts([
            '[data-e2e="video-views"]',
            '[data-e2e="browse-video-views"]',
            '[data-e2e="view-count"]',
            '[aria-label*=" views" i]',
            '[aria-label*=" plays" i]',
          ]),
          commentTexts: texts([
            '[data-e2e="comment-count"]',
            '[data-e2e="browse-comment-count"]',
            '[data-testid="comment-count"]',
            '[aria-label*=" comments" i]',
            'button[aria-label*="comment" i]',
          ]),
          jsonTexts,
        };
      });
      return publicVideoStats(evidence);
    } catch {
      return { views: null, likes: null, comments: null };
    }
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
    });
  } catch {
    return { views: null, likes: null, comments: null };
  }
}
