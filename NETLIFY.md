# HyperChat on Netlify

## what this is
the full HyperChat app: Next.js 16 (App Router) + Prisma/SQLite + a
socket.io realtime sidecar. accounts, servers, channels (text / voice /
forum), DMs and group chats, threads, reactions, pins, search, scheduled
messages, voice messages with real waveforms, 1:1 and group calls
(audio + camera + screenshare), an Instagram-style profile system with
posts, likes, comments, follows and 24h stories.

## the fast path (recommended)
Netlify's strength is static + serverless; HyperChat is a long-lived Node
server (websockets + SQLite). two supported shapes:

### shape 1 — full app on a Node host (the full alpha)
the repo ships a ready-made Docker setup: one container with the app, the
realtime sidecar and a front proxy, durable data on a /data volume.

1. unzip this archive on the host (Render / Railway / Fly / a VPS)
2. `cp .env.production.example .env.production` and fill in JWT_SECRET
   + INTERNAL_TOKEN
3. `docker compose up -d --build` — the app, sidecar, TLS and persistent
   storage all come up together

manual, without Docker (build once, one process tree):
`bun install && bunx prisma generate && bun run build` with
`NEXT_PUBLIC_SOCKET_PATH=/socket.io`, then
`DATABASE_URL=file:/abs/path.db UPLOADS_DIR=/abs/uploads JWT_SECRET=... INTERNAL_TOKEN=... NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 bun .next/standalone/server.js`
(the app spawns and supervises the sidecar itself; a reverse proxy must
route /socket.io/* to port 3003 with the prefix stripped)

the complete runbook - VPS, Fly.io, Railway/Render, bare metal, backups -
lives in DEPLOY.md.

### shape 2 — Netlify with the Next runtime
1. unzip, `netlify deploy --build` (the netlify.toml in this archive is
   already wired: build command, prisma generate + db push, static caches
   for /flags and /sounds)
2. deploy the `mini-services/chat-service` folder to any tiny always-on
   host (it is an independent bun project, port 3003) and set its URL in
   the app's `Caddyfile`-equivalent proxy / gateway rule
3. without the sidecar the app still works: message delivery falls back
   to the `/api/sync` HTTP poll. realtime presence, typing, calls and
   the live event stream need the sidecar.

## environment
- `DATABASE_URL` — SQLite path (defaults to `file:./db/custom.db`; the
  archive ships the live database with the four real accounts)
- `JWT_SECRET`, `INTERNAL_TOKEN` — already set in `.env` for development;
  rotate both for production
- optional: `KLIPY_API_KEY` / `GIPHY_API_KEY` for live GIF search

## data notes
- the SQLite file lives at `db/custom.db`; on Netlify's ephemeral
  filesystem it resets on redeploy — for persistence mount a volume or
  point `DATABASE_URL` at a hosted database (Prisma supports Postgres
  with the same schema)
- uploaded files land in `uploads/` and are served from `/api/files/*`;
  same persistence note as above
