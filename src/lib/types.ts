import type { DriverInfo } from "./protocol";

export type Platform = "tiktok" | "instagram" | "youtube";

export type Niche = "stories" | "scary" | "facts";

export type SessionMode = "demo" | "live";

export type SessionState = "connecting" | "open" | "logged-in" | "error";

export type EnginePhase =
  | "idle"
  | "analyzing"
  | "discovering"
  | "reviewing"
  | "posting"
  | "waiting"
  | "paused"
  | "error";

export interface ManagedAccount {
  /** Opaque, path-safe key. Names are presentation only and can be changed later. */
  id: string;
  name: string;
  platform: Platform;
  createdAt: number;
  lastOpenedAt: number | null;
}

export interface BrowserSession {
  id: string;
  platform: Platform;
  mode: SessionMode;
  state: SessionState;
  url: string;
  startedAt: number;
  /** Live sessions only: what drives the remote browser (which Chromium, and how input is sent). */
  driver?: DriverInfo | null;
}

export interface MetricCheck {
  at: number;
  views: number;
  likes: number;
  comments: number;
}

export interface PostRecord {
  id: string;
  url: string;
  caption: string;
  niche: Niche;
  source: "manual" | "ai";
  audience: "Everyone";
  postedAt: number;
  checks: MetricCheck[];
  verdict: string | null;
}

export type LogLevel = "info" | "ok" | "warn" | "ai" | "err";

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  text: string;
}

export interface Candidate {
  id: string;
  url: string;
  title: string;
  niche: Niche;
  likes: number;
  views: number;
  comments: number;
  verdict?: "post" | "skip";
  reason?: string;
  captionDraft?: string;
}

export interface EngineState {
  running: boolean;
  phase: EnginePhase;
  /** Views within one hour that mark a post as a "hit". */
  thresholdViews: number;
  /** Likes floor for discovered faceless candidates. */
  likesFloor: number;
  cadenceHours: number;
  activeNiche: Niche;
  niches: Niche[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  message: string | null;
  candidates: Candidate[];
}

export interface ComposerState {
  url: string;
  caption: string;
  busy: boolean;
  error: string | null;
  lastPostedId: string | null;
}

export interface LiveLink {
  wsUrl: string;
  token: string;
  connected: boolean;
  lastError: string | null;
  /**
   * Metadata about a session cookie pasted into the login panel. Names and dates
   * only: the value never lands here, because this whole object is persisted to
   * localStorage and a session cookie IS a login. It goes straight from the input
   * to the worker and into the browser profile's own jar.
   */
  cookieAt: number | null;
  cookieNames: string[];
  cookieExpiresAt: number | null;
  /** Public OAuth status only. Google tokens remain encrypted on the worker and
   * are never sent to, logged by, or persisted in the frontend. */
  youtubeOAuthConfigured: boolean;
  youtubeOAuthConnected: boolean;
  youtubeOAuthError: string | null;
}

export interface Room {
  platform: Platform;
  /** Present for a named account room; omitted only by the empty account menu. */
  accountId?: string;
  accountName?: string;
  session: BrowserSession | null;
  composer: ComposerState;
  engine: EngineState;
  posts: PostRecord[];
  log: LogEntry[];
  live: LiveLink;
  /** When true the room collapsed into its compact summary state. */
  collapsed: boolean;
}

export const PLATFORMS: Platform[] = ["tiktok", "instagram", "youtube"];

export const NICHES: { id: Niche; label: string }[] = [
  { id: "stories", label: "Faceless stories" },
  { id: "scary", label: "Scary stories" },
  { id: "facts", label: "Fun facts" },
];

export const NICHE_LABEL: Record<Niche, string> = {
  stories: "Faceless stories",
  scary: "Scary stories",
  facts: "Fun facts",
};

export const START_URL: Record<Platform, string> = {
  tiktok: "https://www.tiktok.com/",
  instagram: "https://www.google.com/",
  youtube: "https://www.youtube.com/",
};

export const ROOM_ORDER: Record<Platform, number> = {
  tiktok: 1,
  instagram: 2,
  youtube: 3,
};
