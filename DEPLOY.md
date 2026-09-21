# HyperChat full-alpha deployment runbook

This is how you run the complete HyperChat app - accounts, servers,
channels, DMs, threads, reactions, pins, search, scheduled messages,
voice messages, calls (audio + camera + screenshare), profiles, stories -
with **durable data and full realtime**, outside of any preview sandbox.

## the 60-second version (alpha mode)

Everything below is automated now. On the host that should become the
server, from inside this repo:

```bash
# any linux box you control (installs docker if missing, generates
# secrets, builds, starts, waits for health):
./deploy/quickstart.sh                      # -> http://<host-ip>/
./deploy/quickstart.sh alpha.example.com    # -> https://alpha.example.com

# or a public https URL with no hardware at all:
./deploy/fly.sh                             # -> https://<app>.fly.dev
```

Both paths seed three tester accounts on first boot (cherry-picked alpha
mode, `SEED_DEMO=true`):

```
tester1 / tester2 / tester3    password: hyperion-alpha
```

Hand those to anyone and they are chatting a minute later. Remove the
`SEED_DEMO` line from `.env.production` for a clean slate where the first
registered account becomes ADMIN. The rest of this document is the same
machinery explained manually, plus operations and honest limits.

## what "full alpha" means

|                        | Netlify deploy            | this runbook (full alpha)   |
| ---------------------- | ------------------------- | --------------------------- |
| database              | /tmp, resets on cold start| SQLite on a persistent disk |
| uploaded files        | /tmp, same story          | persistent disk             |
| typing / presence     | degraded (HTTP polling)   | live over websockets        |
| voice + video calls   | unavailable               | fully available (needs TLS) |
| scheduled messages    | no background workers     | always-on scheduler         |

The reason is architectural: HyperChat is a long-lived server - a Next.js
process that shares a SQLite file with a socket.io sidecar it supervises
itself. Serverless platforms cannot run that shape; one persistent host
can, and everything below is just different ways of getting that host.

## the shape of a deployment

```
                one container / one host
  ┌──────────────────────────────────────────────────┐
  │  caddy  :3000 (or :80/:443 with auto-HTTPS)      │
  │    ├─ /socket.io/*  → sidecar :3003              │
  │    └─ everything   → Next.js standalone :3100    │
  │                        │ spawns + supervises     │
  │                        └→ sidecar :3003/:3004    │
  │  /data ← volume: custom.db + uploads/            │
  └──────────────────────────────────────────────────┘
```

- the browser talks to **one origin**; `/socket.io/*` is transparently
  routed to the sidecar (prefix stripped, because the sidecar speaks
  socket.io on path `/`)
- the app bootstraps the schema itself on an empty database
  (`src/lib/db-bootstrap.ts`), so a fresh volume just works
- the app respawns the sidecar every 20s if it ever dies
  (`src/instrumentation-node.ts`)

---

## path A - any VPS / any box with Docker (recommended)

Requirements: Docker + docker compose, 1 GB RAM is plenty, one open port
(80 for quick mode; 80 + 443 for a domain).

```bash
# 1. get the repo onto the host (git clone, or scp the zip)
cd hyperchat-repo

# 2. secrets (or skip them: ./deploy/quickstart.sh does all of this)
cp .env.production.example .env.production
openssl rand -hex 32   # paste into JWT_SECRET
openssl rand -hex 24   # paste into INTERNAL_TOKEN

# 3. build + run
docker compose up -d --build

# 4. it's live
open http://<host-ip>/
```

That's the whole install. The database and uploads land in the named
docker volume `hyperchat-data` and survive rebuilds and reboots.

### adding a domain (automatic HTTPS - also enables voice)

Browsers only grant microphone/camera access on secure origins, so for
calls you want TLS. With the bundled Caddy front door it is one variable:

```bash
# in .env.production:
SITE_ADDRESS=alpha.example.com

# in docker-compose.yml: swap the ports block
#   - "80:80"
#   - "443:443"
#   - "443:443/udp"

docker compose up -d
```

