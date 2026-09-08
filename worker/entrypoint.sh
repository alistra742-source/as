#!/bin/sh
# ViralDeck worker entrypoint.
#
# Headed-by-default: the browser (stock Chromium via Playwright, or the
# Clearcote build when BROWSER_ENGINE=clearcote) runs under Xvfb (a real X display),
# because headed Chrome avoids headless-mode tells. Set STEALTH_HEADLESS=true
# to run headless and skip Xvfb entirely. (The worker also starts Xvfb itself
# if it ever finds headed mode without a DISPLAY — this is the primary path.)
set -e
cd /app

if [ "${STEALTH_HEADLESS:-false}" = "true" ]; then
  echo "[viraldeck] stealth headless mode (no Xvfb)"
else
  DISPLAY_NUM="${XVFB_DISPLAY_NUM:-99}"
  SCREEN="${XVFB_SCREEN:-1280x900x24}"

  # Clean a stale lock so a restarted container can bring the display back up.
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true

  Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  trap 'kill "${XVFB_PID}" 2>/dev/null || true' EXIT

  export DISPLAY=":${DISPLAY_NUM}"
  echo "[viraldeck] headed Chromium (${BROWSER_ENGINE:-playwright}) on Xvfb ${DISPLAY} (${SCREEN})"
fi

# setpriority shim: containers lack CAP_SYS_NICE and the Clearcote DCHECK build
# fatals on the resulting EPERM. Preloading the shim makes it a no-op (release
# Chromium behaves the same way). Export it here so it reaches the browser
# through every launch path; the worker also passes it explicitly.
if [ -n "${STEALTH_NICE_SHIM}" ] && [ -f "${STEALTH_NICE_SHIM}" ]; then
  export LD_PRELOAD="${STEALTH_NICE_SHIM}${LD_PRELOAD:+:${LD_PRELOAD}}"
  echo "[viraldeck] setpriority shim active: ${STEALTH_NICE_SHIM}"
fi

# A redeploy leaves Chromium's Singleton{Lock,Socket,Cookie} symlinks behind
# on the persistent volume. They name the OLD container's hostname, so the new
# browser refuses the profile ("in use on another computer") and never starts.
# Nothing else uses these profiles: always clear them before boot.
DATA_DIR="${STORAGE_DIR:-/app/data}"
for lock in "${DATA_DIR}"/profile-*/Singleton*; do
  [ -e "$lock" ] || [ -L "$lock" ] || continue
  rm -f "$lock" && echo "[viraldeck] cleared stale profile lock: ${lock}"
done

exec node worker/dist/index.js
