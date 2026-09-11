/**
 * Wire protocol between the ViralDeck frontend and the automation worker
 * (deployed on Railway). The implementation in `worker/` mirrors these
 * messages exactly.
 */

/** What drives the browser on the worker side (shown as a badge in the deck). */
export interface DriverInfo {
  /** Which browser was launched. `playwright` is the default: stock Chromium. */
  engine: "clearcote" | "playwright";
  /** How input is sent. Both are raw CDP — no WebDriver layer in either engine. */
  drive: "nodriver-cdp" | "playwright-cdp";
  humanize: boolean;
  lightStealth: boolean;
  platform: string;
  headless: boolean;
  timezone: string;
}

/** Raw commands sent from the dock to the remote browser. */
export type RemoteCmd =
  | { t: "navigate"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | { t: "home" }
  /** Press the visible control showing this text — no coordinates involved. */
  | { t: "click-label"; label: string }
  /** Deck-driven: tap the verification method itself when that screen appears. */
  | { t: "auto-verify"; on: boolean; label?: string }
  /**
   * Ask the site's upload page whether this session may post at all, and report
   * that instead of making the user wait through a full publish to find out.
   */
  | { t: "check-upload" }
  | { t: "tap"; x: number; y: number } // fraction of the displayed frame 0..1
  | { t: "scroll"; dy: number } // px, positive = down
  | { t: "type"; text: string }
  | { t: "key"; key: "Backspace" | "Enter" | "Tab" | "Escape" }
  | { t: "ping" };

/**
   * What the deck and the worker must agree on. Bump it whenever a command or a
   * message is added: the deck then tells the user the worker is behind instead
   * of pressing a button whose command the old worker swallows in silence.
   */
export const PROTOCOL_VERSION = 13;

export type ClientMsg =
  | { type: "auth"; token: string; proto: number }
  | { type: "cmd"; seq: number; cmd: RemoteCmd }
  | { type: "engine"; action: "start" | "stop" }
  | { type: "engine-config"; topic: string; thresholdViews?: number; likesFloor?: number }
  | { type: "post"; url: string; caption: string; requestId: string }
  | { type: "discover-post"; topic: string; caption: string; requestId: string }
  | { type: "post-status"; requestId: string }
  | { type: "session"; action: "open" | "close" }
  /**
   * Sign the profile in with a session cookie pasted into the deck instead of
   * clicking through the site's login wall inside a streamed screenshot. `apply`
   * writes the cookie and reloads the site so it notices; `clear` empties this
   * profile's jar. The socket is already scoped to one platform's profile, so
   * there is nothing else to address. Write-only as far as this protocol goes:
   * the value never comes back in a log line, a toast or the `cookie-state`
   * answer — only cookie names and timestamps do.
   */
  | { type: "cookie"; action: "apply" | "clear"; value?: string };

export interface LastPostSnapshot {
  id: string;
  url: string;
  /** Original source URL, used only to reconcile an optimistic row after reconnect. */
  sourceUrl?: string;
  /** Opaque deck request id; never an account id or credential. */
  requestId?: string;
  caption: string;
  niche: string;
  topic?: string;
  source: "manual" | "ai";
  postedAt: number;
  views: number;
  likes: number;
  comments: number;
  verdict: string | null;
}

export interface ManualPublishResult {
  requestId: string;
  status: "accepted" | "succeeded" | "failed";
  message: string;
  at: number;
  postId?: string;
  postedAt?: number;
  /** Confirmed destination URL only; omitted when a studio confirms without exposing one. */
  url?: string;
}

export interface EngineSnapshot {
  running: boolean;
  phase: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  message: string | null;
  cadenceHours: number;
  thresholdViews: number;
  likesFloor: number;
  /** Account-persisted exact free-text query; blank means cycle the built-in niches. */
  topic: string;
  loggedIn: boolean;
  /** A user-requested publish is still running on this exact account runtime. */
  manualBusy: boolean;
  /** Exact active request, so a stale `manualBusy:false` cannot cancel a newer click. */
  manualRequestId: string | null;
  /** Last correlated acknowledgement/terminal receipt, persisted for reconnects. */
  manualResult: ManualPublishResult | null;
  lastPost: LastPostSnapshot | null;
}

export type ServerMsg =
  | { type: "ready"; sessionId: string; url: string; driver?: DriverInfo; proto?: number }
  | { type: "frame"; data: string; at: number } // JPEG base64
  | { type: "nav"; url: string; title: string }
  | { type: "login"; loggedIn: boolean }
  | { type: "log"; level: string; text: string; at: number }
  | { type: "engine"; state: EngineSnapshot }
  | { type: "post-ok"; postId: string; postedAt: number; url: string; requestId?: string }
  /**
   * A publish the user asked for and that did not happen, with the reason. The
   * deck's Post button otherwise has to guess when nothing arrived, which is how
   * a blocked video grab reads as "I clicked and nothing happened".
   */
  | { type: "post-failed"; message: string; requestId?: string }
  | { type: "toast"; text: string; tone?: "info" | "ok" | "warn" | "err" } // a one-line result the deck should show, not just log
  | { type: "input-focused" } // a tap landed on a text field — open the device keyboard
  /** Whether a pasted session cookie is installed in this profile, so the panel
   * tells the truth after a reload. Names and timestamps only — the value stays
   * inside the browser profile, never in a log line or a toast. */
  | { type: "cookie-state"; appliedAt: number | null; names: string[]; expiresAt?: number | null }
  | { type: "error"; message: string };

export const WS_PING_INTERVAL_MS = 15_000;
