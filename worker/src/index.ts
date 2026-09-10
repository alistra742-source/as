import crypto from "node:crypto";
import http from "node:http";
import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { env, driverInfo, PLATFORMS, START_URLS, stealth, type PlatformKey } from "./config.js";
import {
  accountDeletionPlan,
  accountScopeKey,
  LEGACY_ACCOUNT_ID,
  parseAccountDir,
  validAccountId,
} from "./accountScope.js";
import { BLOCKED_HOSTS, resolverRules } from "./browserLaunch.js";
import { closeAccountTorProxy, torHealth, warmTor } from "./torProxy.js";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from "./protocol.js";
import { Store } from "./store.js";
import { Rig, browserPreflight } from "./browser.js";
import { GrowthEngine } from "./engine.js";
import { ensureDisplay } from "./display.js";
import {
  beginYouTubeOAuth,
  completeYouTubeOAuth,
  disconnectYouTubeOAuth,
  purgeYouTubeOAuthAccount,
  youtubeOAuthStatus,
} from "./youtubeOAuth.js";

// Headed-by-default: make sure a display exists before anything touches the
// browser (starts Xvfb itself if the entrypoint was bypassed).
ensureDisplay();
// Begin Tor bootstrap before Railway's first health probe or any account tries
// to launch Chromium. The proxy module logs the concrete failure; this catch
// prevents a rejected readiness promise from becoming an unhandled rejection.
void warmTor().catch(() => undefined);

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
      // Vite fingerprints everything under /assets/, so those URLs can never go
      // stale — and they were being refetched on every reload at 300 KB a pop,
      // which shows up as the deck itself being the slow part of a deploy.
      const immutable = pathname.startsWith("/assets/") && /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/i.test(pathname);
      res.writeHead(200, {
        "content-type": type,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
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

interface AccountRuntime {
  platform: PlatformKey;
  accountId: string;
  store: Store;
  rig: Rig;
  engine: GrowthEngine;
  deleting: boolean;
}

const legacyStore = new Store();
const runtimes = new Map<string, AccountRuntime>();
const deletingScopes = new Set<string>();
const deletionJobs = new Map<string, Promise<void>>();

function safeAccountName(raw: string | null | undefined, fallback: string): string {
  return (raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || fallback;
}

function accountRuntime(platform: PlatformKey, accountId: string, requestedName?: string): AccountRuntime {
  const key = accountScopeKey(platform, accountId);
  if (deletingScopes.has(key)) throw new Error("This account is being deleted");
  const existing = runtimes.get(key);
  if (existing) {
    if (existing.deleting) throw new Error("This account is being deleted");
    if (requestedName) existing.rig.setAccountName(safeAccountName(requestedName, existing.rig.accountName));
    return existing;
  }
  const store = accountId === LEGACY_ACCOUNT_ID ? legacyStore : new Store(platform, accountId);
  const rememberedName = store.rig(platform).profile;
  const name = safeAccountName(requestedName || rememberedName, accountId === LEGACY_ACCOUNT_ID ? "Existing account" : "Account");
  const rig = new Rig(platform, store, accountId, name);
  const engine = new GrowthEngine(platform, store, rig);
  const runtime = { platform, accountId, store, rig, engine, deleting: false };
  runtimes.set(key, runtime);
  engine.resumeFromBoot();
  return runtime;
}

// Backward-compatible runtimes preserve the old `/data/profile-tiktok` etc.
for (const platform of PLATFORMS) accountRuntime(platform, LEGACY_ACCOUNT_ID);

// Named account engines survive deploys even when nobody has reopened their UI
// yet. Profile cookies remain on disk and an armed engine resumes from state.
try {
  const root = path.join(env.dataDir, "accounts");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseAccountDir(entry.name);
    if (parsed) accountRuntime(parsed.platform, parsed.accountId);
  }
} catch {
  /* no named accounts yet */
}

class AccountBusyError extends Error {}

function closeAccountSockets(runtime: AccountRuntime) {
  const clients = [...runtime.rig.clients];
  runtime.rig.clients.clear();
  for (const client of clients) {
    try {
      (client as { __ws?: WebSocket }).__ws?.close(1001, "Account deleted");
    } catch {
      /* an already-closed socket cannot block deletion */
    }
  }
}

/** Stop runtime ownership first, then delete only the validated account scope. */
async function performAccountDeletion(platform: PlatformKey, accountId: string): Promise<void> {
  const key = accountScopeKey(platform, accountId);
  const plan = accountDeletionPlan(env.dataDir, platform, accountId);
  const runtime = runtimes.get(key);

  // Stop future automatic work immediately. A publish already in flight is not
  // safe to tear out from under Chromium, so report 409 and require one retry
  // after it finishes rather than deleting files while they are still in use.
  runtime?.engine.stop();
  if (runtime?.engine.isBusy()) {
    throw new AccountBusyError("That account is finishing a publish. Its engine was stopped; retry Delete when the publish finishes.");
  }

  deletingScopes.add(key);
  try {
    if (runtime) {
      runtime.deleting = true;
      closeAccountSockets(runtime);
      await runtime.rig.destroy();
      runtimes.delete(key);
    }
    closeAccountTorProxy(platform, accountId);

    if (platform === "youtube") await purgeYouTubeOAuthAccount(accountId);
    if (plan.legacy) {
      // Never rm(env.dataDir): default runtimes share that root. Reset one slice
      // and remove only `/data/profile-<platform>`.
      legacyStore.resetPlatform(platform);
      await fsp.rm(plan.profileDir, { recursive: true, force: true });
    } else {
      await fsp.rm(plan.accountDir as string, { recursive: true, force: true });
    }
  } finally {
    if (runtime && runtimes.get(key) === runtime) runtime.deleting = false;
    deletingScopes.delete(key);
  }
}

function deleteAccount(platform: PlatformKey, accountId: string): Promise<void> {
  const key = accountScopeKey(platform, accountId);
  const existing = deletionJobs.get(key);
  if (existing) return existing;
  const job = performAccountDeletion(platform, accountId);
  deletionJobs.set(key, job);
  void job
    .finally(() => {
      if (deletionJobs.get(key) === job) deletionJobs.delete(key);
    })
    .catch(() => undefined);
  return job;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function authorizedHttp(req: http.IncomingMessage): boolean {
  const value = String(req.headers.authorization || "");
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const expected = env.token;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > 16_384) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function sendOAuthPage(
  res: http.ServerResponse,
  result: { ok: boolean; title: string; message: string; accountId?: string },
  status = 200
) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const event = JSON.stringify({
    type: "viraldeck-youtube-oauth",
    ok: result.ok,
    accountId: result.accountId || null,
    message: result.message,
  }).replace(/</g, "\\u003c");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(result.title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b12;color:#e8ebf3;font:16px system-ui,sans-serif}main{max-width:520px;margin:24px;padding:28px;border:1px solid #293041;border-radius:18px;background:#111621;box-shadow:0 24px 70px #0008}h1{font-size:22px;margin:0 0 10px;color:${result.ok ? "#86efac" : "#fca5a5"}}p{line-height:1.55;color:#b6bfd1}a{color:#fbbf24}</style></head>
<body><main><h1>${htmlEscape(result.title)}</h1><p>${htmlEscape(result.message)}</p><p><a href="/">Return to ViralDeck</a></p></main>
<script nonce="${nonce}">try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${event},window.location.origin);setTimeout(()=>window.close(),900)}}catch{}</script>
</body></html>`);
}

async function routeHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    const tor = torHealth();
    if (tor.enabled && tor.state === "failed") void warmTor().catch(() => undefined);
    const ready = !tor.enabled || tor.state === "ready";
    sendJson(res, ready ? 200 : 503, { ok: ready, platforms: PLATFORMS, uptime: process.uptime(), tor });
    return;
  }

  if (url.pathname === "/api/accounts/delete") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!authorizedHttp(req)) {
      sendJson(res, 401, { error: "Bad worker token" });
      return;
    }
    try {
      const body = await readJson(req);
      const rawPlatform = typeof body.platform === "string" ? body.platform : "";
      const platform = PLATFORMS.includes(rawPlatform as PlatformKey) ? (rawPlatform as PlatformKey) : null;
      const accountId = validAccountId(typeof body.accountId === "string" ? body.accountId : "");
      if (!platform || !accountId) throw new Error("Invalid account scope");
      await deleteAccount(platform, accountId);
      sendJson(res, 200, { ok: true, deleted: { platform, accountId } });
    } catch (error) {
      if (error instanceof AccountBusyError) {
        sendJson(res, 409, { error: error.message });
      } else if ((error as Error).message === "Invalid account scope") {
        sendJson(res, 400, { error: "Invalid account scope" });
      } else {
        console.error(`[account-delete] failed: ${(error as Error).message || String(error)}`);
        sendJson(res, 500, { error: "The worker could not safely remove that account's stored data. Nothing was removed from the deck." });
      }
    }
    return;
  }

  if (url.pathname === "/callback" && req.method === "GET") {
    const denied = url.searchParams.get("error");
    if (denied) {
      const detail = safeAccountName(url.searchParams.get("error_description"), "Google authorization was cancelled.");
      sendOAuthPage(res, { ok: false, title: "YouTube was not connected", message: detail }, 400);
      return;
    }
    try {
      const completed = await completeYouTubeOAuth(
        url.searchParams.get("code") || "",
        url.searchParams.get("state") || ""
      );
      const runtime = accountRuntime("youtube", completed.accountId, completed.accountName);
      runtime.rig.broadcast({ type: "engine", state: runtime.engine.snapshot() });
      sendOAuthPage(res, {
        ok: true,
        title: "YouTube connected",
        message: `${completed.accountName} may now upload through the official YouTube API. You can close this window.`,
        accountId: completed.accountId,
      });
    } catch (error) {
      sendOAuthPage(
        res,
        {
          ok: false,
          title: "YouTube connection failed",
          message: (error as Error).message || "The Google authorization could not be completed.",
        },
        400
      );
    }
    return;
  }

  if (url.pathname.startsWith("/api/youtube/oauth/")) {
    if (!authorizedHttp(req)) {
      sendJson(res, 401, { error: "Bad worker token" });
      return;
    }
    try {
      if (url.pathname === "/api/youtube/oauth/status" && req.method === "GET") {
        const accountId = validAccountId(url.searchParams.get("account"));
        if (!accountId) throw new Error("Invalid YouTube account id");
        sendJson(res, 200, youtubeOAuthStatus(accountId));
        return;
      }
      if (url.pathname === "/api/youtube/oauth/start" && req.method === "POST") {
        const body = await readJson(req);
        const accountId = validAccountId(typeof body.accountId === "string" ? body.accountId : "");
        if (!accountId) throw new Error("Invalid YouTube account id");
        const name = safeAccountName(typeof body.accountName === "string" ? body.accountName : "", "YouTube account");
        sendJson(res, 200, { url: beginYouTubeOAuth(accountId, name) });
        return;
      }
      if (url.pathname === "/api/youtube/oauth/disconnect" && req.method === "POST") {
        const body = await readJson(req);
        const accountId = validAccountId(typeof body.accountId === "string" ? body.accountId : "");
        if (!accountId) throw new Error("Invalid YouTube account id");
        await disconnectYouTubeOAuth(accountId);
        const runtime = accountRuntime("youtube", accountId);
        runtime.rig.broadcast({ type: "engine", state: runtime.engine.snapshot() });
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 400, { error: (error as Error).message || "YouTube OAuth request failed" });
    }
    return;
  }

  // Single-service deploy: everything else is the frontend.
  await serveFrontend(req, res);
}

const server = http.createServer((req, res) => {
  void routeHttp(req, res).catch((error) => {
    console.error(`[http] request failed: ${(error as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    else res.end();
  });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

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
  const accountId = validAccountId(url.searchParams.get("account") || LEGACY_ACCOUNT_ID);
  if (!accountId) {
    send(ws, { type: "error", message: "Invalid account id" });
    ws.close();
    return;
  }
  const accountName = safeAccountName(url.searchParams.get("name"), "Account");
  // Do not create stores, rename profiles, or resume engines from query params
  // until the socket proves it knows the worker token.
  let runtime: AccountRuntime | null = null;
  let authed = false;
  const authTimer = setTimeout(() => ws.close(1008, "Authentication timed out"), 10_000);
  authTimer.unref?.();

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return;
    const msg = parsed as ClientMsg;
    if (!authed) {
      if (msg.type !== "auth" || msg.token !== env.token) {
        send(ws, { type: "error", message: "Bad worker token" });
        ws.close();
        return;
      }
      if (msg.proto !== PROTOCOL_VERSION) {
        const deckVersion = typeof msg.proto === "number" ? msg.proto : 0;
        const message =
          deckVersion < PROTOCOL_VERSION
            ? `This deck tab is outdated (protocol v${deckVersion || "unknown"}; worker v${PROTOCOL_VERSION}). Hard-refresh the page before publishing.`
            : `This worker is outdated (deck protocol v${deckVersion}; worker v${PROTOCOL_VERSION}). Redeploy the service before publishing.`;
        console.warn(`[worker] ${message}`);
        send(ws, { type: "error", message });
        ws.close(1002, "Protocol mismatch — reload or redeploy");
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      try {
        runtime = accountRuntime(platform, accountId, accountName);
      } catch (error) {
        send(ws, { type: "error", message: (error as Error).message || "Account runtime unavailable" });
        ws.close(1011, "Account runtime unavailable");
        return;
      }
      const { rig, engine } = runtime;
      const client = {
        __ws: ws,
        send: (m: ServerMsg) => send(ws, m),
      } as { __ws: WebSocket; send: (m: ServerMsg) => void };
      rig.clients.add(client);
      send(ws, {
        type: "ready",
        sessionId: `rig-${platform}-${accountId}`,
        url: START_URLS[platform],
        driver: driverInfo(),
        proto: PROTOCOL_VERSION,
      });
      send(ws, { type: "engine", state: engine.snapshot() });
      // The cookie panel must not lie after a reload: say what this profile holds.
      send(ws, { type: "cookie-state", ...rig.cookieState() });
      // Browser-start failures are logged to the console AND the client so the
      // reason is always visible in the deploy log and the deck.
      void rig.openControlSession().catch((e) => {
        console.error(`[${platform}] open control session failed: ${(e as Error).message}`);
        send(ws, { type: "error", message: `Browser start failed: ${(e as Error).message}` });
      });
      return;
    }

    if (!runtime || runtime.deleting) {
      ws.close(1011, "Account runtime unavailable");
      return;
    }
    const { rig, engine } = runtime;
    switch (msg.type) {
      case "cmd":
        rig.exec(msg.cmd).catch((e) =>
          send(ws, { type: "error", message: `Command failed: ${(e as Error).message}` })
        );
        return;
      case "engine":
        if (msg.action === "start") engine.start();
        else if (msg.action === "stop") engine.stop();
        else send(ws, { type: "error", message: "Invalid engine action" });
        return;
      case "engine-config":
        if (
          typeof msg.topic !== "string" ||
          msg.topic.length > 500 ||
          (msg.thresholdViews !== undefined && typeof msg.thresholdViews !== "number") ||
          (msg.likesFloor !== undefined && typeof msg.likesFloor !== "number")
        ) {
          send(ws, { type: "error", message: "Invalid engine configuration" });
          return;
        }
        engine.configure({ topic: msg.topic, thresholdViews: msg.thresholdViews, likesFloor: msg.likesFloor });
        return;
      case "post-status":
        engine.reportManualStatus(msg.requestId);
        return;
      case "discover-post": {
        const requestId =
          typeof msg.requestId === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(msg.requestId)
            ? msg.requestId
            : undefined;
        if (
          typeof msg.topic !== "string" ||
          msg.topic.length > 500 ||
          typeof msg.caption !== "string" ||
          msg.caption.length > 10_000 ||
          !requestId
        ) {
          send(ws, { type: "post-failed", message: "The topic discovery request was malformed; nothing was uploaded.", requestId });
          return;
        }
        void engine.manualDiscoverPost(msg.topic, msg.caption, requestId).catch((error) => {
          send(ws, {
            type: "post-failed",
            message: `The worker could not start this topic search: ${(error as Error).message}`,
            requestId,
          });
        });
        return;
      }
      case "post": {
        const requestId =
          typeof msg.requestId === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(msg.requestId)
            ? msg.requestId
            : undefined;
        if (
          typeof msg.url !== "string" ||
          msg.url.length > 8_192 ||
          typeof msg.caption !== "string" ||
          msg.caption.length > 10_000 ||
          !requestId
        ) {
          send(ws, { type: "post-failed", message: "The publish request was malformed; nothing was uploaded.", requestId });
          return;
        }
        void engine.manualPost(msg.url, msg.caption, requestId).catch((error) => {
          send(ws, {
            type: "post-failed",
            message: `The worker could not start this publish: ${(error as Error).message}`,
            requestId,
          });
        });
        return;
      }
      case "session":
        if (msg.action === "close") void rig.close();
        else if (msg.action !== "open") send(ws, { type: "error", message: "Invalid session action" });
        return;
      case "cookie": {
        const value = typeof msg.value === "string" ? msg.value : "";
        // Length only: a session secret must not end up in the deploy log, which
        // Railway shows to anyone with access to the service.
        const len = value.trim().length;
        console.log(`[${platform}] cookie ${msg.action} requested (${len} chars)`);
        if (msg.action === "clear") {
          void rig.clearSessionCookies();
        } else if (msg.action !== "apply") {
          send(ws, { type: "error", message: "Invalid cookie action" });
        } else if (!len || len > 64 * 1024) {
          send(ws, {
            type: "toast",
            text: len ? "That session cookie is unexpectedly large" : "Paste the session cookie value first",
            tone: "warn",
          });
        } else if (engine.snapshot().running || engine.isBusy()) {
          // Deliberate: swapping the session under a running/busy engine would
          // post on an account the deck never armed. Stop/wait, then change it.
          send(ws, { type: "toast", text: "Pause or finish the current publish before changing the session", tone: "warn" });
        } else {
          void rig.applySessionCookie(value);
        }
        return;
      }
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (!runtime) return;
    const { rig, engine } = runtime;
    rig.clients.forEach((c) => {
      if ((c as { __ws?: WebSocket }).__ws === ws) rig.clients.delete(c);
    });
    // A named account's cookie jar lives on disk, not in RAM. Hibernate an idle
    // browser after leaving its room so adding five accounts does not keep five
    // 700 MB Chromium trees alive. Armed/busy accounts stay up; reopening a tile
    // restores the same persistent profile and therefore the same login.
    const hibernate = setTimeout(() => {
      if (runtime?.deleting || runtimes.get(accountScopeKey(platform, accountId)) !== runtime) return;
      if (rig.clients.size || engine.snapshot().running || engine.isBusy()) return;
      void rig.close().then(() =>
        console.log(`[${platform}/${rig.accountName}] idle browser hibernated; persistent login kept`)
      );
    }, 30_000);
    hibernate.unref?.();
  });
  ws.on("error", () => {
    /* socket level noise — clients prune themselves on close */
  });
});

