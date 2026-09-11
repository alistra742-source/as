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

TOR_PID=""
XVFB_PID=""
cleanup() {
  [ -z "${TOR_PID}" ] || kill "${TOR_PID}" 2>/dev/null || true
  [ -z "${XVFB_PID}" ] || kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# One Tor daemon serves SOCKS5 on loopback. Chromium never talks to that port
# directly: the worker gives every platform/account its own local HTTP CONNECT
# bridge and supplies a different SOCKS credential pair. IsolateSOCKSAuth makes
# those pairs hard circuit boundaries. If Tor is unavailable, the worker's
# egress preflight and every browser launch fail closed.
case "${TOR_PROXY_ENABLED:-true}" in
  0|false|FALSE|off|OFF)
    echo "[viraldeck] WARNING: Tor disabled explicitly; browser traffic will be direct"
    ;;
  *)
    TOR_PORT="${TOR_SOCKS_PORT:-9050}"
    # Keep Tor's cached consensus/state on the service volume. Wiping a fresh
    # /tmp DataDirectory on every deploy made cold bootstrap depend on every
    # directory authority being responsive at that instant. This directory is
    # shared by the one Tor daemon only; account circuits remain separated by
    # IsolateSOCKSAuth below.
    DATA_ROOT="${STORAGE_DIR:-/app/data}"
    TOR_DATA_DIR="${TOR_DATA_DIR:-${DATA_ROOT}/tor-client}"
    install -d -m 0700 -o debian-tor -g debian-tor "${TOR_DATA_DIR}"
    chown debian-tor:debian-tor "${TOR_DATA_DIR}"
    TOR_STARTUP_LOG="${TOR_DATA_DIR}/startup.log"
    TOR_EMPTY_CONFIG="${TOR_DATA_DIR}/empty-torrc"
    : > "${TOR_STARTUP_LOG}"
    : > "${TOR_EMPTY_CONFIG}"
    chown debian-tor:debian-tor "${TOR_STARTUP_LOG}" "${TOR_EMPTY_CONFIG}"
    chmod 0600 "${TOR_EMPTY_CONFIG}"
    export TOR_STARTUP_LOG
    # Tor 0.4.9 requires a regular config file and rejects /dev/null. Use an
    # owned empty file so Debian's service defaults cannot add sockets/daemonize.
    tor --defaults-torrc "${TOR_EMPTY_CONFIG}" -f "${TOR_EMPTY_CONFIG}" \
      --RunAsDaemon 0 \
      --User debian-tor \
      --ClientOnly 1 \
      --AvoidDiskWrites 0 \
      --SafeSocks 1 \
      --DataDirectory "${TOR_DATA_DIR}" \
      --SocksPort "127.0.0.1:${TOR_PORT} IsolateSOCKSAuth" \
      --Log "notice stdout" >"${TOR_STARTUP_LOG}" 2>&1 &
    TOR_PID=$!
    echo "[viraldeck] Tor starting on 127.0.0.1:${TOR_PORT} (per-account IsolateSOCKSAuth; PID ${TOR_PID})"
    ;;
esac

if [ "${STEALTH_HEADLESS:-false}" = "true" ]; then
  echo "[viraldeck] stealth headless mode (no Xvfb)"
else
  DISPLAY_NUM="${XVFB_DISPLAY_NUM:-99}"
  SCREEN="${XVFB_SCREEN:-1280x900x24}"

  # Clean a stale lock so a restarted container can bring the display back up.
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true

  Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!

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
