# Interactive login container.
#
# The login flow hardcodes a visible browser window (src/worker/browser.ts) and
# that is deliberate - a person signs in by hand, nothing is typed or solved
# programmatically. A headless server has no screen, so this image supplies one:
# Xvfb for the display, x11vnc to share it, noVNC to reach it from a browser.
#
# Run it once, sign in, stop it. It is behind a compose profile so it is never
# started by accident.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99 \
    WORKER_HEADLESS=false \
    BROWSER_PROFILE_DIR=/data/browser-profile \
    SCREENSHOT_DIR=/data/screenshots

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npx prisma generate
COPY src ./src
COPY deploy/login-entrypoint.sh /usr/local/bin/login-entrypoint.sh
RUN chmod +x /usr/local/bin/login-entrypoint.sh && mkdir -p /data/browser-profile /data/screenshots

CMD ["/usr/local/bin/login-entrypoint.sh"]
