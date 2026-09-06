import path from "node:path";

export const env = {
  port: Number(process.env.PORT || 8080),
  token: process.env.WORKER_TOKEN || "public",
  groqKey: process.env.GROQ_API_KEY || "",
  groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  /** Directory for persistent profiles (login cookies) + state. Mount a Railway volume here. */
  dataDir: path.resolve(process.env.STORAGE_DIR || "./data"),
  frameIntervalMs: Number(process.env.FRAME_INTERVAL_MS || 1200),
  // Optional Browserbase cloud browsers (better anti-bot). When unset the
  // worker launches its own Chromium (Railway / Docker).
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || "",
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID || "",
} as const;

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
