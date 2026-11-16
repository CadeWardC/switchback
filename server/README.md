# Switchback server

Accounts (email + password, email code, Google), each person's synced hikes and saved trails, reviews, hike logs,
photos, trail submissions, reports and the owner's review API, for the Switchback app. One Go program (`switchback-api`, ~10 MB, ~30 MB of RAM) and PostgreSQL. The plan
behind it is in [docs/SERVER_PLAN.md](../docs/SERVER_PLAN.md).

```
cmd/switchback-api/    the program; settings come from environment variables (listed at the top of main.go)
internal/api/          HTTP handlers, caching, rate limits, the integration test
internal/auth/         access tokens, refresh tokens, sign-in codes, Google ID token checks, email
internal/db/           Postgres pool and migrations (migrations/*.sql, applied in order at start)
internal/images/       checks uploaded photos (HEIC/JPEG, size) and takes the metadata out of JPEGs, without decoding them
internal/storage/      photo files, named by content hash (disk now; R2 later behind the same interface)
internal/ratelimit/    in-memory rate limits
deploy/setup-pi.sh     sets up an Orange Pi from a fresh Armbian install
```

## Run it on a laptop

Needs Go 1.24+ and PostgreSQL.

```sh
createdb switchback
cd server
TOKEN_SECRET=$(openssl rand -hex 32) EMAIL_HASH_KEY=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 32) \
  DATABASE_URL=postgres:///switchback go run ./cmd/switchback-api
curl localhost:8080/healthz
```

Without `RESEND_API_KEY`, sign-in codes are written to the log instead of emailed.

## Test

```sh
createdb switchback_test     # wiped by the test
TEST_DATABASE_URL=postgres:///switchback_test go test ./...
```

