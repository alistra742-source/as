import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const frontend = fs.readFileSync(new URL("../src/lib/protocol.ts", import.meta.url), "utf8");
const workerProtocol = fs.readFileSync(new URL("../worker/src/protocol.ts", import.meta.url), "utf8");
const workerIndex = fs.readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
const gateSource = fs.readFileSync(new URL("../worker/src/protocolGate.ts", import.meta.url), "utf8");
const gateJs = stripTypeScriptTypes(gateSource, { mode: "strip" }).replace(/export /g, "");
const protocolAccess = new Function(`${gateJs}; return protocolAccess;`)();

test("frontend and worker protocol contracts remain exact mirrors", () => {
  const withoutNow = workerProtocol.replace(/\nexport function now\(\): number \{[\s\S]*$/, "").trim();
  assert.equal(withoutNow, frontend.trim());
  assert.match(frontend, /PROTOCOL_VERSION = 13/);
});

test("only protocol v12 gets narrow growth-only compatibility with worker v13", () => {
  assert.equal(protocolAccess(13, 13), "current");
  assert.equal(protocolAccess(12, 13), "growth-only");
  assert.equal(protocolAccess(11, 13), "reject");
  assert.equal(protocolAccess(14, 13), "reject");
  assert.equal(protocolAccess(undefined, 13), "reject");
});

test("growth-only compatibility blocks both composer command types but permits Engine Start", () => {
  const auth = workerIndex.indexOf("protocolAccessMode = protocolAccess");
  const runtime = workerIndex.indexOf("runtime = accountRuntime(platform, accountId, accountName)", auth);
  assert.ok(auth >= 0 && runtime > auth);
  assert.match(workerIndex.slice(auth, runtime), /protocolAccessMode === "reject"/);
  assert.match(workerIndex, /protocolAccessMode === "growth-only"[\s\S]*rejectGrowthOnlyComposer\(requestId\)/);
  assert.equal(
    [...workerIndex.matchAll(/if \(protocolAccessMode === "growth-only"\) \{\s*rejectGrowthOnlyComposer\(requestId\)/g)].length,
    2,
    "both post and discover-post must be blocked for a v12 composer"
  );

  const engineCase = workerIndex.slice(workerIndex.indexOf('case "engine":'), workerIndex.indexOf('case "engine-config":'));
  assert.match(engineCase, /engine\.start\(\)/);
  assert.doesNotMatch(engineCase, /growth-only|rejectGrowthOnlyComposer/);
});
