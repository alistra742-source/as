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
export const stealth = {
  /** Where the SDK caches the verified Clearcote binary. In Docker this is
   * pre-downloaded at build time; locally it defaults to the SDK cache. */
  cacheDir: process.env.CLEARCOTE_CACHE_DIR || undefined,
  /** Pin a Clearcote browser build (e.g. "149" / "latest"). Defaults to the SDK's pinned release. */
  browserVersion: process.env.CLEARCOTE_BROWSER_VERSION || undefined,
  /** Fingerprint persona OS. "windows" is the default anti-bot persona (a
   * Windows Chrome desktop on a Linux host is what commercial anti-detect
   * browsers do). */
  platform: (process.env.STEALTH_PLATFORM || "windows") as "windows" | "linux" | "macos" | "android",
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
