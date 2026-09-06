import type { Platform } from "./types";
import type { ClientMsg, RemoteCmd, ServerMsg } from "./protocol";
import { WS_PING_INTERVAL_MS } from "./protocol";

export interface LiveBusHandlers {
  onFrame: (data: string) => void;
  onNav: (url: string) => void;
  onLogin: (loggedIn: boolean) => void;
  onLog: (level: string, text: string) => void;
  onEngine: (state: import("./protocol").EngineSnapshot) => void;
  onPostOk: (postId: string, postedAt: number, url: string) => void;
  onReady: (url: string) => void;
  onError: (message: string) => void;
  onStateChange: (connected: boolean) => void;
}

interface BusEntry {
  ws: WebSocket;
  seq: number;
  handlers: LiveBusHandlers;
  pingTimer: number;
}

const buses = new Map<Platform, BusEntry>();

export function connectLive(
  platform: Platform,
  wsUrl: string,
  token: string,
  handlers: LiveBusHandlers
): () => void {
  disconnectLive(platform);
  const ws = new WebSocket(normalizeWsUrl(wsUrl, platform));
  const entry: BusEntry = {
    ws,
    seq: 0,
    handlers,
    pingTimer: 0,
  };
  buses.set(platform, entry);

  ws.onopen = () => {
    const auth: ClientMsg = { type: "auth", token: token || "public" };
    ws.send(JSON.stringify(auth));
    entry.pingTimer = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cmd", seq: entry.seq++, cmd: { t: "ping" } } satisfies ClientMsg));
      }
    }, WS_PING_INTERVAL_MS);
    handlers.onStateChange(true);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      switch (msg.type) {
        case "ready":
          handlers.onReady(msg.url);
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
          handlers.onPostOk(msg.postId, msg.postedAt, msg.url);
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
    if (buses.get(platform)?.ws === ws) buses.delete(platform);
    handlers.onStateChange(false);
  };
  ws.onerror = () => {
    handlers.onError("Connection failed — is the worker running and reachable?");
  };

  return () => disconnectLive(platform);
}

export function disconnectLive(platform: Platform) {
  const entry = buses.get(platform);
  if (!entry) return;
  window.clearInterval(entry.pingTimer);
  try {
    entry.ws.close();
  } catch {
    /* noop */
  }
  buses.delete(platform);
}

export function sendBusCmd(platform: Platform, cmd: RemoteCmd): boolean {
  const entry = buses.get(platform);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
  const msg: ClientMsg = { type: "cmd", seq: entry.seq++, cmd };
  entry.ws.send(JSON.stringify(msg));
  return true;
}

export function sendBusRaw(platform: Platform, msg: ClientMsg): boolean {
  const entry = buses.get(platform);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
  entry.ws.send(JSON.stringify(msg));
  return true;
}

export function isLiveConnected(platform: Platform): boolean {
  const entry = buses.get(platform);
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

/** Accept wss://, ws://, https:// or bare domains; pin the ?platform= param. */
function normalizeWsUrl(input: string, platform: Platform): string {
  let u = input.trim();
  if (!u) return u;
  if (!/^wss?:\/\//i.test(u)) {
    u = u.replace(/^https?:\/\//i, (m) => (m.startsWith("https") ? "wss://" : "ws://"));
    if (!/^wss?:\/\//i.test(u)) u = `wss://${u}`;
  }
  try {
    const parsed = new URL(u);
    parsed.searchParams.set("platform", platform);
    return parsed.toString();
  } catch {
    return u;
  }
}
