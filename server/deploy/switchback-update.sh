#!/usr/bin/env bash
# Installs the published Switchback API over the running one. Run by systemd as root (switchback-update.service)
# when the review page asks for an update: the API leaves a file called "request" in /srv/switchback/update, which
# switchback-update.path watches for. Installed by setup-pi.sh as /usr/local/sbin/switchback-update.
#
# Nothing in the request is read: what gets installed is always the server-latest release of the repository in
# /etc/switchback/update.conf, and only if it matches its published checksum. If the new program doesn't answer
# after the restart, the previous one is put back. How it went is written to /var/lib/switchback-update/status.json
# (the review page shows it). Only the API program changes: settings, data and the rest of the Pi's setup are left
# alone (for those, run the install command again).
set -euo pipefail

# (the four paths can be pointed elsewhere to try this script out; systemd runs it with none of them set)
REQUESTS=${SWITCHBACK_UPDATE_REQUESTS:-/srv/switchback/update}
STATE=${SWITCHBACK_UPDATE_STATE:-/var/lib/switchback-update}
BIN=${SWITCHBACK_UPDATE_BIN:-/usr/local/bin/switchback-api}
CONF=${SWITCHBACK_UPDATE_CONF:-/etc/switchback/update.conf}
REPO="CadeWardC/switchback"
# shellcheck disable=SC1090
[[ -r $CONF ]] && . "$CONF"
URL="https://github.com/$REPO/releases/download/server-latest/switchback-api-linux-arm64"

# messages are fixed text or stripped to plain characters, so the file is always valid JSON
status() {
  local msg
  msg=$(printf '%s' "$2" | tr -cd 'A-Za-z0-9 .,:_@()-')
  printf '{"state":"%s","message":"%s","at":"%s"}\n' "$1" "$msg" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" > "$STATE/status.json.new"
  chmod 0644 "$STATE/status.json.new"
  mv "$STATE/status.json.new" "$STATE/status.json"
}
fail() { status failed "$1"; echo "switchback-update: $1" >&2; exit 1; }
healthy() {
  for _ in $(seq 1 60); do
    curl -fs -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

install -d -m 0755 "$STATE"
# the request is taken off first, so one request is one run (rm never follows a link)
rm -f "$REQUESTS/request"
exec 9> "$STATE/lock"
flock -n 9 || exit 0

status running "Downloading the published version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -m 300 "$URL" -o "$tmp/api" || fail "The download failed. Nothing was changed."
curl -fsSL --retry 3 -m 60 "$URL.sha256" -o "$tmp/sum" || fail "The checksum could not be downloaded. Nothing was changed."
want=$(cut -d' ' -f1 "$tmp/sum")
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || fail "The published checksum is not a SHA-256. Nothing was changed."
echo "$want  $tmp/api" | sha256sum -c --quiet || fail "The download does not match its checksum. Nothing was changed."

if [[ -f $BIN && "$(sha256sum "$BIN" | cut -d' ' -f1)" == "$want" ]]; then
  status ok "Already up to date"
  exit 0
fi

install -m 0755 "$tmp/api" "$BIN.new"
new=$("$BIN.new" --version 2>/dev/null) || { rm -f "$BIN.new"; fail "The published version does not run on this machine. Nothing was changed."; }
[[ -f $BIN ]] && cp -p "$BIN" "$BIN.previous"
mv "$BIN.new" "$BIN"

status running "Restarting with version $new"
systemctl restart switchback-api || true
if healthy; then
  status ok "Updated to version $new"
  exit 0
fi

if [[ -f $BIN.previous ]]; then
  mv "$BIN.previous" "$BIN"
  systemctl restart switchback-api || true
  if healthy; then
    fail "Version $new did not start, so the previous version was put back and is running."
  fi
fi
fail "Version $new did not start, and the server is not answering. On the Pi: journalctl -u switchback-api -n 50"
