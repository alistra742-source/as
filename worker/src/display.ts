/**
 * Headed-mode display bootstrap.
 *
 * The Docker entrypoint starts Xvfb before the worker. This is the belt-and-
 * braces fallback: if the worker is started some other way (e.g. a start
 * command that bypasses the entrypoint) and finds itself in headed mode with
 * no DISPLAY, it brings up Xvfb itself. If Xvfb is missing, it warns loudly
 * and leaves DISPLAY unset so the browser error is honest ("no display")
 * rather than silently launching into the void.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

export function ensureDisplay(): void {
  if (process.env.STEALTH_HEADLESS === "true") return;
  if (process.env.DISPLAY) return;

  const num = process.env.XVFB_DISPLAY_NUM || "99";
  const screen = process.env.XVFB_SCREEN || "1280x900x24";
  const lock = `/tmp/.X${num}-lock`;

  try {
    fs.rmSync(lock, { force: true }); // a stale lock blocks Xvfb from rebinding
  } catch {
    /* best-effort */
  }

  const xvfb = spawn("Xvfb", [`:${num}`, "-screen", "0", screen, "-nolisten", "tcp"], {
    stdio: "ignore",
    detached: true,
  });
  xvfb.unref();

  xvfb.on("error", (err) => {
    console.error(
      `[viraldeck-worker] headed mode but could not start Xvfb (${(err as Error).message}) — ` +
        `set STEALTH_HEADLESS=true or install xvfb.`
    );
  });
  xvfb.on("spawn", () => {
    process.env.DISPLAY = `:${num}`;
    console.log(`[viraldeck-worker] headed mode: Xvfb started on :${num} (${screen})`);
  });
}
