#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# HYPERION — first-time installer (run by the hyperion manager, option 1)
#
# What it does, in order:
#   1. checks for bun (downloads the single static binary if missing)
#   2. installs the javascript dependencies
#   3. writes .env with REAL random secrets + the DATABASE_URL location
#      (this must happen BEFORE the database step — the prisma tool reads
#      DATABASE_URL, and without it the install dies with
#      "Environment variable not found: DATABASE_URL")
#   4. creates a FRESH empty database (no accounts, nothing personal)
#   5. builds the production server (a few quiet minutes)
#   6. marks the install done
#
# Note: the server is fully standalone — no external link or account is
# needed to install or run it. (Clients find you through the txt you
# publish on github; the manager's tunnel option prints that address.)
#
# Safe to re-run: every step is skipped when already complete.
#   An .env left over from an older install is SELF-HEALED: if the
#   DATABASE_URL line is missing, it is appended automatically (the very
#   first zip shipped a setup that forgot to write it).
# Dry run:  bash setup.sh --dry-run   (prints the plan, does nothing)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

APP_PORT="${APP_PORT:-3000}"

# the build fingerprint: sha256 of everything `next build` reads, computed
# from the files ON DISK (mtimes are never trusted: unzip restores archived
# timestamps and box clocks disagree). setup skips a rebuild only when
# .build-done holds this exact value.
build_stamp() {
  ( cd "$HERE" && find src public prisma package.json bun.lock \
      next.config.ts tsconfig.json postcss.config.mjs components.json \
      -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum 2>/dev/null || true ) \
    | sha256sum | cut -c1-16
}

# `bash setup.sh --print-build-stamp` — print the fingerprint and exit.
# the manager (./hyperion, option 1) compares it to .build-done to notice a
# newer zip that changed app files, then rebuilds for you. no work is done.
if [ "${1:-}" = "--print-build-stamp" ]; then
  build_stamp
  exit 0
fi

G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; R=$'\033[0m'; D=$'\033[2m'
step() { printf '\n%s==>%s %s\n' "$B" "$R" "$1"; }
okm()  { printf '    %s✔%s %s\n' "$G" "$R" "$1"; }
note() { printf '    %s·%s %s\n' "$D" "$R" "$1"; }
warnm(){ printf '    %s!%s %s\n' "$Y" "$R" "$1"; }
run()  { if [ $DRY_RUN -eq 1 ]; then note "dry-run: $*"; else "$@"; fi; }

# ── 1. bun ───────────────────────────────────────────────────────────────────
step "checking for bun (the runtime — one static file, nothing to install system-wide)"
if command -v bun >/dev/null 2>&1; then
  okm "bun found: $(bun --version)"
else
  warnm "bun not found — downloading the static binary into ./bin (no root needed)"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  BUN_URL="https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip" ;;
    aarch64) BUN_URL="https://github.com/oven-sh/bun/releases/latest/download/bun-linux-aarch64.zip" ;;
    *) printf '    ✖ unsupported cpu type: %s\n' "$ARCH"; exit 1 ;;
  esac
  run mkdir -p "$HERE/bin" "$HERE/tmp-dl"
  run curl -fsSL "$BUN_URL" -o "$HERE/tmp-dl/bun.zip"
  run unzip -oq "$HERE/tmp-dl/bun.zip" -d "$HERE/tmp-dl"
  run cp "$HERE"/tmp-dl/bun-*/bun "$HERE/bin/bun"
  run chmod +x "$HERE/bin/bun"
  run rm -rf "$HERE/tmp-dl"
  export PATH="$HERE/bin:$PATH"
  okm "bun installed locally: $HERE/bin/bun"
fi
[ $DRY_RUN -eq 1 ] && exit 0

# ── 2. dependencies ─────────────────────────────────────────────────────────
# Skip ONLY when bun install already ran for THIS EXACT dependency set — the
# marker holds a content hash of package.json + bun.lock computed from the
# files on disk (mtimes are never trusted: unzip restores archived timestamps
# and box clocks disagree). A zip update that only changed the manager scripts
# reuses the installed dependencies untouched.
deps_stamp() {
  ( cd "$HERE" && sha256sum package.json bun.lock 2>/dev/null || true ) | sha256sum | cut -c1-16
}
if [ -d "$HERE/node_modules" ] && [ -f "$HERE/.deps-done" ] \
   && [ "$(cat "$HERE/.deps-done" 2>/dev/null)" = "$(deps_stamp)" ]; then
  step "dependencies already installed — skipping"
