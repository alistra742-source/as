import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/torProxy.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function(
  "crypto",
  "net",
  "tls",
  "env",
  "accountScopeKey",
  `${js}; return { torIsolationCredentials, parseProxyAuthority, openTorStream, parseEgressResponse, rotateEndpointCircuit };`
);
const testEnv = {
  token: "worker-secret",
  tor: { enabled: false, socksHost: "127.0.0.1", socksPort: 9050, bootstrapTimeoutMs: 90_000 },
};
const { torIsolationCredentials, parseProxyAuthority, openTorStream, parseEgressResponse, rotateEndpointCircuit } = load(
  crypto,
  net,
  tls,
  testEnv,
  (platform, accountId) => `${platform}:${accountId}`
);

test("Tor isolation credentials are stable and unique per platform account", () => {
  const personal = torIsolationCredentials("tiktok:acct-personal");
  const repeat = torIsolationCredentials("tiktok:acct-personal");
  const brand = torIsolationCredentials("tiktok:acct-brand");
  const youtube = torIsolationCredentials("youtube:acct-personal");
  assert.deepEqual(personal, repeat);
  assert.notDeepEqual(personal, brand);
  assert.notDeepEqual(personal, youtube);
  assert.ok(Buffer.byteLength(personal.username) <= 255);
  assert.ok(Buffer.byteLength(personal.password) <= 255);
});

function readExactly(socket, size) {
  return new Promise((resolve, reject) => {
    socket.pause();
    const read = () => {
      const value = socket.read(size);
      if (value) {
        socket.off("readable", read);
        resolve(value);
      }
    };
    socket.on("readable", read);
    socket.once("error", reject);
    read();
  });
}

test("a failed preflight gets fresh isolation credentials before retry", () => {
  let destroyed = false;
  const endpoint = {
    scope: "tiktok:acct-personal",
    credentials: torIsolationCredentials("tiktok:acct-personal"),
    circuitGeneration: 0,
    sockets: new Set([{ destroy() { destroyed = true; } }]),
    egressIp: "185.1.1.1",
    verifiedAt: Date.now(),
    lastError: "old failure",
  };
  const before = endpoint.credentials;
  rotateEndpointCircuit(endpoint);
  assert.notDeepEqual(endpoint.credentials, before);
  assert.equal(endpoint.circuitGeneration, 1);
  assert.equal(endpoint.sockets.size, 0);
  assert.equal(endpoint.egressIp, "");
  assert.equal(endpoint.verifiedAt, 0);
  assert.equal(destroyed, true);
});

test("the bridge performs authenticated SOCKS5 and sends the destination as a domain", async () => {
  let observed;
  let resolveProtocol;
  let rejectProtocol;
  const protocol = new Promise((resolve, reject) => {
    resolveProtocol = resolve;
    rejectProtocol = reject;
  });
  const fakeTor = net.createServer((socket) => {
    void (async () => {
      assert.deepEqual([...await readExactly(socket, 3)], [0x05, 0x01, 0x02]);
      socket.write(Buffer.from([0x05, 0x02]));
      const auth = await readExactly(socket, 2);
      assert.equal(auth[0], 0x01);
      const username = (await readExactly(socket, auth[1])).toString();
      const passLength = (await readExactly(socket, 1))[0];
      const password = (await readExactly(socket, passLength)).toString();
      socket.write(Buffer.from([0x01, 0x00]));
      const request = await readExactly(socket, 5);
      assert.deepEqual([...request.subarray(0, 4)], [0x05, 0x01, 0x00, 0x03]);
      const host = (await readExactly(socket, request[4])).toString();
      const portBytes = await readExactly(socket, 2);
      observed = { username, password, host, port: portBytes.readUInt16BE(0) };
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1]));
      resolveProtocol();
    })().catch(rejectProtocol);
  });
  await new Promise((resolve) => fakeTor.listen(0, "127.0.0.1", resolve));
  testEnv.tor.socksPort = fakeTor.address().port;
  const credentials = torIsolationCredentials("instagram:acct-one");
  const stream = await openTorStream("www.instagram.com", 443, credentials);
  await protocol;
  assert.deepEqual(observed, { ...credentials, host: "www.instagram.com", port: 443 });
  stream.destroy();
  await new Promise((resolve) => fakeTor.close(resolve));
});

