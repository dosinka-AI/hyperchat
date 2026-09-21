#!/bin/sh
# HyperChat full-alpha entrypoint: one container, three cooperating
# processes. Caddy (the public front door) starts in the background; the
# Next.js standalone server is exec'd as PID 1, so a hard app crash exits
# the container and the restart policy brings the whole stack back. The
# app itself spawns and supervises the socket.io sidecar (3003 + control
# API on 3004) through src/instrumentation-node.ts.
set -eu

cd /app

# The public port: a platform-injected PORT (Railway, Render) wins, then
# LISTEN_PORT, then 3000. PORT never reaches the app or the sidecar: the
# app listens on the internal APP_PORT below, and the sidecar hardcodes
# 3003/3004.
LISTEN_PORT="${PORT:-${LISTEN_PORT:-3000}}"
export LISTEN_PORT
APP_PORT="${APP_PORT:-3100}"

# 1. the front door (background)
if [ -n "${SITE_ADDRESS:-}" ]; then
  caddy run --config /deploy/Caddyfile.tls --adapter caddyfile &
else
  caddy run --config /deploy/Caddyfile.http --adapter caddyfile &
fi

# 2. the web app - and, through it, the realtime sidecar - as PID 1
export PORT="$APP_PORT"
export HOSTNAME=127.0.0.1
exec bun server.js
