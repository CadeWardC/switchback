#!/usr/bin/env bash
# Restores Switchback's database from an encrypted backup. Replaces everything in the database.
#
#   sudo ./restore-db.sh latest ~/switchback-backup-key.txt          newest backup from the GitHub backup repo
#   sudo ./restore-db.sh switchback-20261116-0330.tar.age KEYFILE    a backup file you downloaded
#
# Also puts back EMAIL_HASH_KEY from the backup's settings, so email sign-ins find their accounts on a new Pi.
#
# Copy your key to the Pi just for this (scp), and delete it afterwards: it can open every backup.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $# -eq 2 ]] || { sed -n '2,8p' "$0"; exit 1; }
SOURCE=$1
KEY=$2
[[ -f "$KEY" ]] || { echo "No key file: $KEY"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [[ "$SOURCE" == "latest" ]]; then
  # shellcheck disable=SC1090,SC1091
  . "${GITHUB_BACKUP_ENV:-/etc/switchback/github-backup.env}"
  GH_API=${GITHUB_API:-https://api.github.com}
  api() {
    curl -fsSL "$@" -K - <<EOF
header = "Authorization: Bearer $GITHUB_TOKEN"
header = "X-GitHub-Api-Version: 2022-11-28"
EOF
  }
  ASSET=$(api -H "Accept: application/vnd.github+json" \
    "$GH_API/repos/$GITHUB_REPO/releases/tags/db-backups" |
    jq -r '.assets | sort_by(.created_at) | last | "\(.id) \(.name)"')
  [[ "$ASSET" != "null null" && -n "$ASSET" ]] || { echo "No backups found in $GITHUB_REPO."; exit 1; }
  read -r ID NAME <<<"$ASSET"
  echo "Downloading $NAME"
  api -H "Accept: application/octet-stream" "$GH_API/repos/$GITHUB_REPO/releases/assets/$ID" -o "$TMP/$NAME"
  SOURCE="$TMP/$NAME"
fi
[[ -f "$SOURCE" ]] || { echo "No such backup: $SOURCE"; exit 1; }

echo "Decrypting"
age -d -i "$KEY" "$SOURCE" | tar -C "$TMP" -xf -
[[ -f "$TMP/switchback.dump" ]] || { echo "That backup has no database in it."; exit 1; }
chmod 0644 "$TMP/switchback.dump"
chmod 0755 "$TMP"
runuser -u postgres -- pg_restore --list "$TMP/switchback.dump" >/dev/null || { echo "That isn't a readable backup."; exit 1; }

read -r -p "This replaces the whole Switchback database. Type RESTORE to carry on: " ANSWER
[[ "$ANSWER" == "RESTORE" ]] || { echo "Stopped. Nothing changed."; exit 1; }

API_ENV=${SWITCHBACK_API_ENV:-/etc/switchback/api.env}
OLD_KEY=$(sed -n 's/^EMAIL_HASH_KEY=//p' "$TMP/api.env" 2>/dev/null | tail -1)

systemctl stop switchback-api
runuser -u postgres -- dropdb --if-exists switchback
runuser -u postgres -- createdb -O switchback switchback
runuser -u switchback -- pg_restore --no-owner -d switchback "$TMP/switchback.dump"
if [[ -n "$OLD_KEY" && -f "$API_ENV" ]] && ! grep -qx "EMAIL_HASH_KEY=$OLD_KEY" "$API_ENV"; then
  sed -i '/^EMAIL_HASH_KEY=/d' "$API_ENV"
  echo "EMAIL_HASH_KEY=$OLD_KEY" >> "$API_ENV"
  echo "Put back EMAIL_HASH_KEY from the backup, so email sign-ins find their accounts."
fi
systemctl start switchback-api
echo "Restored. Photos aren't in database backups: copy them back to /srv/switchback/photos if they were lost."