Point the domain's A/AAAA record at the host first - Caddy then obtains
and renews the Let's Encrypt certificate on its own. Ports 80 and 443
must both be reachable for the certificate handshake.

### one-off docker run (no compose)

```bash
docker build -t hyperchat:alpha .
docker run -d --name hyperchat \
  -p 80:80 -p 443:443 \
  -v hyperchat-data:/data \
  --env-file .env.production \
  -e SITE_ADDRESS=alpha.example.com \
  --restart unless-stopped \
  hyperchat:alpha
```

Drop `-e SITE_ADDRESS=...` and use `-p 80:3000` for plain-HTTP quick mode.

---

## path B - Fly.io (a public HTTPS URL without owning hardware)

Fly runs the same Dockerfile, gives you TLS at `<app>.fly.dev`, and
attaches a persistent volume - voice calls work out of the box.

```bash
npm i -g flyctl && fly auth login

cd hyperchat-repo
cp deploy/fly.toml.example fly.toml   # edit the app name
fly launch --no-deploy               # detects the Dockerfile; keep port 3000
fly volumes create hyperchat_data --size 1
fly secrets set JWT_SECRET=$(openssl rand -hex 32) \
                INTERNAL_TOKEN=$(openssl rand -hex 24)
fly deploy

# live at https://<app-name>.fly.dev
```

Notes:

- `auto_stop_machines = false` is already set in the example config:
  presence, typing and the message scheduler need an always-on machine
- a 1 GB volume costs roughly nothing a month - fine for an alpha
- the first request after a machine restart pays a short cold start while
  the app boots and the sidecar spawns

## path C - Railway / Render (Docker runtime)

Both platforms build this repo's Dockerfile natively:

1. create a **Docker** service from the repo (Railway auto-detects the
   Dockerfile; on Render choose "Existing image / Dockerfile")
2. attach a **persistent disk mounted at `/data`** (Render: "Disks" with
   mount path `/data`; Railway: add a volume, mount path `/data`)
3. set the environment variables `JWT_SECRET` and `INTERNAL_TOKEN`
   (and `DATABASE_URL=file:/data/custom.db`,
   `UPLOADS_DIR=/data/uploads` if the platform does not keep the image
   defaults)
