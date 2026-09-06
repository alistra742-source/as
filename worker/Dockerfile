# Pin the Playwright image to the same major version as the npm dependency
# so the bundled Chromium matches. Bump both together.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build

EXPOSE 8080

CMD ["node", "dist/index.js"]
