import crypto from "node:crypto";
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
  verifiedAt: number;
}

const endpoints = new Map<string, BridgeEndpoint>();
const starting = new Map<string, Promise<BridgeEndpoint>>();
let warmPromise: Promise<void> | null = null;
let health: TorHealth = env.tor.enabled
  ? { enabled: true, state: "checking", error: null }
  : { enabled: false, state: "disabled", error: null };

const CHECK_HOST = "check.torproject.org";
const CHECK_PATH = "/api/ip";
const VERIFY_MAX_AGE_MS = 5 * 60_000;
const SOCKET_TIMEOUT_MS = 30_000;

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

/** Open one DNS-safe Tor stream. Only username/password auth is offered. */
export async function openTorStream(host: string, port: number, credentials: IsolationCredentials): Promise<net.Socket> {
  if (!host || Buffer.byteLength(host, "utf8") > 255 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid proxy destination");
  }
  const socket = net.createConnection({ host: env.tor.socksHost, port: env.tor.socksPort });
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
    throw error;
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

async function handleProxyClient(client: net.Socket, credentials: IsolationCredentials, sockets: Set<net.Socket>) {
  client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy());
  sockets.add(client);
  client.once("close", () => sockets.delete(client));
  let upstream: net.Socket | null = null;
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
      upstream = await openTorStream(target.host, target.port, credentials);
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
      upstream = await openTorStream(target.hostname, port, credentials);
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
  } catch {
    upstream?.destroy();
    proxyFailure(client);
  }
}

async function createBridge(scope: string): Promise<BridgeEndpoint> {
  const credentials = torIsolationCredentials(scope);
  const sockets = new Set<net.Socket>();
  const serverHandle = net.createServer((client) => void handleProxyClient(client, credentials, sockets));
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
  return {
    scope,
    server: `http://127.0.0.1:${address.port}`,
    egressIp: "",
    isolated: true,
    serverHandle,
    sockets,
    verifiedAt: 0,
  };
}

function closeEndpoint(endpoint: BridgeEndpoint) {
  endpoint.serverHandle.close();
  for (const socket of endpoint.sockets) socket.destroy();
  endpoint.sockets.clear();
}

async function readTlsResponse(socket: tls.TLSSocket): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => finish(new Error("Tor egress check timed out")), SOCKET_TIMEOUT_MS);
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

/** Prove this exact account listener exits through Tor before launching Chrome. */
async function verifyEndpoint(endpoint: BridgeEndpoint): Promise<string> {
  const proxy = new URL(endpoint.server);
  const socket = net.createConnection({ host: proxy.hostname, port: Number(proxy.port) });
  try {
    await connectSocket(socket);
    socket.write(`CONNECT ${CHECK_HOST}:443 HTTP/1.1\r\nHost: ${CHECK_HOST}:443\r\nConnection: keep-alive\r\n\r\n`);
    const response = await readUntil(socket, Buffer.from("\r\n\r\n"), 32 * 1024);
    const firstLine = response.value.toString("latin1").split("\r\n", 1)[0];
    if (!/^HTTP\/1\.[01] 200\b/.test(firstLine)) throw new Error("account bridge could not reach Tor");
    if (response.rest.length) socket.unshift(response.rest);
    const secure = tls.connect({ socket, servername: CHECK_HOST, ALPNProtocols: ["http/1.1"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Tor TLS check timed out")), SOCKET_TIMEOUT_MS);
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    secure.write(`GET ${CHECK_PATH} HTTP/1.1\r\nHost: ${CHECK_HOST}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    const raw = await readTlsResponse(secure);
    if (!/^HTTP\/1\.[01] 200\b/.test(raw) || !/"IsTor"\s*:\s*true/i.test(raw)) {
      throw new Error("Tor Project did not confirm this account's egress");
    }
    const ip = /"IP"\s*:\s*"([^"\\]{3,64})"/i.exec(raw)?.[1] || "Tor-confirmed";
    endpoint.egressIp = ip;
    endpoint.verifiedAt = Date.now();
    return ip;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function verifyWithRetry(endpoint: BridgeEndpoint, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "Tor is not ready";
  do {
    try {
      await verifyEndpoint(endpoint);
      return;
    } catch (error) {
      last = (error as Error).message || last;
      if (Date.now() >= deadline) break;
      await wait(1_000);
    }
  } while (Date.now() < deadline);
  throw new Error(`Tor egress could not be verified (${last}). Browser launch was blocked to prevent direct-IP fallback.`);
}

/** Start deployment readiness. Health stays non-ready until Tor egress is proven. */
export function warmTor(): Promise<void> {
  if (!env.tor.enabled) return Promise.resolve();
  if (warmPromise) return warmPromise;
  health = { enabled: true, state: "checking", error: null };
  warmPromise = (async () => {
    const endpoint = await createBridge("worker-readiness");
    try {
      await verifyWithRetry(endpoint, env.tor.bootstrapTimeoutMs);
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
export async function accountTorProxy(platform: PlatformKey, accountId: string): Promise<AccountTorProxy | null> {
  if (!env.tor.enabled) return null;
  await warmTor();
  const scope = accountScopeKey(platform, accountId);
  const existing = endpoints.get(scope);
  if (existing) {
    if (Date.now() - existing.verifiedAt > VERIFY_MAX_AGE_MS) await verifyEndpoint(existing);
    return { server: existing.server, egressIp: existing.egressIp, isolated: true };
  }
  const pending = starting.get(scope);
  if (pending) {
    const endpoint = await pending;
    return { server: endpoint.server, egressIp: endpoint.egressIp, isolated: true };
  }
  const task = (async () => {
    const endpoint = await createBridge(scope);
    try {
      await verifyWithRetry(endpoint, Math.min(env.tor.bootstrapTimeoutMs, 45_000));
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
