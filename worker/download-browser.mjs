/**
 * Build-time helper (Dockerfile): pre-download the SHA-256-verified Clearcote
 * browser into the image cache so deploys never touch GitHub at runtime.
 * Fails the build with the underlying error when the download can't complete.
 */
import { download } from "clearcote";

const cacheDir = process.env.CLEARCOTE_CACHE_DIR;

try {
  const binary = await download({ cacheDir, quiet: false });
  console.log(`[build] clearcote browser ready: ${binary}`);
} catch (err) {
  console.error("[build] clearcote browser download failed:", err);
  process.exit(1);
}
