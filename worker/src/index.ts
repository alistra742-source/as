import http from "node:http";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { env, driverInfo, PLATFORMS, START_URLS, stealth, type PlatformKey } from "./config.js";
import type { ClientMsg, ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { Rig } from "./browser.js";
import { GrowthEngine } from "./engine.js";
import { ensureDisplay } from "./display.js";

// Headed-by-default: make sure a display exists before anything touches the
// browser (starts Xvfb itself if the entrypoint was bypassed).
ensureDisplay();

/** Built frontend lives in dist/ at the repo root (single-service deploy). */
const DIST = path.resolve("dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Serve the Vite build with an SPA fallback to index.html. */
async function serveFrontend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    pathname = "/";
  }
  const filePath = path.normalize(path.join(DIST, pathname === "/" ? "index.html" : pathname));
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (path.extname(filePath) !== "") {
    // Real file (hashed asset, favicon, …). Missing asset = real 404.
    try {
      const data = await fsp.readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }

  // Extension-less path → SPA route: serve index.html.
  try {
    const data = await fsp.readFile(path.join(DIST, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("frontend build not found — run `npm run build` (produces dist/)");
  }
}

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
  // Single-service deploy: everything else is the frontend.
  void serveFrontend(req, res);
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
      send(ws, { type: "ready", sessionId: `rig-${platform}`, url: START_URLS[platform], driver: driverInfo() });
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
    `[viraldeck-worker] driver: Clearcote browser (${stealth.platform} persona, light stealth: ${stealth.lightStealth ? "on" : "off"}) ` +
      `driven nodriver-style (raw CDP, trusted humanized input: ${stealth.humanize ? "on" : "off"})`
  );
  console.log(
    env.groqKey
      ? `[viraldeck-worker] Groq connected (${env.groqModel})`
      : "[viraldeck-worker] No GROQ_API_KEY — running with heuristic fallbacks (add the key for AI captions + reviews)."
  );
});
