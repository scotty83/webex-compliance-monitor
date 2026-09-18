# syntax=docker/dockerfile:1
# ============================================================================
# Webex Compliance Bot — single image, single origin on :4000.
#
# Stage 1 builds the Vite SPA -> /app/frontend/dist (served by the backend via
#   FRONTEND_DIST — see backend/src/server.ts single-origin fallback) and
#   vendors the Webex browser SDK (UMD) + the compiled bot-page core into
#   /app/bot-page — the headless-Chromium bot page loads these with NO
#   runtime CDN (see bot-page/README.md).
# Stage 2 installs backend node_modules with a FULL `npm ci`: the start script
#   is `tsx src/main.ts` and tsx is a devDependency; there is NO compile step
#   and NO native addon (sqlite = Node 24's node:sqlite builtin). It also
#   compiles backend/src/media/botPageCore.ts standalone so bot.js's
#   `import './botPageCore.js'` resolves in the browser.
# Stage 3 (runtime) hosts headless Chromium (WebRTC + WebCodecs) running the
#   vendored Webex SDK bot page — this replaced the old SIP media stack
#   (baresip + PulseAudio + ffmpeg).
#
# NOTE: the first real build happens ON THE NAS (no Docker on the authoring
# Mac). Likely-failure triage lives in the deploy plan, Task 7.
# ============================================================================

# ---- Stage 1: frontend build + vendor bot-page assets ----
FROM node:24-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Do NOT set VITE_MOCK here — a mock build would ship fake data. The SPA uses
# relative fetch paths (same-origin), so there is no backend-URL build arg.
RUN npm run build
# Vendor the Webex browser SDK (UMD) for the loopback bot page — NO runtime CDN.
# Path verified locally against webex@3.12.0: node_modules/webex/umd/webex.min.js
# (self-contained webpack UMD bundle, exposes global `Webex`). If a future
# `webex` version moves this path, update the `cp` line below (see
# bot-page/README.md).
COPY bot-page/ /app/bot-page/
RUN cp node_modules/webex/umd/webex.min.js /app/bot-page/webex.min.js

# ---- Stage 2: backend deps (full npm ci — tsx runtime is a devDependency) ----
FROM node:24-bookworm-slim AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
# Compile the bot-page core standalone (no project imports) so bot.js's
# `import './botPageCore.js'` resolves as a plain ES module in the browser.
RUN npx tsc src/media/botPageCore.ts --outDir /app/bot-page-core --module es2022 --target es2022 --moduleResolution bundler

# ---- Stage 3: runtime — headless Chromium + app ----
FROM node:24-bookworm-slim AS runtime
# chromium         : headless browser hosting the Webex SDK bot page (WebRTC + WebCodecs).
# fonts + libs     : Chromium's runtime deps on bookworm-slim.
# curl             : compose healthcheck; ca-certificates: TLS trust.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 libgbm1 \
      curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Puppeteer uses the OS Chromium; never download its own.
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app/backend
COPY --from=backend /app/backend /app/backend
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY --from=frontend /app/bot-page /app/bot-page
COPY --from=backend /app/bot-page-core/botPageCore.js /app/bot-page/botPageCore.js
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV PORT=4000
ENV FRONTEND_DIST=/app/frontend/dist
ENV DATABASE_PATH=/app/backend/data/compliance-monitor.db
ENV BOT_PAGE_ASSET_DIR=/app/bot-page
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "start"]
