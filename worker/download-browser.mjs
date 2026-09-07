/**
 * Build-time helper (Dockerfile): pre-download the SHA-256-verified Clearcote
 * browser into the image cache so deploys never touch GitHub at runtime, then
 * PROVE the cache is what the runtime will resolve (same cacheDir, same pinned
 * release) — an image that passes this step cannot boot into "fetch failed".
 * Fails the build with the underlying error when anything is off.
 */
import fs from "node:fs";
import path from "node:path";
import { download, RELEASE } from "clearcote";

const cacheDir = process.env.CLEARCOTE_CACHE_DIR;
if (!cacheDir) {
  console.error("[build] CLEARCOTE_CACHE_DIR is not set — the runtime would look in a different cache than the one we fill here.");
  process.exit(1);
}

try {
  const binary = await download({ cacheDir, quiet: false });
  console.log(`[build] clearcote browser ready: ${binary}`);

  // Self-check: the runtime resolver reads <cacheDir>/<tag>/.verified + browser/.
  const base = path.join(cacheDir, RELEASE.tag);
  const verified = path.join(base, ".verified");
  if (!fs.existsSync(verified)) throw new Error(`missing ${verified} — the cache layout does not match the SDK's resolver`);
  if (!fs.existsSync(binary)) throw new Error(`binary path does not exist: ${binary}`);
  if (!binary.startsWith(path.resolve(cacheDir))) throw new Error(`binary resolved OUTSIDE the cache dir (${binary}) — runtime would re-download`);
  fs.accessSync(binary, fs.constants.X_OK);
  const mb = Math.round(fs.statSync(binary).size / 1e6);
  console.log(`[build] cache self-check OK: ${RELEASE.tag} (Chromium ${RELEASE.version}) in ${base} — chrome binary ${mb} MB, executable`);
} catch (err) {
  console.error("[build] clearcote browser download / self-check failed:", err);
  process.exit(1);
}
