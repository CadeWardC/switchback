#!/usr/bin/env bash
# Sets up an Orange Pi 3B running Armbian (Debian 12, arm64) as Switchback's server: Postgres 17, the API, the
# Cloudflare tunnel, backups to R2, a nightly maintenance job, a firewall, automatic security updates and low-power
# settings. Works from an SD card, eMMC or NVMe SSD, and is safe to run again (to update the API or settings).
#
#   sudo ./setup-pi.sh --domain api.example.com [--tunnel-token TOKEN] [--binary ./switchback-api]
#
# Options:
#   --domain NAME          the public address of the API (required)
#   --tunnel-token TOKEN   a Cloudflare tunnel token (Zero Trust › Networks › Tunnels › Create › Debian › copy the token)
#   --binary PATH          install this switchback-api program instead of downloading the latest release
#   --repo OWNER/NAME      GitHub repository to download releases from (default CadeWardC/switchback)
#   --keep-radios          leave Wi-Fi and Bluetooth on (they're turned off when the Pi is on Ethernet)
#
# Backups: fill in github-backup.env.example (database, nightly, to a private GitHub repo) and/or backup.env.example
# (database continuously and photos, to Cloudflare R2), save it in /etc/switchback/ without .example, run this again.
set -euo pipefail

DOMAIN=""
TUNNEL_TOKEN=""
BINARY=""
REPO="CadeWardC/switchback"
KEEP_RADIOS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
    --binary) BINARY="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --keep-radios) KEEP_RADIOS=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

PG=17
ETC=/etc/switchback
DATA=/srv/switchback
PHOTOS=$DATA/photos

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
[[ -n "$DOMAIN" ]] || die "Give the API's address: --domain api.example.com"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain should be a host name like api.example.com"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${VERSION_CODENAME:-}" == "bookworm" ]] || warn "Made for Debian 12 (bookworm); this is ${PRETTY_NAME:-unknown}. Carrying on."
[[ "$(uname -m)" == "aarch64" ]] || warn "Made for arm64; this is $(uname -m)."
if [[ -n "$BINARY" ]]; then
  [[ -f "$BINARY" ]] || die "No such file: $BINARY"
  BINARY=$(realpath "$BINARY")
fi

export DEBIAN_FRONTEND=noninteractive

# MARK: what are we running on?

ROOT_DEV=$(findmnt -no SOURCE /)
ROOT_DISK=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null | head -1 || true)
STORAGE=other
case "$ROOT_DISK" in
  nvme*) STORAGE=nvme ;;
  mmcblk*)
    if [[ "$(cat "/sys/block/$ROOT_DISK/device/type" 2>/dev/null)" == "MMC" ]]; then STORAGE=emmc; else STORAGE=sd; fi ;;
esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
say "Setting up Switchback on $(tr -d '\0' </proc/device-tree/model 2>/dev/null || hostname): ${MEM_MB} MB RAM, system on $STORAGE ($ROOT_DEV)"
if [[ "$STORAGE" == "sd" ]]; then
  note "SD card: logs and temporary files are kept in RAM and writes are kept low to make the card last."
  note "Use a high-endurance A2 card, and set up backups (backup.env). Move to NVMe later with armbian-install."
fi

# MARK: packages

say "Installing packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release postgresql-common chrony ufw unattended-upgrades \
  apt-listchanges rclone jq zstd btop openssl age >/dev/null
