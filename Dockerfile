# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# HyperChat full-alpha image
#
# One container, three cooperating processes:
#   1. bun server.js        - the Next.js standalone server (internal
#      APP_PORT, loopback) which itself spawns and supervises the socket.io
#      sidecar on 3003 (control API on 127.0.0.1:3004) via
#      src/instrumentation-node.ts, and bootstraps the SQLite schema on an
#      empty database (src/lib/db-bootstrap.ts)
#   2. caddy                - the public front door: plain HTTP on
#      LISTEN_PORT (or 80/443 with automatic HTTPS when SITE_ADDRESS is a
#      real domain), routing /socket.io/* to the sidecar and everything
#      else to the app
#   3. deploy/entrypoint.sh - starts caddy in the background and execs the
#      app as PID 1, so a hard app crash takes the container down and the
#      restart policy brings the whole stack back
#
# Durable state (SQLite database + uploaded files) lives in /data - mount a
# volume or a host directory there. See DEPLOY.md for the full runbook.
# -----------------------------------------------------------------------------

# ---- dependencies: resolved once, reused by the build stage ----------------
FROM oven/bun:1.3 AS deps
WORKDIR /repo
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY mini-services/chat-service/package.json mini-services/chat-service/bun.lock ./mini-services/chat-service/
RUN cd mini-services/chat-service && bun install --frozen-lockfile

# ---- build: prisma client + the standalone Next.js bundle ------------------
FROM oven/bun:1.3 AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# Client-side realtime wiring, inlined into the browser bundle at build time:
# same-origin /socket.io through the front door. Override with
# --build-arg NEXT_PUBLIC_SOCKET_URL=https://rt.example.com for a split setup.
ARG NEXT_PUBLIC_SOCKET_PATH=/socket.io
ARG NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_SOCKET_PATH=${NEXT_PUBLIC_SOCKET_PATH} \
    NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL} \
    DATABASE_URL="file:./db/custom.db"
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/mini-services/chat-service/node_modules ./mini-services/chat-service/node_modules
COPY . .
RUN bunx prisma generate && bun run build
# belt and braces: the prisma client + query engine must survive Next's
# output file tracing into the standalone bundle
RUN cp -r node_modules/.prisma node_modules/@prisma .next/standalone/node_modules/

# ---- runtime: app + sidecar + caddy front door -----------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    LISTEN_PORT=3000 \
    APP_PORT=3100 \
    DATABASE_URL="file:/data/custom.db" \
    UPLOADS_DIR="/data/uploads"
# the standalone server (server.js + traced node_modules + static + public)
COPY --from=build /repo/.next/standalone ./
# the realtime sidecar, spawned + supervised by the app itself
COPY --from=build /repo/mini-services/chat-service ./mini-services/chat-service
# static front-door binary (official caddy releases are statically linked)
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy
COPY deploy/Caddyfile.http deploy/Caddyfile.tls deploy/entrypoint.sh /deploy/
RUN chmod +x /deploy/entrypoint.sh \
    && useradd --create-home --shell /usr/sbin/nologin hyperchat \
    && mkdir -p /data/uploads \
    && chown -R hyperchat:hyperchat /app /deploy /data
USER hyperchat
VOLUME /data
EXPOSE 3000 80 443
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3100)+'/').then(r=>process.exit(r.status>499?1:0)).catch(()=>process.exit(1))"
ENTRYPOINT ["/deploy/entrypoint.sh"]
