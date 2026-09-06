# Single deploy for everything: this image ships Playwright Chromium, builds
# the Vite frontend + the Node backend, then one process serves the app AND
# the /ws browser socket on the same domain (auto-connect, no config needed).
#
# Keep the base image version in lockstep with the "playwright" npm dependency.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# DevDependencies (typescript etc.) are needed for the build step, so do NOT
# set NODE_ENV=production before this point.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "worker/dist/index.js"]