import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { recoverInterruptedManualResult } from "../worker/src/manualResult.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "viraldeck-topic-store-"));
const source = fs.readFileSync(new URL("../worker/src/store.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const accountDataDir = (dataRoot, platform, accountId) => path.join(dataRoot, "accounts", platform, accountId);
const load = new Function(
  "fs",
  "path",
  "accountDataDir",
  "LEGACY_ACCOUNT_ID",
  "env",
  `${js}; return { Store };`
);
const { Store } = load(fs, path, accountDataDir, "default", { dataDir: root });

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("custom discovery topic and correlated receipt persist per named account", () => {
  const personal = new Store("tiktok", "personal");
  personal.engine("tiktok").topic = "donut smp";
  personal.engine("tiktok").manualResult = {
    requestId: "post-one",
    status: "failed",
    message: "upload blocked",
    at: 123,
  };
  personal.saveImmediate();

  const brand = new Store("tiktok", "brand");
  brand.engine("tiktok").topic = "drdonutt";
  brand.saveImmediate();

  assert.equal(new Store("tiktok", "personal").engine("tiktok").topic, "donut smp");
  assert.equal(new Store("tiktok", "brand").engine("tiktok").topic, "drdonutt");
  assert.equal(new Store("tiktok", "personal").engine("tiktok").manualResult?.requestId, "post-one");
});

test("a restart turns a durable accepted request into a correlated failure", () => {
  const result = recoverInterruptedManualResult(
    { requestId: "post-interrupted", status: "accepted", message: "publishing", at: 100 },
    200
  );
  assert.equal(result?.requestId, "post-interrupted");
  assert.equal(result?.status, "failed");
  assert.match(result?.message || "", /worker restarted/i);
});
