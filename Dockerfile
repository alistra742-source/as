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
# Ubuntu 24.04 base: matches the glibc/libs the Clearcote Linux binary expects,
# with Chrome's runtime dependencies installed for it.
FROM node:22-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libegl1 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0t64 \
    libgtk-3-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# DevDependencies (typescript, vite, etc.) are needed for the build step, so
# do NOT set NODE_ENV=production before this point.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# Pre-download + SHA-256-verify the Clearcote browser so deploys never touch
# GitHub at runtime. Runtime reads it from the same cache dir (CLEARCOTE_CACHE_DIR).
ENV CLEARCOTE_CACHE_DIR=/app/.clearcote-browser
RUN node -e "import('clearcote').then(async (m) => { const p = await m.download({ cacheDir: process.env.CLEARCOTE_CACHE_DIR, quiet: true }); console.log('[build] clearcote browser ready:', p); })"

# Drop build-only tooling from the final image.
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "worker/dist/index.js"]