if [[ ! -f /etc/apt/sources.list.d/pgdg.sources && ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  note "Adding PostgreSQL's own package repository (for Postgres $PG)"
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
fi
if [[ ! -f /etc/apt/sources.list.d/cloudflared.list ]]; then
  note "Adding Cloudflare's package repository (for cloudflared)"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
fi
apt-get update -qq
apt-get install -y -qq "postgresql-$PG" pgbackrest cloudflared >/dev/null
[[ "$STORAGE" == "nvme" ]] && apt-get install -y -qq nvme-cli smartmontools >/dev/null
note "Postgres $PG, pgBackRest, cloudflared, rclone, chrony, ufw installed"

# MARK: low power

say "Low-power settings"
# CPU: schedutil drops to the lowest speed when idle and jumps to full speed in milliseconds when busy.
if [[ -f /etc/default/cpufrequtils ]]; then
  sed -i 's/^GOVERNOR=.*/GOVERNOR=schedutil/' /etc/default/cpufrequtils
  grep -q '^GOVERNOR=' /etc/default/cpufrequtils || echo 'GOVERNOR=schedutil' >> /etc/default/cpufrequtils
fi
for g in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do
  [[ -w "$g" ]] && echo schedutil > "$g" 2>/dev/null || true
done
note "CPU governor: schedutil"

# Radios: off when the Pi reaches the internet over Ethernet (never cut the connection we're on).
ROUTE_DEV=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p')
if [[ $KEEP_RADIOS -eq 0 && -n "$ROUTE_DEV" && ! -d "/sys/class/net/$ROUTE_DEV/wireless" ]]; then
  if command -v rfkill >/dev/null; then
    rfkill block wifi || true
    rfkill block bluetooth || true
  fi
  for svc in bluetooth wpa_supplicant; do
    systemctl disable --now "$svc" >/dev/null 2>&1 || true
  done
  note "Wi-Fi and Bluetooth off (internet is on $ROUTE_DEV). Use --keep-radios to leave them on."
else
  note "Wi-Fi and Bluetooth left on (internet is on ${ROUTE_DEV:-unknown}). Ethernet uses less power and is steadier."
fi
for svc in ModemManager avahi-daemon cups cups-browsed; do
  systemctl disable --now "$svc" >/dev/null 2>&1 || true
done
note "Unneeded background services off"

# MARK: storage and memory

say "Storage and memory"
# noatime: reading a file doesn't write to the disk
if ! findmnt -no OPTIONS / | grep -q noatime; then
  cp /etc/fstab /etc/fstab.before-switchback
  awk '$2 == "/" && $4 !~ /noatime/ { $4 = $4 ",noatime" } { print }' /etc/fstab.before-switchback > /etc/fstab
  mount -o remount,noatime / || true
  note "Root filesystem: noatime (old fstab saved as /etc/fstab.before-switchback)"
fi
# /tmp in RAM
if [[ "$(findmnt -no FSTYPE /tmp 2>/dev/null)" != "tmpfs" ]]; then
  grep -q '^tmpfs /tmp ' /etc/fstab || echo 'tmpfs /tmp tmpfs defaults,nosuid,nodev,size=256M 0 0' >> /etc/fstab
  note "/tmp moves to RAM at the next restart"
fi
# Logs: in RAM on SD cards and eMMC (Armbian's ramlog also keeps /var/log in RAM), small on disk otherwise
install -d /etc/systemd/journald.conf.d
if [[ "$STORAGE" == "sd" || "$STORAGE" == "emmc" ]]; then
  printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=40M\n' > /etc/systemd/journald.conf.d/switchback.conf
  note "System log: in RAM (40 MB)"
else
  printf '[Journal]\nStorage=persistent\nSystemMaxUse=50M\n' > /etc/systemd/journald.conf.d/switchback.conf
  note "System log: on disk, at most 50 MB"
fi
systemctl restart systemd-journald
# Compressed swap in RAM (Armbian usually has this already)
if ! swapon --show=NAME --noheadings | grep -q zram; then
  apt-get install -y -qq zram-tools >/dev/null
  printf 'ALGO=zstd\nPERCENT=50\nPRIORITY=100\n' > /etc/default/zramswap
  systemctl enable --now zramswap >/dev/null 2>&1 || true
  note "zram swap: on"
else
  note "zram swap: already on"
fi
# Network and memory tuning
{
  echo "vm.swappiness = 100"                # zram swap is cheap; keep file cache in RAM
  echo "vm.dirty_writeback_centisecs = 1500"
  echo "net.core.somaxconn = 1024"
  echo "net.core.default_qdisc = fq"
  if modprobe tcp_bbr 2>/dev/null; then echo "net.ipv4.tcp_congestion_control = bbr"; fi
} > /etc/sysctl.d/90-switchback.conf
sysctl -q --system >/dev/null || true
note "TCP: fq$(grep -q bbr /etc/sysctl.d/90-switchback.conf && echo ' + BBR')"

# MARK: account, folders, settings

say "Switchback account and folders"
id switchback >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin switchback
install -d -o switchback -g switchback -m 0750 "$DATA" "$PHOTOS"
install -d -o root -g switchback -m 0750 "$ETC"
if [[ ! -f $ETC/api.env ]]; then
  cat > $ETC/api.env <<EOF
# Switchback API settings. Restart after changing: sudo systemctl restart switchback-api
DATABASE_URL=postgres:///switchback?host=/run/postgresql
LISTEN=127.0.0.1:8080
PUBLIC_URL=https://$DOMAIN
TOKEN_SECRET=$(openssl rand -hex 32)
# Email addresses are never stored, only a hash made with this key. NEVER change it: email sign-ins would stop
# matching their accounts. It's in the GitHub/R2 backups' restore instructions too.
EMAIL_HASH_KEY=$(openssl rand -hex 32)
# The review page (web/review.html) signs in with this to approve submissions and take photos down. Keep it secret.
ADMIN_TOKEN=$(openssl rand -hex 32)
PHOTO_DIR=$PHOTOS
TRUST_CLOUDFLARE=1
DB_MAX_CONNS=10
# Google sign-in: the iOS OAuth client id(s) from Google Cloud Console, comma-separated
GOOGLE_CLIENT_IDS=
# Email sign-in codes: a resend.com API key and a sender on your domain (until set, codes go to the log)
RESEND_API_KEY=
MAIL_FROM=Switchback <signin@${DOMAIN#*.}>
EOF
  note "Created $ETC/api.env (with a new secret). Add Google and email settings there later."
else
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" $ETC/api.env
  grep -q '^EMAIL_HASH_KEY=.' $ETC/api.env || echo "EMAIL_HASH_KEY=$(openssl rand -hex 32)" >> $ETC/api.env
  if ! grep -q '^ADMIN_TOKEN=.' $ETC/api.env; then
    sed -i '/^ADMIN_TOKEN=$/d' $ETC/api.env
    echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> $ETC/api.env
    note "Added ADMIN_TOKEN to $ETC/api.env (for the review page)"
  fi
  note "Kept $ETC/api.env"
fi
chown root:switchback $ETC/api.env
chmod 0640 $ETC/api.env

# MARK: postgres

say "PostgreSQL $PG"
PG_CONF=/etc/postgresql/$PG/main
[[ -d $PG_CONF ]] || pg_createcluster "$PG" main --start >/dev/null
SHARED=$(( MEM_MB / 5 ))      # ~20% of RAM: 768 MB on a 4 GB Pi
CACHE=$(( MEM_MB / 2 ))
BACKUPS=0
[[ -f $ETC/backup.env ]] && BACKUPS=1
install -d "$PG_CONF/conf.d"
cat > "$PG_CONF/conf.d/switchback.conf" <<EOF
# Written by setup-pi.sh: tuned for a ${MEM_MB} MB Orange Pi, system on $STORAGE.
listen_addresses = 'localhost'
max_connections = 40
shared_buffers = ${SHARED}MB
effective_cache_size = ${CACHE}MB
work_mem = 8MB
maintenance_work_mem = 128MB
random_page_cost = 1.1
effective_io_concurrency = $([[ $STORAGE == nvme ]] && echo 200 || echo 2)
# fewer, larger writes when quiet; crash safety unchanged (every commit is still flushed)
synchronous_commit = on
checkpoint_timeout = 15min
max_wal_size = 1GB
wal_compression = on
wal_writer_delay = 1s
bgwriter_delay = 1s
autovacuum_naptime = 5min
# quiet logs
log_min_duration_statement = 500ms
log_checkpoints = off
EOF
if [[ $BACKUPS -eq 1 ]]; then
  cat >> "$PG_CONF/conf.d/switchback.conf" <<'EOF'
# continuous backup of every change to R2
archive_mode = on
archive_command = 'pgbackrest --stanza=switchback archive-push %p'
archive_timeout = 15min
EOF
fi
systemctl enable postgresql >/dev/null
systemctl restart "postgresql@$PG-main"
runuser -u postgres -- psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = 'switchback'" | grep -q 1 \
  || runuser -u postgres -- createuser switchback
runuser -u postgres -- psql -qtAc "SELECT 1 FROM pg_database WHERE datname = 'switchback'" | grep -q 1 \
  || runuser -u postgres -- createdb -O switchback switchback
note "Database 'switchback' ready (shared_buffers ${SHARED} MB)"

# MARK: backups

if [[ $BACKUPS -eq 1 ]]; then
  say "Backups to Cloudflare R2"
  # shellcheck disable=SC1091
  . $ETC/backup.env
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    [[ -n "${!v:-}" ]] || die "$v is empty in $ETC/backup.env"
  done
  install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
  cat > /etc/pgbackrest.conf <<EOF
[global]
repo1-type=s3
repo1-s3-endpoint=${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
repo1-s3-region=auto
repo1-s3-uri-style=path
repo1-s3-bucket=${R2_BUCKET}
repo1-s3-key=${R2_ACCESS_KEY_ID}
repo1-s3-key-secret=${R2_SECRET_ACCESS_KEY}
repo1-path=/pgbackrest
repo1-retention-full=2
compress-type=zst
process-max=2
start-fast=y
log-level-console=warn
log-level-file=warn

[switchback]
pg1-path=/var/lib/postgresql/$PG/main
EOF
  chown postgres:postgres /etc/pgbackrest.conf
  chmod 0600 /etc/pgbackrest.conf
  runuser -u postgres -- pgbackrest --stanza=switchback stanza-create >/dev/null
  if ! runuser -u postgres -- pgbackrest --stanza=switchback info --output=json | jq -e '.[0].backup | length > 0' >/dev/null; then
    note "Taking the first full backup (a minute or two)"
    runuser -u postgres -- pgbackrest --stanza=switchback --type=full backup
  fi
  # rclone for the photos
  cat > $ETC/rclone.conf <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
  chown root:switchback $ETC/rclone.conf
  chmod 0640 $ETC/rclone.conf
  note "Database: every change goes to R2; full backup weekly, changes-only nightly"
  note "Photos: copied to R2 nightly"
fi

# MARK: database backups to GitHub

install -m 0700 "$(dirname "$0")/github-backup.sh" /usr/local/sbin/switchback-github-backup
GH_BACKUPS=0
if [[ -f $ETC/github-backup.env ]]; then
  say "Database backups to GitHub"
  chown root:root $ETC/github-backup.env
  chmod 0600 $ETC/github-backup.env
  /usr/local/sbin/switchback-github-backup check || die "Fix $ETC/github-backup.env and run this again."
  note "Taking a backup now to make sure it works"
  /usr/local/sbin/switchback-github-backup | sed 's/^/    /'
  GH_BACKUPS=1
  note "Every night: encrypted on the Pi, then uploaded; the last 14 days are kept"
fi
if [[ $BACKUPS -eq 0 && $GH_BACKUPS -eq 0 ]]; then
  say "Backups: not set up yet"
  note "Fill in github-backup.env.example (free, nightly) or backup.env.example (R2), save it in $ETC/"
  note "without .example, and run this script again."
fi

# MARK: the API

say "Switchback API"
if [[ -n "$BINARY" ]]; then
  install -m 0755 "$BINARY" /usr/local/bin/switchback-api.new
else
  URL="https://github.com/$REPO/releases/download/server-latest/switchback-api-linux-arm64"
  note "Downloading $URL"
  curl -fsSL "$URL" -o /usr/local/bin/switchback-api.new || die "Download failed. Build it (see server/README.md) and use --binary."
  if curl -fsSL "$URL.sha256" -o /tmp/switchback-api.sha256 2>/dev/null; then
    echo "$(cut -d' ' -f1 /tmp/switchback-api.sha256)  /usr/local/bin/switchback-api.new" | sha256sum -c --quiet \
      || die "Downloaded file doesn't match its checksum."
  fi
  chmod 0755 /usr/local/bin/switchback-api.new
fi
mv /usr/local/bin/switchback-api.new /usr/local/bin/switchback-api

cat > /etc/systemd/system/switchback-api.service <<EOF
[Unit]
Description=Switchback API
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
User=switchback
Group=switchback
EnvironmentFile=$ETC/api.env
Environment=GOMEMLIMIT=256MiB
ExecStart=/usr/local/bin/switchback-api
Restart=always
RestartSec=2
# keep it in its lane
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=$PHOTOS
MemoryMax=600M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable switchback-api >/dev/null
systemctl restart switchback-api
for _ in $(seq 1 20); do
  curl -fs http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -fs http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  note "Running on 127.0.0.1:8080 (only cloudflared can reach it)"
else
  warn "The API didn't start. See: journalctl -u switchback-api -n 50"
fi

# MARK: cloudflare tunnel

say "Cloudflare tunnel"
if [[ -n "$TUNNEL_TOKEN" ]]; then
  if systemctl is-enabled cloudflared >/dev/null 2>&1; then
    cloudflared service uninstall >/dev/null 2>&1 || true
  fi
  cloudflared service install "$TUNNEL_TOKEN" >/dev/null 2>&1
  note "Tunnel connected. In Cloudflare, give it the public hostname $DOMAIN → http://localhost:8080"
elif systemctl is-active cloudflared >/dev/null 2>&1; then
  note "Already running"
else
  note "Not connected yet. In the Cloudflare dashboard: Zero Trust › Networks › Tunnels › Create a tunnel"
  note "(Cloudflared, Debian, 64-bit ARM), copy the token, then run this script again with --tunnel-token TOKEN."
  note "Then add the public hostname $DOMAIN → http://localhost:8080 to the tunnel."
fi

# MARK: nightly maintenance

say "Nightly maintenance"
cat > /usr/local/sbin/switchback-nightly <<'EOF'
#!/usr/bin/env bash
# Switchback's nightly jobs, run one after another so the Pi wakes once.
set -uo pipefail
ETC=/etc/switchback
STATUS=0
log() { echo "switchback-nightly: $*"; }
HEALTHCHECK_URL=""
# shellcheck disable=SC1091
[[ -f $ETC/backup.env ]] && . $ETC/backup.env
if [[ -z "$HEALTHCHECK_URL" && -f $ETC/github-backup.env ]]; then
  HEALTHCHECK_URL=$(sed -n 's/^HEALTHCHECK_URL=//p' $ETC/github-backup.env | tail -1)
fi

# tidy the database: expired sessions and codes, photos never finished uploading
runuser -u postgres -- psql -q -d switchback -c "
  DELETE FROM sessions WHERE expires_at < now();
  DELETE FROM email_codes WHERE expires_at < now();
  DELETE FROM photos WHERE status = 'uploading' AND created_at < now() - interval '3 days';" || STATUS=1

# database backup: full on Sundays, changes-only otherwise
if [[ -f /etc/pgbackrest.conf ]]; then
  TYPE="diff"; [[ $(date +%u) -eq 7 ]] && TYPE="full"
  runuser -u postgres -- pgbackrest --stanza=switchback --type=$TYPE backup || { log "database backup failed"; STATUS=1; }
fi

# encrypted database backup to the private GitHub repo
if [[ -f $ETC/github-backup.env ]]; then
  /usr/local/sbin/switchback-github-backup || { log "GitHub backup failed"; STATUS=1; }
fi

# photos to R2 (new files only; photos are never changed in place)
if [[ -f $ETC/rclone.conf && -n "${R2_BUCKET:-}" ]]; then
  runuser -u switchback -- rclone --config $ETC/rclone.conf copy /srv/switchback/photos "r2:$R2_BUCKET/photos" \
    --immutable --transfers 2 --checkers 4 --fast-list || { log "photo backup failed"; STATUS=1; }
fi

# disk health
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
if [[ $ROOT_DISK == nvme* ]] && command -v smartctl >/dev/null; then
  smartctl -H "/dev/$ROOT_DISK" | grep -q PASSED || { log "SSD health check failed"; STATUS=1; }
  WEAR=$(smartctl -A "/dev/$ROOT_DISK" | awk '/Percentage Used/ {gsub("%","",$3); print $3}')
  [[ -n "$WEAR" && "$WEAR" -ge 80 ]] && { log "SSD is ${WEAR}% worn"; STATUS=1; }
elif [[ $ROOT_DISK == mmcblk* ]]; then
  if journalctl -k --since "-1 day" | grep -Eiq "mmc[0-9].*(error|timeout)|EXT4-fs error|I/O error"; then
    log "the SD card or eMMC reported errors in the last day: replace it soon"; STATUS=1
  fi
fi
USE=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[[ $USE -ge 85 ]] && { log "disk ${USE}% full"; STATUS=1; }

# tell healthchecks.io how it went (it emails you if this stops arriving or reports a failure)
if [[ -n "$HEALTHCHECK_URL" ]]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL$([[ $STATUS -ne 0 ]] && echo /fail)" >/dev/null || true
fi
exit $STATUS
EOF
chmod 0755 /usr/local/sbin/switchback-nightly
cat > /etc/systemd/system/switchback-nightly.service <<'EOF'
[Unit]
Description=Switchback nightly maintenance and backups
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/switchback-nightly
Nice=10
IOSchedulingClass=idle
EOF
cat > /etc/systemd/system/switchback-nightly.timer <<'EOF'
[Unit]
Description=Run Switchback's nightly maintenance

[Timer]
OnCalendar=*-*-* 03:30
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now switchback-nightly.timer >/dev/null
note "Tidy-up, backups and a disk check every night around 03:30"

# MARK: security

say "Firewall, SSH and updates"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  ufw allow from "$net" to any port 22 proto tcp >/dev/null
done
ufw --force enable >/dev/null
note "Firewall on: nothing comes in from the internet; SSH only from your home network"

if find /root/.ssh /home/*/.ssh -name authorized_keys -size +0 2>/dev/null | grep -q .; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' \
    > /etc/ssh/sshd_config.d/10-switchback.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  note "SSH: keys only"
else
  warn "No SSH keys found, so SSH passwords stay on. Add a key (ssh-copy-id) and run this again to turn them off."
fi

cat > /etc/apt/apt.conf.d/52switchback-upgrades <<'EOF'
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename},label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  "origin=apt.postgresql.org";
  "origin=cloudflared";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl disable --now systemd-timesyncd >/dev/null 2>&1 || true
systemctl enable --now chrony >/dev/null 2>&1 || true
note "Security updates install by themselves (restarting at 04:30 if needed); clock kept exact by chrony"

# MARK: done

say "Done"
cat <<EOF
    API:        http://127.0.0.1:8080/healthz → $(curl -fs http://127.0.0.1:8080/healthz 2>/dev/null || echo "not answering")
    Public:     https://$DOMAIN (once the tunnel has its public hostname)
    Settings:   $ETC/api.env   (then: sudo systemctl restart switchback-api)
    Admin key:  sudo grep ADMIN_TOKEN $ETC/api.env   (for the review page; keep it secret)
    Logs:       journalctl -u switchback-api -f
    Backups:    $(B=(); [[ $BACKUPS -eq 1 ]] && B+=("R2, continuous"); [[ $GH_BACKUPS -eq 1 ]] && B+=("GitHub, nightly"); [[ ${#B[@]} -gt 0 ]] && (IFS=';'; echo "${B[*]}" | sed 's/;/ + /') || echo "off: see github-backup.env.example")
    Storage:    $STORAGE ($(df -h --output=avail / | tail -1 | tr -d ' ') free)
    Update the API later by running this script again.
EOF
