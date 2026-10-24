#!/usr/bin/env bash
# Set up and start the lobby on this server: an EC2 instance (or any Linux box with a public IPv4).
#
#   git clone <this repo> && cd <it>/lobby/deploy && ./setup.sh
#   LOBBY_HOST=lobby.example.com ./setup.sh     a DNS name instead of the bare IP
#
# 1. Installs Docker (with its compose plugin) if it is missing: Ubuntu/Debian or Amazon Linux.
# 2. Writes .env beside this script, once: this machine's public and private addresses (from the EC2
#    instance metadata, else from checkip.amazonaws.com and `hostname -I`) and a fresh TURN secret.
#    A later run keeps it; delete .env to start over.
# 3. Builds and starts the lobby, Caddy and coturn, waits for the certificate, and prints the LOBBY_URL
#    each sim puts in its .env.
#
# Re-run any time (after a git pull, say): it rebuilds and restarts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
say() { printf '\n== %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)

# -- 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | $SUDO sh
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y docker
    $SUDO mkdir -p /usr/local/lib/docker/cli-plugins
    $SUDO curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$(uname -m)"
    $SUDO chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  else
    die "no apt-get or dnf here: install Docker with its compose plugin, then run this again"
  fi
  $SUDO systemctl enable --now docker
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
$DOCKER compose version >/dev/null 2>&1 || die "docker compose is missing: install Docker's compose plugin"

# -- 2. .env
if [ ! -f .env ]; then
  say "writing .env"
  tok=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
  md() { curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true; }
  public=$(md public-ipv4); private=$(md local-ipv4)
  [ -n "$public" ] || public=$(curl -fsS -m 5 https://checkip.amazonaws.com | tr -d '[:space:]' || true)
  [ -n "$private" ] || private=$(hostname -I | awk '{print $1}')
  [ -n "$public" ] || die "could not tell this machine's public address: set LOBBY_PUBLIC_IP and run again"
  public=${LOBBY_PUBLIC_IP:-$public}
  host=${LOBBY_HOST:-$public}
  secret=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  umask 077
  cat > .env <<EOF
# Written by setup.sh. LOBBY_HOST is what the sims connect to (wss://LOBBY_HOST/) and what the
# certificate is for: this machine's public IPv4, or a DNS name pointing at it.
LOBBY_HOST=$host
LOBBY_PUBLIC_IP=$public
LOBBY_PRIVATE_IP=$private
# Shared by the lobby (it mints each office's TURN credentials) and coturn (it checks them). Never sent.
TURN_SECRET=$secret
EOF
fi
# shellcheck disable=SC1091
. ./.env
printf 'lobby host: %s (public %s, private %s)\n' "$LOBBY_HOST" "$LOBBY_PUBLIC_IP" "$LOBBY_PRIVATE_IP"

# -- 3. up
say "building and starting the lobby, Caddy and coturn"
$DOCKER compose up -d --build

say "waiting for the certificate and the lobby (Caddy asks Let's Encrypt; ports 80 and 443 must be open)"
for i in $(seq 1 45); do
  if out=$(curl -fsS -m 5 "https://$LOBBY_HOST/health" 2>/dev/null); then
    printf 'up: %s' "$out"
    say "done. In each sim's .env:"
    printf '  LOBBY_URL=wss://%s/\n' "$LOBBY_HOST"
    exit 0
  fi
  sleep 4
done
$DOCKER compose ps
$DOCKER compose logs --tail 30 caddy
die "https://$LOBBY_HOST/health did not answer in 3 minutes: see Caddy's log above (are ports 80 and 443 open?)"
