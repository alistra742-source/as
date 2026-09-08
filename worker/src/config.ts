import fs from "node:fs";
import path from "node:path";
import type { DriverInfo } from "./protocol.js";

export const env = {
  port: Number(process.env.PORT || 8080),
  token: process.env.WORKER_TOKEN || "public",
  groqKey: process.env.GROQ_API_KEY || "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  /** Directory for persistent profiles (login cookies) + state. Mount a Railway volume here. */
  dataDir: path.resolve(process.env.STORAGE_DIR || "./data"),
  frameIntervalMs: Number(process.env.FRAME_INTERVAL_MS || 1200),
} as const;

/**
 * Stealth / driver configuration.
 *
 * The worker drives the open-source **Clearcote** anti-fingerprint Chromium
 * (engine-level fingerprint control compiled into the browser itself) the
 * **nodriver** way: raw CDP, no chromedriver / WebDriver layer, no
 * `--enable-automation`, and every input dispatched as *native trusted*
 * events with a human motor persona (minimum-jerk cursor paths, Fitts-scaled
 * timing, tremor, typos, thinking pauses). Vanilla Chromium is never
 * launched.
 */
/**
 * The cgroup this process actually lives in. `limit` is null when the container is
 * unbounded (a dev box) — not when the read failed, which is why the shape
 * distinguishes them. Read once per call, never cached: Railway resizes boxes
 * without restarting the process, and a stale limit is worse than none.
 */
export function cgroupMemoryMb(): { limit: number | null; used: number | null; oomKills: number | null } {
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch {
      return "";
    }
  };
  const bytesToMb = (v: string) => {
    const n = v && v !== "max" ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : null;
  };
  const killsFrom = (text: string) => {
    const m = /oom_kill\s+(\d+)/.exec(text);
    return m ? Number(m[1]) : null;
  };

  // cgroup v2 (Railway, and most images since 2021).
  const cur2 = read("/sys/fs/cgroup/memory.current");
  if (cur2) {
    return {
      used: bytesToMb(cur2),
      limit: bytesToMb(read("/sys/fs/cgroup/memory.max")),
      oomKills: killsFrom(read("/sys/fs/cgroup/memory.events")),
    };
  }
  // cgroup v1: "unlimited" is written as an absurd number, not "max".
  const cur1 = read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (cur1) {
    const limit = bytesToMb(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    return { used: bytesToMb(cur1), limit: limit && limit < 1e9 ? limit : null, oomKills: killsFrom(read("/sys/fs/cgroup/memory/memory.oom_control")) };
  }
  return { limit: null, used: null, oomKills: null };
}

/**
 * V8's old-space ceiling per renderer, in MB.
 *
 * This is a bigger deal than it looks: when a page's JS heap hits it, V8 aborts
 * the renderer and the tab dies with "Target crashed" — with *no* kernel OOM kill
 * and gigabytes of container memory free, which is exactly how it looks when
 * TikTok's upload studio (a heavy SPA that also decodes the file you just handed
 * it) takes the tab down. A fixed 384 MB was the right answer for a 512 MB
 * container and a lie for anything bigger, so it scales with the cgroup and can
 * be pinned with STEALTH_V8_HEAP_MB.
 */
export function v8HeapMb(): number {
  const pin = Number(process.env.STEALTH_V8_HEAP_MB || 0);
  if (Number.isFinite(pin) && pin >= 64) return Math.round(pin);
  const { limit } = cgroupMemoryMb();
  if (!limit) return 1024; // no cgroup limit: be generous, the host has room
  // ~30% of the box to renderer heaps, in 64 MB steps, never under 512.
  return Math.max(512, Math.min(2560, Math.round((limit * 0.3) / 64) * 64));
}

