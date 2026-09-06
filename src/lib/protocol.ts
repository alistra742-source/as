/**
 * Wire protocol between the ViralDeck frontend and the automation worker
 * (deployed on Railway). The implementation in `worker/` mirrors these
 * messages exactly.
 */

/** Raw commands sent from the dock to the remote browser. */
export type RemoteCmd =
  | { t: "navigate"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | { t: "home" }
  | { t: "tap"; x: number; y: number } // fraction of viewport 0..1
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
  | { type: "ready"; sessionId: string; url: string }
  | { type: "frame"; data: string; at: number } // JPEG base64
  | { type: "nav"; url: string; title: string }
  | { type: "login"; loggedIn: boolean }
  | { type: "log"; level: string; text: string; at: number }
  | { type: "engine"; state: EngineSnapshot }
  | { type: "post-ok"; postId: string; postedAt: number; url: string }
  | { type: "input-focused" } // a tap landed on a text field — open the device keyboard
  | { type: "error"; message: string };

export const WS_PING_INTERVAL_MS = 15_000;
