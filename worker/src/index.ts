import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { env, PLATFORMS, START_URLS, type PlatformKey } from "./config.js";
import type { ClientMsg, ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { Rig } from "./browser.js";
import { GrowthEngine } from "./engine.js";

const store = new Store();
const rigs = new Map<PlatformKey, Rig>();
const engines = new Map<PlatformKey, GrowthEngine>();

for (const p of PLATFORMS) {
  const rig = new Rig(p, store);
  rigs.set(p, rig);
  engines.set(p, new GrowthEngine(p, store, rig));
  engines.get(p)!.resumeFromBoot();
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, platforms: PLATFORMS, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const platform = (url.searchParams.get("platform") || "tiktok") as PlatformKey;
  if (!PLATFORMS.includes(platform)) {
    send(ws, { type: "error", message: `Unknown platform ${platform}` });
    ws.close();
    return;
  }
  const rig = rigs.get(platform)!;
  const engine = engines.get(platform)!;
  let authed = false;

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    if (!authed) {
      if (msg.type !== "auth" || msg.token !== env.token) {
        send(ws, { type: "error", message: "Bad worker token" });
        ws.close();
        return;
      }
      authed = true;
      const client = {
        __ws: ws,
        send: (m: ServerMsg) => send(ws, m),
      } as { __ws: WebSocket; send: (m: ServerMsg) => void };
      rig.clients.add(client);
      send(ws, { type: "ready", sessionId: `rig-${platform}`, url: START_URLS[platform] });
      send(ws, { type: "engine", state: engine.snapshot() });
      void rig.openControlSession().catch((e) =>
        send(ws, { type: "error", message: `Browser start failed: ${(e as Error).message}` })
      );
      return;
    }

    switch (msg.type) {
      case "cmd":
        rig.exec(msg.cmd).catch((e) =>
          send(ws, { type: "error", message: `Command failed: ${(e as Error).message}` })
        );
        return;
      case "engine":
        if (msg.action === "start") engine.start();
        else engine.stop();
        return;
      case "post":
        void engine.manualPost(msg.url, msg.caption);
        return;
      case "session":
        if (msg.action === "close") void rig.close();
        return;
    }
  });

  ws.on("close", () => {
    rig.clients.forEach((c) => {
      if ((c as { __ws?: WebSocket }).__ws === ws) rig.clients.delete(c);
    });
  });
  ws.on("error", () => {
    /* socket level noise — clients prune themselves on close */
  });
});

server.listen(env.port, "0.0.0.0", () => {
  console.log(`[viraldeck-worker] listening on 0.0.0.0:${env.port}`);
  console.log(`[viraldeck-worker] platforms: ${PLATFORMS.join(", ")}`);
  console.log(
    env.groqKey
      ? `[viraldeck-worker] Groq connected (${env.groqModel})`
      : "[viraldeck-worker] No GROQ_API_KEY — running with heuristic fallbacks (add the key for AI captions + reviews)."
  );
});
