#!/usr/bin/env bash
# One command to put (or update) the Switchback server on the Orange Pi:
#
#   curl -fsSL https://raw.githubusercontent.com/CadeWardC/switchback/main/server/deploy/install.sh | sudo bash
#
# It fetches this repository to /opt/switchback, stops whatever else is using port 8080 (the old document store),
# runs setup-pi.sh for switchback2.opcw032522.uk (which asks for a review-page PIN the first time), and checks the
# server answers, locally and through the Cloudflare tunnel. Safe to run again: that updates the server.
# Extra options go to setup-pi.sh, e.g.  ... | sudo bash -s -- --pin   (choose a new PIN)
set -euo pipefail

DOMAIN="${SWITCHBACK_DOMAIN:-switchback2.opcw032522.uk}"
REPO="https://github.com/CadeWardC/switchback"
SRC=/opt/switchback

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Run it with sudo:  curl -fsSL $REPO/raw/main/server/deploy/install.sh | sudo bash"

say "Getting the Switchback code"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }
# Always fetch from GitHub by URL: an older checkout's "origin" may point somewhere stale.
if ! { [[ -d $SRC/.git ]] \
       && git -C "$SRC" remote set-url origin "$REPO" 2>/dev/null \
       && git -C "$SRC" fetch -q --depth 1 "$REPO" main \
       && git -C "$SRC" reset -q --hard FETCH_HEAD; }; then
  rm -rf "$SRC"
  git clone -q --depth 1 --branch main "$REPO" "$SRC"
fi
[[ -f $SRC/server/deploy/setup-pi.sh ]] \
  || die "$SRC doesn't have server/deploy/setup-pi.sh. Remove it (sudo rm -rf $SRC) and run this again."
echo "    $SRC at $(git -C "$SRC" log -1 --format='%h %s' | cut -c1-70)"

say "Freeing port 8080"
pid=$(ss -ltnpH 'sport = :8080' 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
if [[ -z "$pid" ]]; then
  echo "    Nothing is using it."
else
  unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  name=$(ps -o comm= -p "$pid" 2>/dev/null || true)
  if [[ "$unit" == "switchback-api.service" ]]; then
    echo "    It's the Switchback server already (it will be updated)."
  elif [[ "$name" == docker-proxy* ]] && command -v docker >/dev/null; then
    for c in $(docker ps -q --filter publish=8080); do
      echo "    Stopping Docker container $(docker inspect -f '{{.Name}}' "$c") (the old store) and keeping it from restarting"
      docker update --restart=no "$c" >/dev/null; docker stop "$c" >/dev/null
    done
  elif [[ "$unit" == *.service ]]; then
    echo "    Stopping $unit ($name, the old store) and keeping it from starting again"
    systemctl disable --now "$unit" >/dev/null 2>&1 || systemctl stop "$unit"
  else
    die "Port 8080 is used by $name (pid $pid), which isn't a service this can stop. Stop it yourself, then run this again."
  fi
  sleep 2
fi

say "Setting up the server (this takes a few minutes the first time)"
bash "$SRC/server/deploy/setup-pi.sh" --domain "$DOMAIN" "$@"

say "Checking"
local_ok=$(curl -fs http://127.0.0.1:8080/healthz 2>/dev/null || true)
public_ok=$(curl -fs -m 15 "https://$DOMAIN/healthz" 2>/dev/null || true)
echo "    On the Pi:       ${local_ok:-not answering}"
echo "    On the internet: ${public_ok:-not answering}"
if [[ "$local_ok" == ok && "$public_ok" == ok ]]; then
  say "All set. Accounts work in the app now. Review page: https://$DOMAIN/review (your PIN)"
elif [[ "$local_ok" == ok ]]; then
  warn "The server runs, but https://$DOMAIN doesn't reach it yet. In Cloudflare: Zero Trust › Networks › Tunnels ›"
  warn "your tunnel › Public hostnames › $DOMAIN: set the service to http://localhost:8080, save, and open"
  warn "https://$DOMAIN/healthz (it should say ok)."
else
  die "The server isn't answering. See: journalctl -u switchback-api -n 50"
fi