4. expose port `3000` (the platform injects `PORT`; the entrypoint picks
   it up automatically and the platform's edge terminates TLS)

## path D - bare metal / a VM, no Docker

One machine, bun installed, one directory that survives reboots
(`/var/lib/hyperchat` below):

```bash
# 0. prerequisites: bun >= 1.3 on PATH, node 20 for tooling
curl -fsSL https://bun.sh/install | bash

# 1. repo + dependencies
git clone <your-repo> hyperchat && cd hyperchat
bun install
(cd mini-services/chat-service && bun install)

# 2. build the client bundle with the realtime path baked in
export NEXT_PUBLIC_SOCKET_PATH=/socket.io
bunx prisma generate
bun run build

# 3. a data directory the app owns
sudo mkdir -p /var/lib/hyperchat/uploads
sudo chown -R $USER /var/lib/hyperchat

# 4. run (the app spawns + supervises the sidecar itself)
DATABASE_URL=file:/var/lib/hyperchat/custom.db \
UPLOADS_DIR=/var/lib/hyperchat/uploads \
JWT_SECRET=$(openssl rand -hex 32) \
INTERNAL_TOKEN=$(openssl rand -hex 24) \
NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 \
bun .next/standalone/server.js
```

The app itself listens on loopback (HOSTNAME=127.0.0.1) - put your own
reverse proxy in front for TLS. The only routing rule that matters:
`/socket.io/*` must reach port 3003 with the prefix stripped.

nginx:

```nginx
server {
    server_name alpha.example.com;
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3003/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 60s;   # long-polling holds ~25s connections
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    # terminate TLS here (certbot / your cert of choice)
}
```

caddy on the host instead:

```
alpha.example.com {
    handle_path /socket.io/* {
        reverse_proxy 127.0.0.1:3003
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

For resilience, run the app under systemd (`Restart=always`) - the sidecar
needs nothing extra, the app supervises it.

---

## environment reference

| variable                   | where        | default                  | what it does |
| -------------------------- | ------------ | ------------------------ | ------------ |
| `JWT_SECRET`               | runtime      | dev key + loud warning   | signs login sessions |
| `INTERNAL_TOKEN`           | runtime      | dev token                | app ↔ sidecar control API auth |
| `DATABASE_URL`             | runtime      | `file:./db/custom.db`    | SQLite location; the image sets `file:/data/custom.db` |
| `UPLOADS_DIR`              | runtime      | `<cwd>/uploads`          | where uploaded files live; image sets `/data/uploads` |
| `LISTEN_PORT`              | runtime      | `3000`                   | caddy public port (http mode); platform `PORT` wins |
| `APP_PORT`                 | runtime      | `3100`                   | internal port the Next.js server binds |
| `SITE_ADDRESS`             | runtime      | empty (plain HTTP)       | domain for automatic HTTPS |
| `SEED_DEMO`                | runtime      | unset                    | `true` = seed tester1..3 / hyperion-alpha on an empty database |
| `NEXT_PUBLIC_SOCKET_PATH`  | **build**    | `/socket.io` in the image | browser socket path (sandbox default `/`) |
| `NEXT_PUBLIC_SOCKET_URL`   | **build**    | same origin              | cross-origin sidecar URL for split setups |
| `REALTIME_SERVICE_DIR`     | runtime      | auto-detected            | explicit sidecar location for exotic layouts |

`DATABASE_URL`, `UPLOADS_DIR` and the two `NEXT_PUBLIC_*` values are the
only knobs that decide where data lives and how the browser finds the
realtime service; everything else has a working default.

## operations

```bash
# logs (app, sidecar and caddy all write to the container log)
docker compose logs -f app

# health: docker ps shows (healthy) - the check hits the app's internal
# port; the sidecar is covered by the app's own 20s respawn loop

# backup: stop writes, snapshot both halves
docker compose exec app sh -c 'cd /data && sqlite3 custom.db ".backup backup.db"'
docker run --rm -v hyperchat_hyperchat-data:/data -v $(pwd):/out alpine \
    tar czf /out/hyperchat-backup.tgz -C /data custom.db uploads

# restore
docker run --rm -v hyperchat_hyperchat-data:/data -v $(pwd):/in alpine \
    sh -c 'cd /data && tar xzf /in/hyperchat-backup.tgz'

# update to a new build - data survives, it's on the volume
git pull && docker compose up -d --build
```

Bare-metal backups are even simpler: the entire state is one SQLite file
plus one uploads directory - copy both.

## honest limits of this alpha

- **single host**: SQLite + in-memory voice sessions mean one machine,
  one container. That is the entire design space of a tester alpha; it
  comfortably holds hundreds of simultaneous chatters.
- **no TURN server**: WebRTC connects peers directly; a minority of
  symmetric-NAT networks will fail to connect calls. A TURN service
  (coturn) can be added later without touching the app.
- **cold starts**: platform machines that park on zero traffic (Fly with
  `auto_stop_machines = true`, Render free tier) lose nothing (data is on
  the volume) but take a few seconds to answer the first request again -
  and the example configs deliberately keep one machine always on.
- **no email**: password reset / email verification need an SMTP
  transporter you would add to the app later.

## where the sandbox accounts went

The preview database (`db/custom.db` with the glm / qamobile / qacall2
accounts) is deliberately **not** shipped in the image - an alpha starts
from an empty volume and bootstraps its own schema on first boot. For
instant testability, set `SEED_DEMO=true` (both helper scripts do this by
default) and the first boot creates `tester1` / `tester2` / `tester3` with
password `hyperion-alpha` - tester1 is ADMIN. Register additional real
accounts through the UI whenever you like.
