#!/usr/bin/env bash
# Backs up Switchback's database and settings to a private GitHub repo: dumped, encrypted with age on the Pi (only the key on
# your computer can open it), and uploaded as a file on the repo's "db-backups" release. Files older than KEEP_DAYS
# are deleted, so a deleted account is gone from the backups after that many days. Installed by setup-pi.sh as
# /usr/local/sbin/switchback-github-backup and run nightly.
#
#   switchback-github-backup          back up now
#   switchback-github-backup check    check the token reaches the repo and the repo is private
set -euo pipefail
# shellcheck disable=SC1090,SC1091
. "${GITHUB_BACKUP_ENV:-/etc/switchback/github-backup.env}"
: "${GITHUB_REPO:?GITHUB_REPO is empty}" "${GITHUB_TOKEN:?GITHUB_TOKEN is empty}" "${AGE_RECIPIENT:?AGE_RECIPIENT is empty}"
KEEP_DAYS=${KEEP_DAYS:-14}
API=${GITHUB_API:-https://api.github.com}/repos/$GITHUB_REPO
UPLOADS=${GITHUB_UPLOADS:-https://uploads.github.com}/repos/$GITHUB_REPO
TAG=db-backups

# a GitHub API call; the token goes in through stdin so it never shows in the process list
gh() {
  local method=$1 url=$2
  shift 2
  curl -fsS -X "$method" "$url" "$@" -K - <<CONF
header = "Authorization: Bearer $GITHUB_TOKEN"
header = "Accept: application/vnd.github+json"
header = "X-GitHub-Api-Version: 2022-11-28"
CONF
}

if [[ "${1:-}" == "check" ]]; then
  [[ "$AGE_RECIPIENT" == age1* ]] || { echo "AGE_RECIPIENT should start with age1 (the public key from age-keygen)"; exit 1; }
  INFO=$(gh GET "$API") || { echo "The token can't reach $GITHUB_REPO. Check the name and the token's repository access."; exit 1; }
  [[ $(jq -r .private <<<"$INFO") == "true" ]] || { echo "$GITHUB_REPO is public. Backups need a private repo."; exit 1; }
  [[ $(jq -r .size <<<"$INFO") != "0" ]] || { echo "$GITHUB_REPO is empty. Add a README on GitHub first."; exit 1; }
  echo "ok: $GITHUB_REPO is private and reachable"
  exit 0
fi

REL=$(gh GET "$API/releases/tags/$TAG" 2>/dev/null | jq -r .id) || REL=""
if [[ -z "$REL" || "$REL" == "null" ]]; then
  REL=$(gh POST "$API/releases" -H "Content-Type: application/json" -d '{"tag_name": "db-backups",
    "name": "Database backups", "prerelease": true,
    "body": "Encrypted nightly backups of the Switchback database (age). Restore with server/deploy/restore-db.sh."}' |
    jq -r .id)
fi

# the database plus the server's settings: without EMAIL_HASH_KEY, email sign-ins can't find their accounts again
NAME="switchback-$(date -u +%Y%m%d-%H%M).tar.age"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
chown postgres "$TMP"   # pg_dump writes here as postgres
runuser -u postgres -- pg_dump -Fc -Z 6 --no-owner -f "$TMP/switchback.dump" switchback
cp "${SWITCHBACK_API_ENV:-/etc/switchback/api.env}" "$TMP/api.env"
tar -C "$TMP" -cf - switchback.dump api.env | age -r "$AGE_RECIPIENT" > "$TMP/$NAME"
rm -f "$TMP/switchback.dump" "$TMP/api.env"
gh POST "$UPLOADS/releases/$REL/assets?name=$NAME" \
  -H "Content-Type: application/octet-stream" --data-binary "@$TMP/$NAME" >/dev/null
echo "uploaded $NAME ($(du -h "$TMP/$NAME" | cut -f1))"

# delete backups older than KEEP_DAYS (only after today's upload worked)
CUTOFF=$(date -u -d "-$KEEP_DAYS days" +%s)
gh GET "$API/releases/$REL/assets?per_page=100" | jq -r '.[] | "\(.id) \(.created_at) \(.name)"' |
  while read -r ID CREATED OLD; do
    if [[ $(date -u -d "$CREATED" +%s) -lt $CUTOFF ]]; then
      gh DELETE "$API/releases/assets/$ID" >/dev/null && echo "deleted old backup $OLD"
    fi
  done
