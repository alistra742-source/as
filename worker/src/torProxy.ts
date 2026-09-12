import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { accountScopeKey } from "./accountScope.js";
import { env, type PlatformKey } from "./config.js";

/**
 * Chromium cannot safely send authenticated SOCKS5 credentials. This module is
 * the deliberately small adapter between Chromium's HTTP CONNECT support and
 * Tor's SOCKS5 authentication isolation:
 *
 *   one account -> one loopback HTTP proxy -> one SOCKS username/password
 *
 * Tor is started with IsolateSOCKSAuth, so streams carrying two different
 * credential pairs cannot share a circuit. Destination names are sent to Tor as
 * SOCKS domain names (ATYP 3); Node never resolves the destination itself.
 */

export interface AccountTorProxy {
  server: string;
  egressIp: string;
  isolated: true;
}

export interface TorHealth {
  enabled: boolean;
  state: "disabled" | "checking" | "ready" | "failed";
  error: string | null;
}

interface IsolationCredentials {
  username: string;
  password: string;
}

interface BridgeEndpoint extends AccountTorProxy {
  scope: string;
  serverHandle: net.Server;
  sockets: Set<net.Socket>;
  /** Mutable only before browser launch, so a failed Tor circuit can be replaced. */
  credentials: IsolationCredentials;
  circuitGeneration: number;
  verifiedAt: number;
  lastError: string;
}

const endpoints = new Map<string, BridgeEndpoint>();
const starting = new Map<string, Promise<BridgeEndpoint>>();
let warmPromise: Promise<void> | null = null;
let health: TorHealth = env.tor.enabled
  ? { enabled: true, state: "checking", error: null }
  : { enabled: false, state: "disabled", error: null };

interface EgressCheck {
  host: string;
  path: string;
  kind: "tor-project" | "json-ip" | "cloudflare-trace";
}

const OFFICIAL_CHECK: EgressCheck = {
  host: "check.torproject.org",
  path: "/api/ip",
  kind: "tor-project",
};
// check.torproject.org is an attestation service, not part of Tor transport. It
// can be slow or rate-limit a busy exit while Tor itself is healthy. These are
// connectivity witnesses only: every byte still travels through this module's
// authenticated SOCKS stream to the locally started Tor daemon; there is no
// direct-network implementation to fall back to.
const CONNECTIVITY_CHECKS: EgressCheck[] = [
  { host: "api.ipify.org", path: "/?format=json", kind: "json-ip" },
  { host: "www.cloudflare.com", path: "/cdn-cgi/trace", kind: "cloudflare-trace" },
];
const VERIFY_MAX_AGE_MS = 5 * 60_000;
const SOCKET_TIMEOUT_MS = 30_000;
const EGRESS_PROBE_TIMEOUT_MS = 12_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stable and unlinkable between account scopes; never sent to Chromium. */
export function torIsolationCredentials(scope: string): IsolationCredentials {
  const secret = env.token || "public";
  const username = crypto.createHmac("sha256", secret).update(`viraldeck-tor-user\0${scope}`).digest("base64url").slice(0, 36);
  const password = crypto.createHmac("sha256", secret).update(`viraldeck-tor-pass\0${scope}`).digest("base64url").slice(0, 48);
  return { username: `vd-${username}`, password };
}

function connectSocket(socket: net.Socket, timeoutMs = SOCKET_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("connection timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** Read exactly N bytes while preserving anything that follows for the next step. */
function readExactly(socket: net.Socket, size: number, timeoutMs = SOCKET_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.pause();
    const timer = setTimeout(() => finish(new Error("proxy handshake timed out")), timeoutMs);
    const finish = (error?: Error, value?: Buffer) => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value as Buffer);
    };
    const onReadable = () => {
      const value = socket.read(size) as Buffer | null;
      if (value) finish(undefined, value);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("proxy closed during handshake"));
    socket.on("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
    onReadable();
  });
}