test("aborting a bridge client cancels an in-flight Tor SOCKS handshake", async () => {
  const peers = new Set();
  const fakeTor = net.createServer((socket) => {
    // Deliberately never answer the SOCKS method negotiation.
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise((resolve) => fakeTor.listen(0, "127.0.0.1", resolve));
  testEnv.tor.socksPort = fakeTor.address().port;
  const controller = new AbortController();
  const opening = openTorStream("check.torproject.org", 443, torIsolationCredentials("tiktok:abort"), controller.signal);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(opening, /Tor stream cancelled/);
  for (const socket of peers) socket.destroy();
  await new Promise((resolve) => fakeTor.close(resolve));
});

test("proxy authority parsing validates ports without resolving destination DNS", () => {
  assert.deepEqual(parseProxyAuthority("www.tiktok.com:443", 80), { host: "www.tiktok.com", port: 443 });
  assert.deepEqual(parseProxyAuthority("www.youtube.com", 443), { host: "www.youtube.com", port: 443 });
  assert.throws(() => parseProxyAuthority("user:pass@example.com:443", 443), /invalid proxy target/);
  assert.throws(() => parseProxyAuthority("example.com:99999", 443), /invalid proxy target/);
});

test("egress witnesses return only validated IPs and an explicit non-Tor verdict fails closed", () => {
  const official = parseEgressResponse(
    "tor-project",
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"IsTor":true,"IP":"185.220.101.1"}'
  );
  assert.deepEqual(official, { ip: "185.220.101.1", torConfirmed: true });
  assert.deepEqual(
    parseEgressResponse("json-ip", 'HTTP/1.1 200 OK\r\n\r\n{"ip":"23.129.64.9"}'),
    { ip: "23.129.64.9", torConfirmed: false }
  );
  assert.deepEqual(
    parseEgressResponse("cloudflare-trace", "HTTP/1.1 200 OK\r\n\r\nfl=1\nip=2001:db8::9\nloc=US\n"),
    { ip: "2001:db8::9", torConfirmed: false }
  );
  assert.throws(
    () => parseEgressResponse("tor-project", 'HTTP/1.1 200 OK\r\n\r\n{"IsTor":false,"IP":"198.51.100.8"}'),
    /non-Tor egress.*fallback remains blocked/
  );
  assert.throws(
    () => parseEgressResponse("json-ip", "HTTP/1.1 200 OK\r\n\r\nnot-an-ip"),
    /valid IP/
  );
});

test("the bridge requires SOCKS auth, rotates failed circuits, and has no direct verification path", () => {
  assert.match(source, /Buffer\.from\(\[0x05, 0x01, 0x02\]\)/, "only SOCKS username/password is offered");
  assert.match(source, /0x05, 0x01, 0x00, 0x03/, "ATYP=domain keeps DNS inside Tor");
  assert.match(source, /"IsTor"\\s\*:\\s\*true/, "Tor Project confirmation remains the preferred witness");
  assert.match(source, /api\.ipify\.org/);
  assert.match(source, /cdn-cgi\/trace/);
  assert.match(source, /rotateEndpointCircuit\(endpoint\)/, "a failed auth tuple must not pin retries to one bad exit");
  assert.match(source, /requestThroughEndpoint\(endpoint, check/);
  assert.doesNotMatch(source, /https\.(?:get|request)|fetch\(/, "verification must never bypass the account bridge");
  assert.match(source, /Browser launch was blocked to prevent direct-IP fallback/);
});

test("both Chromium launch paths receive the account bridge and close UDP bypasses", () => {
  const browser = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
  const launch = fs.readFileSync(new URL("../worker/src/browserLaunch.ts", import.meta.url), "utf8");
  assert.match(browser, /accountTorProxy\(this\.platform, this\.accountId,/);
  assert.match(browser, /--proxy-server=\$\{tor\.server\}/, "Clearcote Chromium gets a fixed account proxy");
  assert.match(browser, /proxy: \{ server: tor\.server, bypass: "" \}/, "Clearcote context requests get the same proxy");
  assert.match(launch, /proxy: \{ server: o\.proxyServer, bypass: "" \}/, "Playwright gets a fixed account proxy");
  assert.match(browser, /disable_non_proxied_udp/);
  assert.match(launch, /disable_non_proxied_udp/);
  assert.match(browser, /--disable-quic/);
  assert.match(launch, /--disable-quic/);
  const launchContext = browser.slice(browser.indexOf("private async launchContext"));
  assert.ok(launchContext.indexOf("await accountTorProxy") < launchContext.indexOf("launchStockChromium(profile"));
});

test("the deployment starts Tor with SOCKS-auth circuit isolation", () => {
  const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const entrypoint = fs.readFileSync(new URL("../worker/entrypoint.sh", import.meta.url), "utf8");
  assert.match(docker, /\n\s*tor \\/);
  assert.match(docker, /TOR_PROXY_ENABLED=true/);
  assert.match(entrypoint, /SocksPort[^\n]+IsolateSOCKSAuth/);
  assert.match(entrypoint, /SafeSocks 1/);
  assert.match(entrypoint, /STORAGE_DIR:-\/app\/data.*tor-client/s, "Tor consensus cache should survive a deploy");
  assert.doesNotMatch(entrypoint, /rm -rf "\$\{TOR_DATA_DIR\}"/, "cold-starting Tor on every deploy caused this outage");
});