export const stealth = {
  /** Where the SDK caches the verified Clearcote binary. In Docker this is
   * pre-downloaded at build time; locally it defaults to the SDK cache. */
  cacheDir: process.env.CLEARCOTE_CACHE_DIR || undefined,
  /** Pin a Clearcote browser build (e.g. "149" / "latest"). Defaults to the SDK's pinned release. */
  browserVersion: process.env.CLEARCOTE_BROWSER_VERSION || undefined,
  /**
   * Optional LD_PRELOAD shim for setpriority(). Containers lack CAP_SYS_NICE,
   * so setpriority() returns EPERM — and the Clearcote pre-release binary is
   * DCHECK-enabled, so it FATALs where a release Chromium would silently
   * ignore it. The Docker image builds the shim and sets this automatically.
   */
  niceShim: process.env.STEALTH_NICE_SHIM || "",
  /** Fingerprint persona OS. Defaults to "linux" — Clearcote's own default
   * for the Linux binary, and the only host-coherent choice: a Windows
   * persona on a Linux host without a Windows-captured fingerprint profile
   * produces incoherent font/canvas hashes (the SDK warns loudly). Set
   * "windows"/"macos" only together with a matching captured profile. */
  platform: (process.env.STEALTH_PLATFORM || "linux") as "windows" | "linux" | "macos" | "android",
  /** Stable per-platform identity seed — same seed, same machine, forever.
   * Includes the worker token so two deployments get unlinkable identities. */
  seed: (p: PlatformKey) =>
    `${process.env.STEALTH_FINGERPRINT || "viraldeck"}-${p}-${process.env.WORKER_TOKEN || "public"}`,
  /** Coherent metadata spoof (hwConcurrency/deviceMemory/DPR/colorDepth/maxTouchPoints)
   * via native switches only — passes strict anti-bot checks. */
  lightStealth: process.env.STEALTH_LIGHT !== "false",
  /** Humanize ALL input (move/click/scroll/type) as trusted native events with
   * a seed-derived motor persona. nodriver-style human input. */
  humanize: process.env.STEALTH_HUMANIZE !== "false",
  /** Red cursor dot over the live stream so you can SEE the humanized motion. */
  showCursor: process.env.STEALTH_SHOW_CURSOR === "true",
  /** Headless by default on bare machines; the Docker image sets
   * STEALTH_HEADLESS=false and runs HEADED under Xvfb (headed Chrome avoids
   * headless-mode tells — the official Clearcote container does the same). */
  headless: process.env.STEALTH_HEADLESS !== "false",
  timezone: process.env.STEALTH_TIMEZONE || "America/New_York",
  acceptLanguage: process.env.STEALTH_LANG || "en-US,en",
  /** Idle drift: ambient cursor motion + occasional small scrolls on the
   * logged-in session so the account never looks parked. */
  idleDrift: process.env.STEALTH_IDLE_DRIFT !== "false",
  /** Random up-to-N minutes added on top of the 1-post/hour slot so posts
   * never land on a metronome beat. */
  cadenceJitterMin: Math.max(0, Number(process.env.STEALTH_CADENCE_JITTER_MIN || 9)),
  /** The engine waits a random 0-N minutes after arm/boot before its first
   * action — a fresh process that instantly posts is a bot tell. */
  bootDelayMaxMin: Math.max(0, Number(process.env.STEALTH_BOOT_DELAY_MAX_MIN || 8)),
  /** Random 0-N extra minutes before a metrics read is considered "due". */
  metricsJitterMin: Math.max(0, Number(process.env.STEALTH_METRICS_JITTER_MIN || 4)),
} as const;

export const driverInfo = (): DriverInfo => ({
  engine: "clearcote",
  drive: "nodriver-cdp",
  humanize: stealth.humanize,
  lightStealth: stealth.lightStealth,
  platform: stealth.platform,
  headless: stealth.headless,
  timezone: stealth.timezone,
});

export const START_URLS = {
  tiktok: "https://www.tiktok.com/",
  instagram: "https://www.google.com/",
  youtube: "https://www.youtube.com/",
} as const;

export type PlatformKey = keyof typeof START_URLS;

export const PLATFORMS = Object.keys(START_URLS) as PlatformKey[];

export const HOUR_MS = 3_600_000;

export const ENGINE_PHASES = [
  "idle",
  "analyzing",
  "discovering",
  "reviewing",
  "posting",
  "waiting",
  "paused",
  "error",
] as const;

export type EnginePhase = (typeof ENGINE_PHASES)[number];
