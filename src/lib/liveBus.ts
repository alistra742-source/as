import type { Platform } from "./types";
import { accountRoomKey } from "./accounts";
import { PROTOCOL_VERSION, type ClientMsg, type DriverInfo, type RemoteCmd, type ServerMsg } from "./protocol";
import { WS_PING_INTERVAL_MS } from "./protocol";

export interface LiveBusHandlers {
  onFrame: (data: string) => void;
  onNav: (url: string) => void;
  onLogin: (loggedIn: boolean) => void;
  onLog: (level: string, text: string) => void;
  onEngine: (state: import("./protocol").EngineSnapshot) => void;
  onPostOk: (postId: string, postedAt: number, url: string, requestId?: string) => void;
  /** The worker tried to publish and could not; the reason is for the composer. */
  onPostFailed?: (message: string, requestId?: string) => void;
  onReady: (url: string, driver?: DriverInfo, proto?: number) => void;
  onInputFocus: () => void;
  /** A one-line result worth showing over the stream (a tap that landed or missed). */
  onToast?: (text: string, tone: "info" | "ok" | "warn" | "err") => void;
  /** What the worker's profile currently holds from a pasted session cookie. */
  onCookieState?: (state: { appliedAt: number | null; names: string[]; expiresAt: number | null }) => void;
  onError: (message: string) => void;
  onStateChange: (connected: boolean) => void;
}

interface BusEntry {
  ws: WebSocket;
  seq: number;
  handlers: LiveBusHandlers;
  pingTimer: number;
}

// A platform alone is not an identity boundary: Personal TikTok and Brand
// TikTok must never share a command queue (or let a late close event mutate the
// newly opened account). Every socket is therefore pinned to the same room key
// used by the persisted room and the worker runtime.
const buses = new Map<string, BusEntry>();

export function connectLive(
  platform: Platform,
  wsUrl: string,
  token: string,
  handlers: LiveBusHandlers,
  accountId = "default",
  accountName = "Account"
): () => void {
  const key = accountRoomKey(platform, accountId);
  disconnectLive(platform, accountId);
  const ws = new WebSocket(normalizeWsUrl(wsUrl, platform, accountId, accountName));
  const entry: BusEntry = {
    ws,
    seq: 0,
    handlers,
    pingTimer: 0,
  };
  buses.set(key, entry);
  const isCurrent = () => buses.get(key)?.ws === ws;

  ws.onopen = () => {
    // A socket can finish opening after its account was left. Never authenticate
    // or report it as connected once its keyed entry has been replaced/removed.
    if (!isCurrent()) {
      ws.close();
      return;
    }
    const auth: ClientMsg = { type: "auth", token: token || "public", proto: PROTOCOL_VERSION };
    ws.send(JSON.stringify(auth));
    entry.pingTimer = window.setInterval(() => {
      if (isCurrent() && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cmd", seq: entry.seq++, cmd: { t: "ping" } } satisfies ClientMsg));
      }
    }, WS_PING_INTERVAL_MS);
    handlers.onStateChange(true);
  };
  ws.onmessage = (ev) => {
    if (!isCurrent()) return;
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      switch (msg.type) {
        case "ready":
          handlers.onReady(msg.url, msg.driver, msg.proto);
          break;
        case "frame":
          handlers.onFrame(msg.data);
          break;
        case "nav":
          handlers.onNav(msg.url);
          break;
        case "login":
          handlers.onLogin(msg.loggedIn);
          break;
        case "log":
          handlers.onLog(msg.level, msg.text);
          break;
        case "engine":
          handlers.onEngine(msg.state);
          break;
        case "post-ok":
          handlers.onPostOk(msg.postId, msg.postedAt, msg.url, msg.requestId);
          break;
        case "post-failed":
          handlers.onPostFailed?.(msg.message, msg.requestId);
          break;
        case "toast":
          handlers.onToast?.(msg.text, msg.tone ?? "info");
          break;
        case "cookie-state":
          handlers.onCookieState?.({
            appliedAt: msg.appliedAt,
            names: msg.names ?? [],
            expiresAt: msg.expiresAt ?? null,
          });
          break;
        case "input-focused":
          handlers.onInputFocus();
          break;
        case "error":
          handlers.onError(msg.message);
          break;
      }
    } catch {
      /* ignore malformed payloads */
    }
  };
  ws.onclose = () => {
    window.clearInterval(entry.pingTimer);
    // A deliberately disconnected/replaced account has already been removed.
    // Suppress its late close callback so it cannot mark another room offline.
    if (!isCurrent()) return;
    buses.delete(key);
    handlers.onStateChange(false);
  };
  ws.onerror = () => {
    if (isCurrent()) handlers.onError("Connection failed — is the worker running and reachable?");
  };

  return () => disconnectLive(platform, accountId);
}

export function disconnectLive(platform: Platform, accountId: string) {
  const key = accountRoomKey(platform, accountId);
  const entry = buses.get(key);
  if (!entry) return;
  // Delete before close: any already-queued message/close event is stale from
  // this point and its handlers are not allowed to touch account state.
  buses.delete(key);
  window.clearInterval(entry.pingTimer);
  try {
    entry.ws.close();
  } catch {
    /* noop */
  }
}

export function sendBusCmd(platform: Platform, accountId: string, cmd: RemoteCmd): boolean {
  const entry = buses.get(accountRoomKey(platform, accountId));
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
  const msg: ClientMsg = { type: "cmd", seq: entry.seq++, cmd };
  entry.ws.send(JSON.stringify(msg));
  return true;
}

export function sendBusRaw(platform: Platform, accountId: string, msg: ClientMsg): boolean {
  const entry = buses.get(accountRoomKey(platform, accountId));
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
  entry.ws.send(JSON.stringify(msg));
  return true;
}

/**
 * Hand a pasted session cookie to the worker for this platform's profile. The
 * value rides this one frame and is dropped by the deck right away — it is never
 * kept in the persisted store, nor echoed back into a log or a toast.
 */
export function sendBusCookie(
  platform: Platform,
  accountId: string,
  action: "apply" | "clear",
  value?: string
): boolean {
  const entry = buses.get(accountRoomKey(platform, accountId));
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
  const msg: ClientMsg = { type: "cookie", action, ...(value ? { value } : {}) };
  entry.ws.send(JSON.stringify(msg));
  return true;
}

export function isLiveConnected(platform: Platform, accountId: string): boolean {
  const entry = buses.get(accountRoomKey(platform, accountId));
  return !!entry && entry.ws.readyState === WebSocket.OPEN;
}

/**
 * Same-origin worker endpoint — the single-service deploy serves the frontend
 * AND the /ws socket on one domain, so the deck can auto-connect with nothing
 * pasted into the Worker card.
 */
export function defaultWorkerUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** Accept wss://, ws://, https:// or bare domains; pin the account scope. */
function normalizeWsUrl(input: string, platform: Platform, accountId: string, accountName: string): string {
  let u = input.trim();
  if (!u) return u;
  if (!/^wss?:\/\//i.test(u)) {
    u = u.replace(/^https?:\/\//i, (m) => (m.startsWith("https") ? "wss://" : "ws://"));
    if (!/^wss?:\/\//i.test(u)) u = `wss://${u}`;
  }
  try {
    const parsed = new URL(u);
    parsed.searchParams.set("platform", platform);
    parsed.searchParams.set("account", accountId);
    parsed.searchParams.set("name", accountName.slice(0, 48));
    return parsed.toString();
  } catch {
    return u;
  }
}
