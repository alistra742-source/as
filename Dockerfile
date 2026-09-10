# Single deploy for everything: this image builds the Vite frontend + the Node
# backend, then one process serves the app AND the /ws browser socket on the
# same domain (auto-connect, no config needed).
#
# The default browser driver is stock Chromium through Playwright; Clearcote's
# anti-fingerprint build remains opt-in. Both are driven over CDP with humanized
# trusted input and use the same persistent profile for each named account.
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
    ffmpeg \
    tesseract-ocr-eng \
    tor \
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

# Fail the image build—not a user's publish—if Debian ever drops Tesseract or the
# exact filters/encoders used by discovery screening and the adaptive quality
# master. This exercises denoise → exposure → Lanczos → blur/overlay → H.264/AAC.
RUN tesseract --version >/dev/null && ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=540x960:rate=30:duration=0.2" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=0.2" \
    -filter_complex "[0:v]hqdn3d=1.0:1.0:3.5:3.5,eq=brightness=0.055:contrast=1.050:saturation=1.080:gamma=1.100,unsharp=5:5:0.72:5:5:0,split=2[base][front];[base]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,gblur=sigma=28[bg];[front]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=yuv420p[v]" \
    -map "[v]" -map 1:a:0 -frames:v 2 -c:v libx264 -preset ultrafast -c:a aac \
    -movflags +faststart /tmp/viraldeck-ffmpeg-smoke.mp4 \
  && test "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 /tmp/viraldeck-ffmpeg-smoke.mp4)" = "1080x1920" \
  && rm -f /tmp/viraldeck-ffmpeg-smoke.mp4

WORKDIR /app

# DevDependencies (typescript, vite, etc.) are needed for the build step, so
# do NOT set NODE_ENV=production before this point. npm ci + the committed
# package-lock.json = byte-for-byte the same dependency tree we build locally.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# The browser. The default engine is stock Chromium pulled by Playwright into a
# shared path (/opt/playwright, outside node_modules so `npm prune` cannot reach
# it). The Clearcote anti-fingerprint build (~150 MB) is opt-in: pass
# `--build-arg WITH_CLEARCOTE=true` and set BROWSER_ENGINE=clearcote at runtime.
# Both engines read the SAME persistent profile dir, so switching engines does not
# log anything out.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN mkdir -p /opt/playwright && chown -R node:node /opt/playwright
# `--no-shell` skips the separate headless-shell build: this container runs headed
# on Xvfb, and if someone flips STEALTH_HEADLESS=true it is better to reuse the
# same real binary (--headless=new) than to boot a stripped build whose
# fingerprint screams CI. The env override undoes the skip flag for this one call.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npm_config_playwright_skip_browser_download= \
      node node_modules/playwright-core/cli.js install --no-shell chromium && \
    chown -R node:node /opt/playwright

# Pre-download + SHA-256-verify the Clearcote browser so deploys never touch
# GitHub at runtime. Runtime reads it from the same cache dir
# (CLEARCOTE_CACHE_DIR). Progress is logged so this step is visible in the
# build output; any failure fails the build with the underlying error.
ENV CLEARCOTE_CACHE_DIR=/app/.clearcote-browser
ARG WITH_CLEARCOTE=false
RUN if [ "$WITH_CLEARCOTE" = "true" ]; then node worker/download-browser.mjs; else echo "skipping the Clearcote build (needed only for BROWSER_ENGINE=clearcote)"; fi

# Drop build-only tooling from the final image.
RUN npm prune --omit=dev

# The setpriority shim (built in stage 0) — injected into the browser via
# LD_PRELOAD (see worker/nice-shim.c for the why).
COPY --from=shim-builder /nice-shim.so /app/nice-shim.so

# Headed under Xvfb by default (the official Clearcote container does the
# same: headed Chrome avoids headless-mode tells, and stock Chromium wants the
# same treatment — the dock and the tap mapping assume a real window). Set STEALTH_HEADLESS=true
# to run headless and skip Xvfb. The entrypoint starts Xvfb; as a belt-and-
# braces fallback the worker also boots Xvfb itself if it finds headed mode
# without a DISPLAY.
# Linux persona: the Linux binary's coherent default — a windows persona on a
# linux host needs a Windows-captured fingerprint profile (see env.example).
ENV STORAGE_DIR=/app/data \
    NODE_ENV=production \
    BROWSER_ENGINE=playwright \
    TOR_PROXY_ENABLED=true \
    TOR_SOCKS_HOST=127.0.0.1 \
    TOR_SOCKS_PORT=9050 \
    STEALTH_HEADLESS=false \
    STEALTH_PLATFORM=linux \
    STEALTH_NICE_SHIM=/app/nice-shim.so \
    XVFB_SCREEN=1280x900x24

COPY worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