function readUntil(
  socket: net.Socket,
  marker: Buffer,
  maxBytes: number,
  timeoutMs = SOCKET_TIMEOUT_MS
): Promise<{ value: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let value = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("proxy request timed out")), timeoutMs);
    const finish = (error?: Error, result?: { value: Buffer; rest: Buffer }) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
      if (error) reject(error);
      else resolve(result as { value: Buffer; rest: Buffer });
    };
    const onData = (chunk: Buffer) => {
      value = Buffer.concat([value, chunk]);
      if (value.length > maxBytes) return finish(new Error("proxy header is too large"));
      const end = value.indexOf(marker);
      if (end >= 0) {
        const split = end + marker.length;
        finish(undefined, { value: value.subarray(0, split), rest: value.subarray(split) });
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("proxy connection closed"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function socksError(code: number): string {
  return (
    {
      1: "general failure",
      2: "connection not permitted",
      3: "network unreachable",
      4: "host unreachable",
      5: "connection refused",
      6: "TTL expired",
      7: "command not supported",
      8: "address type not supported",
    } as Record<number, string>
  )[code] || `error ${code}`;
}

function torStartupDetail(): string {
  const file = process.env.TOR_STARTUP_LOG || "";
  if (!file) return "";
  try {
    const lines = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
      .filter(Boolean)
      .slice(-4)
      .join(" | ")
      .slice(-700);
    return lines ? `; Tor startup log: ${lines}` : "";
  } catch {
    return "";
  }
}

/** Open one DNS-safe Tor stream. Only username/password auth is offered. */
export async function openTorStream(
  host: string,
  port: number,
  credentials: IsolationCredentials,
  signal?: AbortSignal
): Promise<net.Socket> {
  if (!host || Buffer.byteLength(host, "utf8") > 255 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid proxy destination");
  }
  if (signal?.aborted) throw new Error("Tor stream cancelled");
  const socket = net.createConnection({ host: env.tor.socksHost, port: env.tor.socksPort });
  const onAbort = () => socket.destroy(new Error("Tor stream cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.setNoDelay(true);
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Tor SOCKS connection timed out")));
  try {
    await connectSocket(socket);
    // RFC 1928: offer ONLY username/password. Tor accepts arbitrary credentials
    // and IsolateSOCKSAuth uses the pair as the circuit-isolation key.
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const method = await readExactly(socket, 2);
    if (method[0] !== 0x05 || method[1] !== 0x02) throw new Error("Tor did not accept isolated SOCKS authentication");

    const user = Buffer.from(credentials.username, "utf8");
    const pass = Buffer.from(credentials.password, "utf8");
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const authenticated = await readExactly(socket, 2);
    if (authenticated[0] !== 0x01 || authenticated[1] !== 0x00) throw new Error("Tor rejected the isolation credentials");

    // Always use ATYP=domain, even when Chromium supplied a hostname that could
    // be resolved locally. Tor (not Node/Chromium) owns destination DNS.
    const destination = Buffer.from(host, "utf8");
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, destination.length]),
        destination,
        Buffer.from([(port >>> 8) & 0xff, port & 0xff]),
      ])
    );
    const response = await readExactly(socket, 4);
    if (response[0] !== 0x05 || response[1] !== 0x00) throw new Error(`Tor destination failed: ${socksError(response[1])}`);
    if (response[3] === 0x01) await readExactly(socket, 4 + 2);
    else if (response[3] === 0x04) await readExactly(socket, 16 + 2);
    else if (response[3] === 0x03) {
      const length = (await readExactly(socket, 1))[0];
      await readExactly(socket, length + 2);
    } else {
      throw new Error("Tor returned an invalid address type");
    }
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    socket.destroy();
    const message = (error as Error).message || String(error);
    if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      throw new Error(`${message}${torStartupDetail()}`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Parse CONNECT authority without ever resolving it. Exported for boundary tests. */
export function parseProxyAuthority(authority: string, fallbackPort: number): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new Error("invalid proxy target");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port ? Number(parsed.port) : fallbackPort;
  if (!host || parsed.username || parsed.password || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid proxy target");
  }
  return { host, port };
}

function proxyFailure(client: net.Socket) {
  if (client.destroyed) return;
  const body = "Tor proxy unavailable; direct networking is disabled.\n";
  client.end(
    `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

async function handleProxyClient(
  client: net.Socket,
  credentials: IsolationCredentials,
  sockets: Set<net.Socket>,
  onError: (message: string) => void
) {
  client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy());
  sockets.add(client);
  const abort = new AbortController();
  let upstream: net.Socket | null = null;
  client.once("close", () => {
    sockets.delete(client);
    abort.abort();
    upstream?.destroy();
  });
  try {
    const incoming = await readUntil(client, Buffer.from("\r\n\r\n"), 64 * 1024);
    const headerText = incoming.value.toString("latin1");
    const lines = headerText.split("\r\n");
    const requestLine = lines.shift() || "";
    const [method, requestTarget, version, ...extra] = requestLine.split(" ");
    if (!method || !requestTarget || !/^HTTP\/1\.[01]$/.test(version || "") || extra.length) {
      throw new Error("invalid HTTP proxy request");
    }

    if (method.toUpperCase() === "CONNECT") {
      const target = parseProxyAuthority(requestTarget, 443);
      upstream = await openTorStream(target.host, target.port, credentials, abort.signal);
      if (client.destroyed) throw new Error("proxy client closed before Tor connected");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream as net.Socket));
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: ViralDeck-Tor\r\n\r\n");
      if (incoming.rest.length) upstream.write(incoming.rest);
    } else {
      // Chromium sends absolute-form requests for plain HTTP. Translate only the
      // request line, strip proxy-only headers, and tunnel the bytes over Tor.
      const target = new URL(requestTarget);
      if (target.protocol !== "http:" || target.username || target.password) throw new Error("unsupported proxy request");
      const port = target.port ? Number(target.port) : 80;
      upstream = await openTorStream(target.hostname, port, credentials, abort.signal);
      if (client.destroyed) throw new Error("proxy client closed before Tor connected");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream as net.Socket));
      const origin = `${target.pathname || "/"}${target.search}`;
      const forwarded = [
        `${method} ${origin} ${version}`,
        ...lines.filter((line) => !/^proxy-(?:authorization|connection)\s*:/i.test(line)),
      ].join("\r\n");
      upstream.write(Buffer.concat([Buffer.from(forwarded, "latin1"), incoming.rest]));
    }

    client.setTimeout(0);
    upstream.setTimeout(0);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  } catch (error) {
    onError((error as Error).message || "Tor bridge failed");
    upstream?.destroy();
    proxyFailure(client);
  }
}

async function createBridge(scope: string): Promise<BridgeEndpoint> {
  const initialCredentials = torIsolationCredentials(scope);
  const sockets = new Set<net.Socket>();
  let endpoint: BridgeEndpoint | null = null;
  const serverHandle = net.createServer((client) =>
    void handleProxyClient(client, endpoint?.credentials ?? initialCredentials, sockets, (message) => {
      if (endpoint) endpoint.lastError = message;
    })
  );
  serverHandle.on("error", (error) => console.error(`[tor] account bridge error: ${(error as Error).message}`));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    serverHandle.once("error", onError);
    serverHandle.listen(0, "127.0.0.1", () => {
      serverHandle.off("error", onError);
      resolve();
    });
  });
  const address = serverHandle.address();
  if (!address || typeof address === "string") {
    serverHandle.close();
    throw new Error("Could not allocate the account Tor bridge");
  }
  endpoint = {
    scope,
    server: `http://127.0.0.1:${address.port}`,
    egressIp: "",
    isolated: true,
    serverHandle,
    sockets,
    credentials: initialCredentials,
    circuitGeneration: 0,
    verifiedAt: 0,
    lastError: "",
  };
  return endpoint;
}

function closeEndpoint(endpoint: BridgeEndpoint) {
  endpoint.serverHandle.close();
  for (const socket of endpoint.sockets) socket.destroy();
  endpoint.sockets.clear();
}

/**
 * Same account boundary, fresh SOCKS authentication tuple. Tor's
 * IsolateSOCKSAuth treats it as a new circuit identity. This runs only after a
 * preflight failed and before Chromium receives the bridge, so an active account
 * can never jump exits mid-session.
 */
function rotateEndpointCircuit(endpoint: BridgeEndpoint): void {
  for (const socket of endpoint.sockets) socket.destroy();
  endpoint.sockets.clear();
  endpoint.circuitGeneration += 1;
  const nonce = crypto.randomBytes(12).toString("base64url");
  endpoint.credentials = torIsolationCredentials(
    `${endpoint.scope}\0retry-${endpoint.circuitGeneration}\0${nonce}`
  );
  endpoint.egressIp = "";
  endpoint.verifiedAt = 0;
  endpoint.lastError = "";
}

async function readTlsResponse(socket: tls.TLSSocket, timeoutMs = SOCKET_TIMEOUT_MS): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => finish(new Error("Tor egress check timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024) return finish(new Error("Tor egress response was too large"));
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

class NonTorEgressError extends Error {}

function safeProbeError(error: unknown): string {
  return ((error as Error)?.message || String(error) || "egress check failed")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Exported so response parsing and the explicit non-Tor fail-closed case are testable. */
export function parseEgressResponse(
  kind: EgressCheck["kind"],
  raw: string
): { ip: string; torConfirmed: boolean } {
  if (!/^HTTP\/1\.[01] 200\b/.test(raw)) throw new Error("egress witness returned a non-200 response");
  if (kind === "tor-project") {
    if (/"IsTor"\s*:\s*false/i.test(raw)) {
      // This is qualitatively different from an outage. A reachable official
      // checker explicitly saying “not Tor” may never be rescued by a fallback.
      throw new NonTorEgressError("Tor Project reported non-Tor egress; direct-IP fallback remains blocked");
    }
    if (!/"IsTor"\s*:\s*true/i.test(raw)) throw new Error("Tor Project response did not contain an egress verdict");
    const candidate = /"IP"\s*:\s*"([^"\\]{3,64})"/i.exec(raw)?.[1] || "";
    return { ip: net.isIP(candidate) ? candidate : "Tor-confirmed", torConfirmed: true };
  }

  const candidate =
    kind === "json-ip"
      ? /"ip"\s*:\s*"([^"\\]{3,64})"/i.exec(raw)?.[1] || ""
      : /^ip=([^\r\n]{3,64})$/im.exec(raw)?.[1]?.trim() || "";
  if (!net.isIP(candidate)) throw new Error("egress witness did not return a valid IP address");
  return { ip: candidate, torConfirmed: false };
}

/** One HTTPS GET through the exact local account bridge, with one total deadline. */
async function requestThroughEndpoint(
  endpoint: BridgeEndpoint,
  check: EgressCheck,
  timeoutMs: number
): Promise<string> {
  endpoint.lastError = "";
  const deadline = Date.now() + timeoutMs;
  const remaining = (label: string): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${label} timed out`);
    return left;
  };
  const proxy = new URL(endpoint.server);
  const socket = net.createConnection({ host: proxy.hostname, port: Number(proxy.port) });
  let secure: tls.TLSSocket | null = null;
  try {
    await connectSocket(socket, remaining("account bridge connection"));
    socket.write(
      `CONNECT ${check.host}:443 HTTP/1.1\r\n` +
        `Host: ${check.host}:443\r\n` +
        "Connection: keep-alive\r\n\r\n"
    );
    const response = await readUntil(
      socket,
      Buffer.from("\r\n\r\n"),
      32 * 1024,
      remaining("Tor CONNECT")
    );
    const firstLine = response.value.toString("latin1").split("\r\n", 1)[0];
    if (!/^HTTP\/1\.[01] 200\b/.test(firstLine)) {
      throw new Error(endpoint.lastError || "account bridge could not establish a Tor stream");
    }
    if (response.rest.length) socket.unshift(response.rest);
    secure = tls.connect({ socket, servername: check.host, ALPNProtocols: ["http/1.1"] });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        secure?.off("secureConnect", onConnect);
        secure?.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onConnect = () => finish();
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error("Tor TLS check timed out")), remaining("Tor TLS check"));
      secure?.once("secureConnect", onConnect);
      secure?.once("error", onError);
    });
    secure.write(
      `GET ${check.path} HTTP/1.1\r\n` +
        `Host: ${check.host}\r\n` +
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36\r\n" +
        "Accept: application/json,text/plain,*/*\r\n" +
        "Accept-Encoding: identity\r\n" +
        "Connection: close\r\n\r\n"
    );
    return await readTlsResponse(secure, remaining("Tor egress response"));
  } catch (error) {
    secure?.destroy();
    socket.destroy();
    throw error;
  }
}

/**
 * Prove the exact listener can carry authenticated Tor traffic before Chromium
 * receives it. Prefer Tor Project's explicit attestation. If that independent
 * website is unavailable, two alternate IP witnesses are tried concurrently;
 * they are reached only via `openTorStream`, whose sole upstream is the local
 * authenticated Tor SOCKS port. There is deliberately no direct request path.
 */
async function verifyEndpoint(endpoint: BridgeEndpoint, timeoutMs = EGRESS_PROBE_TIMEOUT_MS * 2): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let officialError = "official Tor check unavailable";
  try {
    const raw = await requestThroughEndpoint(
      endpoint,
      OFFICIAL_CHECK,
      Math.max(1_000, Math.min(EGRESS_PROBE_TIMEOUT_MS, deadline - Date.now()))
    );
    const verdict = parseEgressResponse(OFFICIAL_CHECK.kind, raw);
    endpoint.egressIp = verdict.ip;
    endpoint.verifiedAt = Date.now();
    return verdict.ip;
  } catch (error) {
    if (error instanceof NonTorEgressError) throw error;
    officialError = safeProbeError(error);
  }

  const left = deadline - Date.now();
  if (left < 1_000) throw new Error(`official Tor check failed: ${officialError}`);
  const fallbackBudget = Math.max(1_000, Math.min(EGRESS_PROBE_TIMEOUT_MS, left));
  const attempts = await Promise.allSettled(
    CONNECTIVITY_CHECKS.map(async (check) => {
      const raw = await requestThroughEndpoint(endpoint, check, fallbackBudget);
      return parseEgressResponse(check.kind, raw);
    })
  );
  const winner = attempts.find(
    (attempt): attempt is PromiseFulfilledResult<{ ip: string; torConfirmed: boolean }> => attempt.status === "fulfilled"
  );
  if (winner) {
    endpoint.egressIp = winner.value.ip;
    endpoint.verifiedAt = Date.now();
    return winner.value.ip;
  }
  const alternateErrors = attempts
    .map((attempt) => attempt.status === "rejected" ? safeProbeError(attempt.reason) : "")
    .filter(Boolean)
    .join("; ")
    .slice(0, 500);
  throw new Error(
    `official Tor check failed: ${officialError}; alternate Tor-stream checks failed: ${alternateErrors || "no response"}`
  );
}

async function verifyWithRetry(
  endpoint: BridgeEndpoint,
  timeoutMs: number,
  onAttemptError?: (message: string) => void
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "Tor is not ready";
  do {
    try {
      const left = Math.max(1_000, deadline - Date.now());
      await verifyEndpoint(endpoint, Math.min(EGRESS_PROBE_TIMEOUT_MS * 2, left));
      return;
    } catch (error) {
      last = safeProbeError(error) || last;
      if (error instanceof NonTorEgressError || Date.now() >= deadline) break;
      onAttemptError?.(last);
      // Reusing the same SOCKS auth tuple can keep Tor on the same failed exit.
      // Rotate only during preflight; once verified, the browser keeps one tuple.
      rotateEndpointCircuit(endpoint);
      await wait(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Tor egress could not be verified (${last}${torStartupDetail()}). ` +
      "Browser launch was blocked to prevent direct-IP fallback."
  );
}

