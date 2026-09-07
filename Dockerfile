# Single deploy for everything: this image builds the Vite frontend + the Node
# backend, then one process serves the app AND the /ws browser socket on the
# same domain (auto-connect, no config needed).
#
# The browser driver is **Clearcote** (open-source anti-fingerprint Chromium,
# engine-level persona compiled into the browser itself), driven nodriver-style
# over raw CDP with humanized trusted input. No vanilla Chromium ships in this
# image and none is ever downloaded at runtime — the verified Clearcote binary
# is fetched once during the build.
#
# Base + runtime deps mirror Clearcote's own official container
# (github.com/clearcotelabs/clearcote-browser, docker/Dockerfile): Debian
# bookworm, the full Chromium library set, and a complete font base (fontconfig
# + Liberation + Noto emoji/CJK + unifont) so canvas/text hashes stay coherent
# on a bare container — the #1 Linux fingerprint tell. The browser runs HEADED
# under Xvfb by default (headed Chrome avoids headless-mode tells); set
# STEALTH_HEADLESS=true to opt out.
#
# Stage 0 — build the setpriority shim. Containers don't get CAP_SYS_NICE, so
# setpriority() returns EPERM; the Clearcote pre-release binary is a
# DCHECK-enabled build and fatals on that (base/process/process_linux.cc:201
# DPCHECK "result == 0"). The shim makes it a harmless no-op, exactly like a
# release Chromium behaves.
FROM node:22-bookworm-slim AS shim-builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY worker/nice-shim.c /src/nice-shim.c
RUN gcc -shared -fPIC -O2 -o /nice-shim.so /src/nice-shim.c

FROM node:22-bookworm-slim

# Clearcote ships x64 binaries only — fail fast (with a clear message) if this
# ever builds on another architecture instead of crashing at runtime.
RUN [ "$(uname -m)" = "x86_64" ] || { echo "[build] Clearcote ships x64 binaries only — build this image for linux/amd64"; exit 1; }

# Union of Clearcote's own container deps + the classic Chromium runtime set:
# any missing lib here shows up as a silent browser hang at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xz-utils \
    ca-certificates \
    xvfb \
    libnss3 \
    libnspr4 \
    libgbm1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libxext6 \
    libxrender1 \
    libxcb1 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-6 \
    libx11-xcb1 \
    libexpat1 \
    libdbus-1-3 \
    libxi6 \
    libxtst6 \
    libxcursor1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libegl1 \
    libgl1 \
    libwayland-client0 \
    libxshmfence1 \
    fontconfig \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-unifont \
    fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# DevDependencies (typescript, vite, etc.) are needed for the build step, so
# do NOT set NODE_ENV=production before this point. npm ci + the committed
# package-lock.json = byte-for-byte the same dependency tree we build locally.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Pre-download + SHA-256-verify the Clearcote browser so deploys never touch
# GitHub at runtime. Runtime reads it from the same cache dir
# (CLEARCOTE_CACHE_DIR). Progress is logged so this step is visible in the
# build output; any failure fails the build with the underlying error.
ENV CLEARCOTE_CACHE_DIR=/app/.clearcote-browser
RUN node worker/download-browser.mjs

# Drop build-only tooling from the final image.
RUN npm prune --omit=dev

# The setpriority shim (built in stage 0) — injected into the browser via
# LD_PRELOAD (see worker/nice-shim.c for the why).
COPY --from=shim-builder /nice-shim.so /app/nice-shim.so

# Headed under Xvfb by default (the official Clearcote container does the
# same: headed Chrome avoids headless-mode tells). Set STEALTH_HEADLESS=true
# to run headless and skip Xvfb. The entrypoint starts Xvfb; as a belt-and-
# braces fallback the worker also boots Xvfb itself if it finds headed mode
# without a DISPLAY.
# Linux persona: the Linux binary's coherent default — a windows persona on a
# linux host needs a Windows-captured fingerprint profile (see env.example).
ENV STORAGE_DIR=/app/data \
    NODE_ENV=production \
    STEALTH_HEADLESS=false \
    STEALTH_PLATFORM=linux \
    STEALTH_NICE_SHIM=/app/nice-shim.so \
    XVFB_SCREEN=1280x900x24

COPY worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
