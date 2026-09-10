import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const frontend = fs.readFileSync(new URL("../src/lib/protocol.ts", import.meta.url), "utf8");
const workerProtocol = fs.readFileSync(new URL("../worker/src/protocol.ts", import.meta.url), "utf8");
const workerIndex = fs.readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");

test("frontend and worker protocol contracts remain exact mirrors", () => {
  const withoutNow = workerProtocol.replace(/\nexport function now\(\): number \{[\s\S]*$/, "").trim();
  assert.equal(withoutNow, frontend.trim());
  assert.match(frontend, /PROTOCOL_VERSION = 11/);
});

test("an outdated open deck is rejected with a refresh instruction before runtime work", () => {
  const mismatch = workerIndex.indexOf("if (msg.proto !== PROTOCOL_VERSION)");
  const runtime = workerIndex.indexOf("runtime = accountRuntime(platform, accountId, accountName)", mismatch);
  assert.ok(mismatch >= 0 && runtime > mismatch);
  assert.match(workerIndex.slice(mismatch, runtime), /Hard-refresh the page before publishing/);
  assert.match(workerIndex.slice(mismatch, runtime), /ws\.close\(1002/);
});