server.listen(env.port, "0.0.0.0", () => {
  console.log(`[viraldeck-worker] listening on 0.0.0.0:${env.port}`);
  console.log(`[viraldeck-worker] platforms: ${PLATFORMS.join(", ")}`);
  const pre = browserPreflight();
  (pre.ok ? console.log : console.error)(`[viraldeck-worker] browser: ${pre.detail}`);
  console.log(
    `[viraldeck-worker] mode: ${stealth.headless ? "headless" : `headed (DISPLAY=${process.env.DISPLAY || "unset!"})`}, profiles in ${env.dataDir}, frame every ${Math.max(400, env.frameIntervalMs)} ms`
  );
  console.log(
    env.tor.enabled
      ? `[viraldeck-worker] network: Tor required, per-account SOCKS-auth isolation, fail-closed egress checks (${env.tor.socksHost}:${env.tor.socksPort})`
      : "[viraldeck-worker] network: WARNING — Tor explicitly disabled; browser egress is direct"
  );
  // Printed from driverInfo() — the same object the deck badges — so the deploy
  // log and the UI can never disagree about which browser is actually in use.
  const d = driverInfo();
  console.log(
    `[viraldeck-worker] driver: ` +
      (d.engine === "playwright"
        ? `stock Chromium via Playwright (stealth-lite: automation flag hidden, nothing else faked; ${d.headless ? "headless" : "headed"})`
        : `Clearcote browser (${d.platform} persona, light stealth: ${d.lightStealth ? "on" : "off"}) driven nodriver-style`) +
      ` — raw CDP, trusted humanized input: ${d.humanize ? "on" : "off"}`
  );
  if (d.engine === "playwright") {
    console.log(
      `[viraldeck-worker] page load: ` +
        (resolverRules()
          ? `DNS-blocking ${BLOCKED_HOSTS.length} ad/analytics/crash-report hosts, service workers blocked, no background networking/extensions/sync`
          : `tracker blocklist OFF (BLOCK_TRACKERS) — every third-party request will be fetched`) +
        `, ${d.timezone} locale en-US`
    );
  }
  console.log(
    env.groqKey
      ? `[viraldeck-worker] Groq connected (${env.groqModel})`
      : "[viraldeck-worker] No GROQ_API_KEY — running with heuristic fallbacks (add the key for AI captions + reviews)."
  );
});
