#!/bin/sh
# One command from this repo to a public https URL on fly.io - no hardware,
# no domain, TLS handled by the platform.
#
#     ./deploy/fly.sh                 # app name auto-generated
#     ./deploy/fly.sh my-alpha        # pick the app name
#     FLY_REGION=lax ./deploy/fly.sh  # deploy closer to your testers
#     ./deploy/fly.sh --dry-run       # print the plan only
#
# Needs a fly.io account (fly.io - the platform requires a card; one tiny
# always-on machine + 1GB volume runs at cents-per-hour scale). The first
# run pauses for `fly auth login`, which opens a browser.
set -eu

DRY_RUN=0
APP_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: $0 [app-name] [--dry-run]   (env: FLY_REGION, FLY_ORG)"
      exit 0 ;;
    *) APP_ARG="$arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
if [ ! -f Dockerfile ] || [ ! -f deploy/fly.toml.example ]; then
  echo "error: run this from inside the hyperchat repo" >&2
  exit 1
fi

say() { printf '\n==> %s\n' "$*"; }

rand_hex() {
  n="$1"
  out=""
  if command -v openssl >/dev/null 2>&1; then
    out="$(openssl rand -hex "$n" 2>/dev/null || true)"
  fi
  if [ -z "$out" ]; then
    out="$(head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s' "$out"
}

# ---- 1. flyctl --------------------------------------------------------------
FLY="$(command -v fly 2>/dev/null || true)"
if [ -z "$FLY" ] && [ -x "$HOME/.fly/bin/fly" ]; then
  FLY="$HOME/.fly/bin/fly"
fi
if [ -z "$FLY" ]; then
  say "flyctl not found - installing it (one-time)"
  [ "$DRY_RUN" = 1 ] || curl -L https://fly.io/install.sh | sh
  FLY="$HOME/.fly/bin/fly"
fi

# ---- 2. plan ----------------------------------------------------------------
APP="${APP_ARG:-hyperchat-$(date +%y%m%d%H%M)}"
REGION="${FLY_REGION:-iad}"
ORG="${FLY_ORG:-personal}"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run plan:"
  echo "  flyctl:   $FLY"
  echo "  app:      $APP (org $ORG, region $REGION)"
  echo "  volume:   hyperchat_data, 1GB, mounted at /data"
  echo "  secrets:  JWT_SECRET + INTERNAL_TOKEN (random), SEED_DEMO=true"
  echo "  deploy:   fly deploy (builds this repo's Dockerfile remotely)"
  echo "  url:      https://$APP.fly.dev"
  exit 0
fi

# ---- 3. auth (interactive the first time: opens a browser) ------------------
"$FLY" auth whoami >/dev/null 2>&1 || {
  say "login to fly.io (a browser window opens)"
  "$FLY" auth login
}

# ---- 4. app + volume + secrets ----------------------------------------------
say "creating app $APP (org $ORG)"
"$FLY" apps create "$APP" --org "$ORG" || say "app exists already - continuing with it"

cp deploy/fly.toml.example fly.toml
sed -i.bak "s/^app = .*/app = \"$APP\"/" fly.toml && rm -f fly.toml.bak
sed -i.bak "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml && rm -f fly.toml.bak

say "attaching a 1GB volume at /data (region $REGION)"
"$FLY" volumes create hyperchat_data --size 1 --app "$APP" --region "$REGION" || say "volume exists already - reusing it"

say "setting secrets (auto-generated; demo accounts on)"
"$FLY" secrets set \
  JWT_SECRET="$(rand_hex 32)" \
  INTERNAL_TOKEN="$(rand_hex 24)" \
  SEED_DEMO=true \
  --app "$APP"

# ---- 5. deploy --------------------------------------------------------------
say "deploying (a few minutes: remote build, image push, machine start)"
"$FLY" deploy

say "done. the alpha is live at https://$APP.fly.dev"
echo "  tester accounts: tester1 / tester2 / tester3, password: hyperion-alpha"
echo "  data lives on the hyperchat_data volume and survives redeploys"
echo "  logs: $FLY logs -a $APP"
echo "  destroy everything later: $FLY apps destroy $APP"