else
  step "installing/updating dependencies (bun install — a minute or two)"
  bun install
  deps_stamp > "$HERE/.deps-done"
  okm "dependencies ready"
fi

# ── 3. .env with real secrets (BEFORE the database — prisma reads it) ───────
if [ -f "$HERE/.env" ]; then
  step ".env already exists — keeping your secrets"
  # self-heal: the very first zip's setup forgot DATABASE_URL — append it
  if grep -q '^DATABASE_URL=' "$HERE/.env"; then
    okm "database location present"
  else
    printf 'DATABASE_URL="file:%s/db/custom.db"\n' "$HERE" >> "$HERE/.env"
    okm "added the missing DATABASE_URL line (older installs forgot it)"
  fi
  # self-heal #2: realtime through the web app itself (same-origin). this
  # line is baked into the built pages at build time — without it the pages
  # look for the realtime service the way THIS dev sandbox reaches it
  # (a gateway query trick no self-hosted box has) and chat stays offline.
  if grep -q '^NEXT_PUBLIC_SOCKET_PATH=' "$HERE/.env"; then
    okm "realtime path setting present"
  else
    printf 'NEXT_PUBLIC_SOCKET_PATH=/socket.io\n' >> "$HERE/.env"
    okm "added the missing NEXT_PUBLIC_SOCKET_PATH line (chat needs it)"
  fi
else
  step "writing .env (fresh random secrets — never shipped, never shared)"
  JWT_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  INTERNAL_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  cat > "$HERE/.env" <<ENV
# hyperion server environment — generated by setup on $(date '+%Y-%m-%d %H:%M:%S')
PORT=$APP_PORT
# where the database lives (one file — copy it = full backup)
DATABASE_URL="file:$HERE/db/custom.db"
# browsers reach the realtime service through the web app itself (the app
# proxies /socket.io to it — next.config.ts). baked into the pages at build.
NEXT_PUBLIC_SOCKET_PATH=/socket.io
JWT_SECRET=$JWT_SECRET
INTERNAL_TOKEN=$INTERNAL_TOKEN
# where the vault keeps file chunks (defaults to db/vault)
# VAULT_DIR=/mnt/your-big-drive/hyperion-vault
#
# that is everything — this server needs no outside link or account.
# people find you through the txt you keep on github: the manager's
# tunnel option (7) prints your current public address to paste there.
ENV
  chmod 600 "$HERE/.env"
  okm ".env written (random secrets generated just for this machine)"
  note "the file-sending vault stores chunks in db/vault — to use your big"
  note "drive instead, open .env and set VAULT_DIR=/path/on/your/drive"
fi

# ── 4. fresh database ───────────────────────────────────────────────────────
if [ -f "$HERE/db/custom.db" ]; then
  step "database already exists — keeping it (nothing is ever deleted)"
  note "db file: db/custom.db"
else
  step "creating a FRESH empty database"
  mkdir -p "$HERE/db" "$HERE/db/vault"
  bun run db:push
  okm "empty database created — the first account you register becomes the admin"
fi

# ── 5. production build ─────────────────────────────────────────────────────
# Same rule as the deps step, but for everything `next build` reads: the
# source, public assets, the prisma schema and the config files. Rebuild
# whenever any of it changed since the last build — a stale build running
# old code is worse than a rebuild. Delete .build-done to force one by hand.
# (the build_stamp fingerprint function lives at the top of this file — the
# manager calls `setup.sh --print-build-stamp` to detect zip updates.)
if [ -f "$HERE/.next/standalone/server.js" ] && [ -f "$HERE/.build-done" ] \
   && [ "$(cat "$HERE/.build-done" 2>/dev/null)" = "$(build_stamp)" ]; then
  step "already built — skipping (delete .build-done to force a rebuild)"
else
  step "building the production server (a few quiet minutes, once)"
  bun run build
  build_stamp > "$HERE/.build-done"
  okm "build complete"
fi

# ── 6. done ─────────────────────────────────────────────────────────────────
mkdir -p "$HERE/logs" "$HERE/run" "$HERE/backups"
touch "$HERE/.installed"
printf '\n'
printf '  %s✔ install complete%s\n' "$G" "$R"
printf '  next: run %s./hyperion%s and pick 1 (start)\n' "$B" "$R"
printf '  then open http://THIS-MACHINE:%s and register —\n' "$APP_PORT"
printf '  the FIRST account becomes the site admin automatically\n'
printf '\n'
