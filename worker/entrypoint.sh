#!/bin/sh
# ViralDeck worker entrypoint.
#
# Headed-by-default: the Clearcote browser runs under Xvfb (a real X display),
# because headed Chrome avoids headless-mode tells. Set STEALTH_HEADLESS=true
# to run headless and skip Xvfb entirely. (The worker also starts Xvfb itself
# if it ever finds headed mode without a DISPLAY — this is the primary path.)
set -e
cd /app

if [ "${STEALTH_HEADLESS:-false}" = "true" ]; then
  echo "[viraldeck] stealth headless mode (no Xvfb)"
  exec node worker/dist/index.js
fi

DISPLAY_NUM="${XVFB_DISPLAY_NUM:-99}"
SCREEN="${XVFB_SCREEN:-1280x900x24}"

# Clean a stale lock so a restarted container can bring the display back up.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true

Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
trap 'kill "${XVFB_PID}" 2>/dev/null || true' EXIT

export DISPLAY=":${DISPLAY_NUM}"
echo "[viraldeck] headed Clearcote on Xvfb ${DISPLAY} (${SCREEN})"

exec node worker/dist/index.js