`TestEverything` drives the whole API over HTTP: sign-in, token refresh, reviews (and who may edit them), cached
lists with ETags, per-cell stats, hike logs, photo uploads (EXIF removed; wrong sizes and non-photos rejected), trail
submissions, reports hiding a review, that no email address is stored anywhere, and deleting an account with its
posts and files. `TestPasswords` covers register and log in (taken emails, weak passwords, one answer for a wrong
email or password, rate limits, changing the password); `TestDocs` and `TestDocsSince` the synced documents
(tombstones, `?since=`, one person never seeing another's, the 2 MB limit, no write missed while lists run);
`TestAdminAndHikePhotos` photos on recorded hikes, CORS and the admin routes (approve, reject, hide a photo).

## What's stored

Only what the features need. **No email addresses**: a keyed hash (HMAC) stands in for them, enough to sign in and
to link an email and a Google sign-in with the same address. (A password account's email was never checked, so
email-code and Google sign-ins aren't linked to it; registering with an email that already has any account is
refused.) The address is used to send the code, then forgotten,
so the server can never email anyone. No ages, birthdays, IP addresses or activity history.

| | |
|---|---|
| Accounts | an id and a display name ("Hiker" until the person picks one) |
| Sign-in | provider (password, email code or Google), Google's account number or the email hash, sessions as hashed tokens |
| Passwords | only a bcrypt hash (cost 11) of each password; the password itself is never stored or logged |
| Synced documents | each person's recorded hikes and saved trails as the phone sends them (up to 2 MB each, 200 MB a person); deleted ones leave a tombstone (id and time only) |
| Reviews | trail, stars, text, date hiked, conditions |
| Photos | the display and thumbnail files (no EXIF), where and when taken (shown rounded to ~10 m), the trail and/or recorded hike they're from |
| Hike logs | trail, date, short note, public or private |
| Trail submissions | new trails and corrections waiting for approval |
| Reports | who reported which post, so a post is hidden after three |
| Trails | the app's trail id, name, start point and box (public map data) |

The `Server` workflow runs this on every change under `server/`, builds the arm64 program and, on the default
branch, publishes it to the `server-latest` release.

## Put it on the Orange Pi

1. **Flash Armbian** (Debian 12 Bookworm, minimal/server, Orange Pi 3B) to the SD card with balenaEtcher or
   Raspberry Pi Imager. Use a **high-endurance A2 card**. Plug in Ethernet and power, then SSH in
   (`ssh root@<the Pi's address>`; Armbian asks you to set a password and make a user).
2. **Add your SSH key** from your computer: `ssh-copy-id <user>@<the Pi's address>` (the script then turns SSH
   passwords off).
3. **Make a Cloudflare tunnel**: Cloudflare dashboard › Zero Trust › Networks › Tunnels › Create a tunnel ›
   Cloudflared › Debian, 64-bit ARM. Copy the token from the install command.
4. **Run the setup script** on the Pi:
   ```sh
   git clone https://github.com/CadeWardC/switchback && cd switchback/server/deploy
   sudo ./setup-pi.sh --domain api.yourdomain.com --tunnel-token <TOKEN>
   ```
   Until the `server-latest` release exists, build the program on any computer with Go and copy it over:
   `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o switchback-api ./cmd/switchback-api`, then add
   `--binary ./switchback-api`.
5. **Give the tunnel its address**: in the tunnel's settings, add the public hostname `api.yourdomain.com` →
   `http://localhost:8080`. Check `https://api.yourdomain.com/healthz` says `ok`.
6. **Backups** (see "Backups" below): fill in `github-backup.env.example`, save it as
   `/etc/switchback/github-backup.env`, and run the script again.
7. **Sign-in settings** in `/etc/switchback/api.env`: `GOOGLE_CLIENT_IDS` (an iOS OAuth client from Google Cloud
   Console) and `RESEND_API_KEY` + `MAIL_FROM` (resend.com, with your domain verified). Then
   `sudo systemctl restart switchback-api`.

To update the API later, run the script again.

### What the script sets up

| | |
|---|---|
| PostgreSQL 17 | tuned for the Pi's RAM and disk; fewer writes when quiet |
| switchback-api | systemd service on 127.0.0.1:8080, sandboxed, memory-capped |
| cloudflared | the tunnel: no ports open at home |
| GitHub backups | nightly: database + settings, encrypted with age, to a private repo; 14 days kept |
| pgBackRest + rclone (optional) | every database change to R2 as it happens; photos nightly |
| Nightly job (03:30) | tidies expired sessions, backs up, checks the SD card or SSD for errors, pings healthchecks.io |
| Low power | schedutil CPU governor, Wi-Fi/Bluetooth off on Ethernet, unneeded services off |
| SD card care | logs and /tmp in RAM, noatime, zram swap |
| Security | ufw (SSH from home only), SSH keys only, automatic security updates, chrony |

## API (v1)

Requests and answers are JSON. Signed-in requests send `Authorization: Bearer <access_token>`. Ids for things the
app creates (reviews, logs, photos, submissions) are UUIDs made on the phone, and creating is a `PUT`, so sending the
same request twice is harmless. Lists take `?cursor=` from the previous page.

| Method and path | What | Cached |
|---|---|---|
| `GET /healthz` | `ok` if the database answers | |
| `GET /v1/config` | photo sizes, allowed conditions, correction kinds, difficulties, licences | 1 h |
| `POST /v1/auth/email/start` `{email}` | emails a 6-digit code (10 minutes) | |
| `POST /v1/auth/email/verify` `{email, code, device}` | → `{access_token, refresh_token, expires_in, user, new_user}` | |
| `POST /v1/auth/google` `{id_token, device}` | same answer; same verified email = same account | |
| `POST /v1/auth/register` `{email, password, display_name?, device?}` | → tokens, `new_user: true`. 422 `bad_email`, 422 `weak_password` (8-200 characters), 409 `email_taken` | |
| `POST /v1/auth/login` `{email, password, device?}` | → tokens, `new_user: false`. 401 `wrong_login` for a wrong email or password alike; 10 tries per email and 30 per IP each 10 minutes | |
| `POST /v1/auth/refresh` `{refresh_token}` | new tokens (the old refresh token stops working) | |
| `POST /v1/auth/logout` `{refresh_token}` | ends that session | |
| `GET` / `PATCH {display_name}` / `DELETE /v1/me` | account; delete removes everything posted | |
| `POST /v1/me/password` `{current_password, new_password}` | 204; signs out your other devices. 401 `wrong_password`, 422 `weak_password`, 409 `no_password` | |
| `GET /v1/me/logs` · `GET /v1/me/submissions` | your hike logs, your submissions with status and reply | |
| `GET /v1/me/photos?walk=<hike id>` | your own photos (any status), oldest first, optionally one recorded hike's | |
| `GET /v1/me/docs/{collection}` | your live documents: `{items: [{id, updated_at, deleted: false, data}], server_time}` | |
| `GET /v1/me/docs/{collection}?since=<server_time>` | what changed since then, deleted ones as `{id, updated_at, deleted: true, data: null}` | |
| `PUT /v1/me/docs/{collection}/{id}` | any JSON up to 2 MB (413 `too_large`), replacing the document → `{id, updated_at, deleted: false}` | |
| `DELETE /v1/me/docs/{collection}/{id}` | leaves a tombstone → `{id, updated_at, deleted: true}` (also if it wasn't there) | |
| `GET /v1/cells/{row}_{col}/stats` | ratings, photo and hiker counts, corrections and community trails in a 0.25° cell | 5 min |
| `GET /v1/trails/reviews?trail=<id>` | stats and reviews, newest first | 1 min |
| `GET /v1/trails/photos?trail=<id>` | photos, oldest first (by when taken), 30 at a time with `cursor` | 1 min |
| `GET /v1/users/{id}/logs` | someone's public hike logs | 1 min |
| `PUT` / `DELETE /v1/reviews/{id}` | `{trail, rating, body, hiked_on, conditions}`; one per person per trail | |
| `PUT` / `DELETE /v1/logs/{id}` | `{trail, hiked_on, hike_id, note, public}` | |
| `PUT /v1/photos/{id}` | `{trail, review_id, log_id, walk_id, lat, lon, taken_at}`, all optional | |
| `PUT /v1/photos/{id}/file?size=display\|thumb` | the raw HEIC or JPEG bytes as the body (any Content-Type); a JPEG's metadata (EXIF, XMP, IPTC) is removed before it is stored, a HEIC with EXIF is refused; display ≤ 1 MB and ≤ 1,100 px on the short side, thumb ≤ 200 KB and ≤ 440 px; ready when both are in | |
| `DELETE /v1/photos/{id}` | | |
| `PUT /v1/submissions/{id}` | `{kind: "new_trail", name, line, difficulty, note}` or `{kind: "correction", trail, field, value, note, line?}` (the walked line is optional) | |
| `POST /v1/reports` `{target_kind, target_id, reason}` | three reports hide a review or photo | |
| `GET /p/{key}` | a photo file | forever |
| `GET /v1/admin/submissions?status=pending\|approved\|rejected\|all` | every submission with who sent it (`user_display_name`), its line and box | |
| `POST /v1/admin/submissions/{id}` `{status: "approved"\|"rejected", reply?}` | approving adds a new trail to `community_trails` or a correction to `trail_overrides`; rejecting takes it off again | |
| `GET /review` · `POST /v1/admin/login` `{pin}` → `{token}` | the review page, and unlocking it with `ADMIN_PIN` (a session key for 12 hours; 5 tries per 15 minutes per address, 20 an hour in all) | |
| `GET /v1/admin/photos?status=ready\|hidden\|uploading\|all` · `POST /v1/admin/photos/{id}` `{status: "ready"\|"hidden"}` | photos, and taking one down (or back up) | |
| `GET /v1/admin/reviews?status=shown\|hidden\|all` · `POST /v1/admin/reviews/{id}` `{hidden: true\|false}` | trail reviews, and hiding one (or showing it again) | |

`trail` is `{id, name, start: [lat, lon], bbox: [south, west, north, east]}`, the app's trail id plus enough to
find the trail again if OpenStreetMap edits change the id. `line` is an encoded polyline (5 decimals), as the app
stores trails.

Errors are `{"error": {"code": "...", "message": "..."}}` with a message that can be shown to the person.

Tokens are `{access_token, token_type: "Bearer", expires_in, refresh_token, user: {id, display_name}, new_user}`.

Document collections and ids, and `walk_id`, are 1-128 of `A-Z a-z 0-9 _ - .` (else 400 `bad_name`). `updated_at`
and `server_time` are milliseconds that only ever go up across the whole server; pass a list's `server_time` as the
next `?since=` and no write is missed. Up to 2,000 document writes an hour per person.

**Admin routes** need `Authorization: Bearer <ADMIN_TOKEN>` (from `/etc/switchback/api.env`; 401 otherwise) and
answer 404 when `ADMIN_TOKEN` isn't set. Every route sends CORS headers (`Access-Control-Allow-Origin: *`) and
answers `OPTIONS` preflights, so the review page works opened from a file or any site. Nothing uses cookies.

## Backups

**GitHub (free, nightly).** Each night the Pi dumps the database, packs it with the server's settings
(`api.env`, which holds `EMAIL_HASH_KEY`), encrypts it with [age](https://age-encryption.org) to your public key,
and uploads it to the `db-backups` release of a private repo. Backups older than 14 days are deleted, so a deleted
account is gone from them within two weeks. Only the key file on your computer can open them.

1. On your computer, install age (`brew install age` on a Mac, `winget install FiloSottile.age` on Windows) and make
   a key: `age-keygen -o switchback-backup-key.txt`. It prints the public key (`age1…`). **Keep the key file safe**
   (a password manager and a USB stick): without it the backups can't be opened.
2. On GitHub, create a **private** repo, e.g. `switchback-backups`, with a README.
3. github.com › Settings › Developer settings › **Fine-grained tokens** › Generate: repository access *Only select
   repositories* › the backup repo; permissions › Repository › **Contents: Read and write**. Copy the token.
4. On the Pi: `sudo cp github-backup.env.example /etc/switchback/github-backup.env`, fill in the repo, token and
   `age1…` key, then run `setup-pi.sh` again. It checks the repo is private and takes the first backup.

**Restore** (to the same Pi or a new one set up with `setup-pi.sh`): copy your key to the Pi, then
`sudo ./restore-db.sh latest ~/switchback-backup-key.txt`, and delete the key from the Pi afterwards. It also puts
back `EMAIL_HASH_KEY`, so email sign-ins find their accounts.

Photos aren't in these backups (they'd outgrow a repo). Copy `/srv/switchback/photos` to a USB drive now and then,
or set up R2 (`backup.env.example`) when you add a card to Cloudflare.

## Not built yet

- Admin: checking reports and banning (the admin API already approves submissions and hides photos).
- Matching posts to a trail's new id after OpenStreetMap edits (the data needed is stored).
- Sharing recorded hikes publicly, the open-data export, R2 photo storage.
- The app side.
