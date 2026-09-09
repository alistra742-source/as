import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../src/lib/liveBus.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");

class FakeWebSocket {
  static OPEN = 1;
  static all = [];
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.all.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const fakeWindow = {
  location: { protocol: "https:", host: "deck.example" },
  setInterval: () => 1,
  clearInterval: () => undefined,
};
const accountRoomKey = (platform, accountId) => `${platform}:${accountId}`;
const load = new Function(
  "WebSocket",
  "window",
  "accountRoomKey",
  "PROTOCOL_VERSION",
  "WS_PING_INTERVAL_MS",
  `${js}; return { connectLive, disconnectLive, sendBusCmd, isLiveConnected };`
);
const { connectLive, disconnectLive, sendBusCmd, isLiveConnected } = load(
  FakeWebSocket,
  fakeWindow,
  accountRoomKey,
  10,
  15_000
);

function handlers(events) {
  return {
    onFrame: () => undefined,
    onNav: () => undefined,
    onLogin: () => undefined,
    onLog: () => undefined,
    onEngine: () => undefined,
    onPostOk: () => undefined,
    onReady: () => undefined,
    onInputFocus: () => undefined,
    onError: (message) => events.push(message),
    onStateChange: (connected) => events.push(connected),
  };
}

test("two named accounts on one platform own independent sockets and command queues", () => {
  FakeWebSocket.all.length = 0;
  const personalEvents = [];
  const brandEvents = [];
  connectLive("youtube", "wss://deck.example/ws", "token", handlers(personalEvents), "personal", "Personal");
  connectLive("youtube", "wss://deck.example/ws", "token", handlers(brandEvents), "brand", "Brand");
  const [personal, brand] = FakeWebSocket.all;
  personal.open();
  brand.open();

  assert.equal(isLiveConnected("youtube", "personal"), true);
  assert.equal(isLiveConnected("youtube", "brand"), true);
  assert.match(personal.url, /account=personal/);
  assert.match(brand.url, /account=brand/);

  sendBusCmd("youtube", "personal", { t: "home" });
  sendBusCmd("youtube", "brand", { t: "reload" });
  assert.equal(personal.sent.at(-1).cmd.t, "home");
  assert.equal(brand.sent.at(-1).cmd.t, "reload");

  disconnectLive("youtube", "personal");
  assert.equal(isLiveConnected("youtube", "personal"), false);
  assert.equal(isLiveConnected("youtube", "brand"), true);
  assert.deepEqual(brandEvents, [true]);
});

test("a disconnected account's queued events are ignored instead of reaching a new room", () => {
  FakeWebSocket.all.length = 0;
  const events = [];
  connectLive("tiktok", "wss://deck.example/ws", "token", handlers(events), "old", "Old");
  const old = FakeWebSocket.all[0];
  old.open();
  disconnectLive("tiktok", "old");
  old.message({ type: "error", message: "stale browser error" });
  assert.deepEqual(events, [true]);
});

test("manual publish receipts preserve their request id for strict reconciliation", () => {
  FakeWebSocket.all.length = 0;
  const received = [];
  const wired = {
    ...handlers([]),
    onPostOk: (...args) => received.push(["ok", ...args]),
    onPostFailed: (...args) => received.push(["failed", ...args]),
  };
  connectLive("youtube", "wss://deck.example/ws", "token", wired, "personal", "Personal");
  const socket = FakeWebSocket.all[0];
  socket.open();
  socket.message({
    type: "post-ok",
    postId: "worker-post",
    postedAt: 123,
    url: "https://www.youtube.com/watch?v=AbCdEf12345",
    requestId: "post-request-a",
  });
  socket.message({ type: "post-failed", message: "blocked", requestId: "post-request-b" });
  assert.deepEqual(received, [
    ["ok", "worker-post", 123, "https://www.youtube.com/watch?v=AbCdEf12345", "post-request-a"],
    ["failed", "blocked", "post-request-b"],
  ]);
});
