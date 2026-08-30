# Worker container.
#
# Only the worker runs here. The dashboard is already served by Vercel and the
# database by Supabase; this image exists solely to give the browser a machine
# that never sleeps.
#
# Built on Playwright's own image because it ships Chromium together with the
# system libraries it needs. Installing those by hand on a slim base is a
# recurring source of "works locally, fails in the container".
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV NODE_ENV=production \
    # The worker's own default is a visible window, which is correct on a
    # desktop and impossible here. Overridden for the one-time login below.
    WORKER_HEADLESS=true \
    # Persistent volume. The browser profile IS the LinkedIn session: on
    # ephemeral storage every restart means signing in again.
    BROWSER_PROFILE_DIR=/data/browser-profile \
    SCREENSHOT_DIR=/data/screenshots

WORKDIR /app

# Dependencies first, so a source change does not reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The worker needs the Prisma client generated, but holds no database
# credentials and never connects: it reaches data only through the authenticated
# /api/worker/* endpoints.
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npx prisma generate

COPY src ./src

RUN mkdir -p /data/browser-profile /data/screenshots

# Run as the image's non-root user. A browser rendering hostile pages should not
# be root, and Playwright's image already provides a suitable account.
RUN chown -R pwuser:pwuser /data /app
USER pwuser

# No healthcheck on a port: this process serves nothing. Liveness is the
# heartbeat the dashboard already tracks, which is a better signal anyway
# because it proves the worker can still reach the API.
CMD ["npx", "tsx", "src/worker/main.ts"]
