/**
 * Wire protocol between the ViralDeck frontend and the automation worker
 * (deployed on Railway). The implementation in `worker/` mirrors these
 * messages exactly.
 */

/** What drives the browser on the worker side (shown as a badge in the deck). */
export interface DriverInfo {
  engine: "clearcote";
  /** nodriver-style driving: raw CDP, no WebDriver layer, trusted human input. */
  drive: "nodriver-cdp";
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
  | { t: "tap"; x: number; y: number } // fraction of the displayed frame 0..1
  | { t: "scroll"; dy: number } // px, positive = down
  | { t: "type"; text: string }
  | { t: "key"; key: "Backspace" | "Enter" | "Tab" | "Escape" }
  | { t: "ping" };

export type ClientMsg =
  | { type: "auth"; token: string }
  | { type: "cmd"; seq: number; cmd: RemoteCmd }
  | { type: "engine"; action: "start" | "stop" }
  | { type: "post"; url: string; caption: string }
  | { type: "session"; action: "open" | "close" };

export interface LastPostSnapshot {
  id: string;
  url: string;
  caption: string;
  niche: string;
  source: "manual" | "ai";
  postedAt: number;
  views: number;
  likes: number;
  comments: number;
  verdict: string | null;
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
  loggedIn: boolean;
  lastPost: LastPostSnapshot | null;
}

export type ServerMsg =
  | { type: "ready"; sessionId: string; url: string; driver?: DriverInfo }
  | { type: "frame"; data: string; at: number } // JPEG base64
  | { type: "nav"; url: string; title: string }
  | { type: "login"; loggedIn: boolean }
  | { type: "log"; level: string; text: string; at: number }
  | { type: "engine"; state: EngineSnapshot }
  | { type: "post-ok"; postId: string; postedAt: number; url: string }
  | { type: "toast"; text: string; tone: "ok" | "warn" } // a one-line result the deck should show, not just log
  | { type: "input-focused" } // a tap landed on a text field — open the device keyboard
  | { type: "error"; message: string };

export const WS_PING_INTERVAL_MS = 15_000;