/** Start deployment readiness. Health stays non-ready until Tor egress is proven. */
export function warmTor(): Promise<void> {
  if (!env.tor.enabled) return Promise.resolve();
  if (warmPromise) return warmPromise;
  health = { enabled: true, state: "checking", error: null };
  warmPromise = (async () => {
    const endpoint = await createBridge("worker-readiness");
    try {
      await verifyWithRetry(endpoint, env.tor.bootstrapTimeoutMs, (message) => {
        health = { enabled: true, state: "checking", error: message };
      });
      health = { enabled: true, state: "ready", error: null };
      console.log(`[tor] ready; verified Tor egress (${endpoint.egressIp})`);
    } finally {
      closeEndpoint(endpoint);
    }
  })().catch((error) => {
    const message = (error as Error).message || "Tor readiness failed";
    health = { enabled: true, state: "failed", error: message };
    console.error(`[tor] ${message}`);
    warmPromise = null;
    throw error;
  });
  return warmPromise;
}

export function torHealth(): TorHealth {
  return { ...health };
}

/** Account-specific loopback endpoint. Enabled mode never returns a direct path. */
export async function accountTorProxy(
  platform: PlatformKey,
  accountId: string,
  onRetry?: (safeReason: string) => void
): Promise<AccountTorProxy | null> {
  if (!env.tor.enabled) return null;
  await warmTor();
  const scope = accountScopeKey(platform, accountId);
  const existing = endpoints.get(scope);
  if (existing) {
    try {
      if (Date.now() - existing.verifiedAt > VERIFY_MAX_AGE_MS) {
        await verifyWithRetry(existing, Math.min(env.tor.bootstrapTimeoutMs, 45_000), onRetry);
      }
      return { server: existing.server, egressIp: existing.egressIp, isolated: true };
    } catch (error) {
      // Do not leave an unverified listener cached. Retry Browser start will build
      // a clean listener, while this attempt still fails closed.
      endpoints.delete(scope);
      closeEndpoint(existing);
      throw error;
    }
  }
  const pending = starting.get(scope);
  if (pending) {
    const endpoint = await pending;
    return { server: endpoint.server, egressIp: endpoint.egressIp, isolated: true };
  }
  const task = (async () => {
    const endpoint = await createBridge(scope);
    try {
      await verifyWithRetry(endpoint, Math.min(env.tor.bootstrapTimeoutMs, 45_000), onRetry);
      endpoints.set(scope, endpoint);
      return endpoint;
    } catch (error) {
      closeEndpoint(endpoint);
      throw error;
    }
  })();
  starting.set(scope, task);
  try {
    const endpoint = await task;
    return { server: endpoint.server, egressIp: endpoint.egressIp, isolated: true };
  } finally {
    starting.delete(scope);
  }
}

/** Called only after the account browser/runtime has closed. */
export function closeAccountTorProxy(platform: PlatformKey, accountId: string): void {
  const scope = accountScopeKey(platform, accountId);
  const endpoint = endpoints.get(scope);
  if (!endpoint) return;
  endpoints.delete(scope);
  closeEndpoint(endpoint);
}
