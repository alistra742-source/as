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
  `${js}; return { torIsolationCredentials, parseProxyAuthority, openTorStream };`
);
const testEnv = {
  token: "worker-secret",
  tor: { enabled: false, socksHost: "127.0.0.1", socksPort: 9050, bootstrapTimeoutMs: 90_000 },
};
const { torIsolationCredentials, parseProxyAuthority, openTorStream } = load(
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

test("proxy authority parsing validates ports without resolving destination DNS", () => {
  assert.deepEqual(parseProxyAuthority("www.tiktok.com:443", 80), { host: "www.tiktok.com", port: 443 });
  assert.deepEqual(parseProxyAuthority("www.youtube.com", 443), { host: "www.youtube.com", port: 443 });
  assert.throws(() => parseProxyAuthority("user:pass@example.com:443", 443), /invalid proxy target/);
  assert.throws(() => parseProxyAuthority("example.com:99999", 443), /invalid proxy target/);
});

test("the bridge requires SOCKS auth, sends domain names to Tor, and verifies egress", () => {
  assert.match(source, /Buffer\.from\(\[0x05, 0x01, 0x02\]\)/, "only SOCKS username/password is offered");
  assert.match(source, /0x05, 0x01, 0x00, 0x03/, "ATYP=domain keeps DNS inside Tor");
  assert.match(source, /"IsTor"\\s\*:\\s\*true/, "browser launch requires Tor Project confirmation");
  assert.match(source, /Browser launch was blocked to prevent direct-IP fallback/);
});

test("both Chromium launch paths receive the account bridge and close UDP bypasses", () => {
  const browser = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
  const launch = fs.readFileSync(new URL("../worker/src/browserLaunch.ts", import.meta.url), "utf8");
  assert.match(browser, /accountTorProxy\(this\.platform, this\.accountId\)/);
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
});
