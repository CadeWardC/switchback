# Switchback server plan

Accounts, shared hikes, photos and reviews, served from an Orange Pi 3B (4 GB) at home, built so each part can move
to bigger hardware without rewriting the app.

## Goals

- **Free to run** at the start: a box we already own, a domain we already own, free tiers for the rest.
- **Smooth:** the app never waits on the server for anything it can show from the phone. Reads come from Cloudflare's
  cache where possible; writes queue on the phone and send in the background.
- **Scalable in steps:** every piece (API, database, photos) can move off the Pi on its own, by changing settings,
  not code.
- **Optional accounts:** everything Switchback does today keeps working with no account. An account is only needed to
  post reviews and photos, or share and back up hikes.
- **Private by default:** recorded hikes and photos stay on the phone unless someone chooses to share them.

## Overview

```
 iPhone app ──HTTPS──> Cloudflare (DNS, TLS, cache, WAF, rate limit)
                            │  outbound-only tunnel, no open ports at home
                            ▼
 Orange Pi 3B, 4 GB, NVMe SSD
 ├─ cloudflared        the tunnel
 ├─ switchback-api     Go, one static binary: JSON API, auth, photo uploads and downloads
 ├─ PostgreSQL 16      + PostGIS: users, hikes, reviews, photo records
 ├─ /srv/photos        photo files (content-addressed, served by the API with immutable cache headers)
 └─ WAL-G + rclone     continuous database backup and nightly photo copy ──> Cloudflare R2 (free 10 GB)
```

### Why Go + Postgres, not PocketBase

PocketBase would be faster to start with, but it's built on SQLite inside one process, so it can only ever run as
one server, and its API shape would be built into the app. To scale smoothly we want:

| Need | Our own Go API + Postgres |
|---|---|
| Run several API servers later | The API keeps no state, so any number can run behind the tunnel |
| Move the database off the Pi | Postgres moves to a bigger box or a managed host (Neon, Supabase, RDS) with `pg_dump` / replication |
| Move photos off the Pi | Storage is an interface with a "local disk" and an "S3/R2" driver: a setting changes it |
| Trail and map queries | PostGIS: "reviews and photos near here", "hikes on this trail" |
| Small on the Pi | The Go binary uses ~30 MB RAM; Postgres is tuned to ~1 GB (below) |

The API is defined in an **OpenAPI spec** (`server/api/openapi.yaml`), so the app and server stay in step and the
Swift client types can be generated from it.

## The Pi

| | Choice | Why |
|---|---|---|
| OS | Armbian (Debian 12) or Ubuntu 24.04 server, arm64 | Long-term updates, no desktop |
| Disk | **NVMe SSD** in the M.2 slot (256 GB+), boot from it | SD cards wear out and corrupt under database writes |
| Memory | 4 GB + **zram** swap (compressed, in RAM) | Safety margin without wearing the SSD |
| Power | Small UPS or a power bank that passes power through | Short outages don't take it down or corrupt anything |
| Network | **Ethernet**, not Wi-Fi | Steadier latency |

### Postgres tuning for 4 GB

```
shared_buffers = 768MB
effective_cache_size = 2GB
work_mem = 8MB
maintenance_work_mem = 128MB
max_connections = 40          # the API uses a pool of ~20
random_page_cost = 1.1        # SSD
wal_compression = on
archive_mode = on             # for WAL-G backups
```

Memory budget: Postgres ~1 GB, API ~50 MB, cloudflared ~30 MB, OS ~300 MB, leaving ~2.5 GB for the file cache
(which keeps hot photos and tables in RAM).

### Services

All run under **systemd** (start on boot, restart on crash), with **unattended-upgrades** for security patches.
The firewall (`ufw`) blocks everything coming in from the internet; SSH only from the home network, keys only.

## Data

All IDs are **UUIDv7**, made on the phone. Retrying a request that already succeeded is harmless, and records sort
by creation time.

| Table | Main fields |
|---|---|
| `users` | id, display name, avatar photo, created, deleted_at |
| `identities` | user, provider (`email`, `google`), provider id/email |
| `sessions` | user, refresh token hash, device name, last used, expires |
| `trail_refs` | trail_id, name, start point, bounding box, source (see "Trail IDs" below) |
| `reviews` | id, user, trail_id, rating 1–5, text, hiked_on, conditions (muddy, snow, overgrown, blowdown, …), created, updated. One per user per trail |
| `trail_stats` | trail_id, review count, average rating, photo count, last review date (kept up to date by a trigger) |
| `hikes` | id (= the app's Activity id), user, name, start, end, distance, gain, moving time, track (PostGIS line + encoded polyline), trail_id, visibility (`private` backup / `link` / `public`) |
| `photos` | id, user, trail_id?, hike_id?, review_id?, location, taken_at, width, height, file keys, status (`uploading`, `ready`, `hidden`) |
| `reports` | who reported what (review, photo, user), reason, status |

### Trail IDs

Hiking routes have fixed IDs (`r<relation id>`), but named paths (`w<name>-<lat>,<lon>`), unnamed paths and
Forest Service trails (`usfs-…`) are made from the name and start point. They change when someone edits the trail in
OpenStreetMap. So each review and photo also stores a `trail_refs` row: the name, the start point and the bounding
box. When a monthly trail-pack build finds that an ID has gone, a job matches the old ref to the new trail
(same name, start within ~100 m, overlapping box) and moves its reviews over. Nothing is lost when the map changes.

## API (v1)

| | Endpoint | Cached by Cloudflare |
|---|---|---|
| Sign in | `POST /v1/auth/email/start` → emails a 6-digit code · `POST /v1/auth/email/verify` · `POST /v1/auth/google` · `POST /v1/auth/refresh` · `POST /v1/auth/logout` | no |
| Me | `GET/PATCH/DELETE /v1/me` (delete removes everything they posted) | no |
| Ratings for the map | `GET /v1/cells/{cell}/stats`: every trail's rating and photo count in one 0.25° cell (the same cells as the trail packs) | **5 min** |
| Trail page | `GET /v1/trails/{id}/reviews?cursor=` · `GET /v1/trails/{id}/photos?cursor=` | **1 min** |
| Post | `PUT /v1/reviews/{id}` · `DELETE /v1/reviews/{id}` | no |
| Photos | `PUT /v1/photos/{id}` (record), then `PUT /v1/photos/{id}/file?size=display|thumb` (bytes) · `DELETE /v1/photos/{id}` | no |
| Photo files | `GET /p/{key}.heic` | **forever** (content-addressed: a key never changes) |
| Hikes | `PUT /v1/hikes/{id}` · `GET /v1/hikes?since=` (my hikes, for a new phone) · `GET /v1/hikes/{id}` (shared ones) | no / public ones 1 min |
| Moderation | `POST /v1/reports` | no |

- **`PUT` with the app's own IDs** for everything: creating and retrying are the same request.
- **Cursor pagination** (`?cursor=`), never page numbers, so lists stay fast however long they get.
- **ETags** on every GET: the app sends `If-None-Match` and gets a tiny `304` when nothing changed.
- **The cell endpoint is the key to a smooth map:** one cached request gives the stars for every trail on screen,
  using the cells the app already loads trails in.

## Photos

Decided: **1,000 px on the short side, HEIC**, plus a **400 px thumbnail** (about 150 KB + 15 KB a photo).

1. **On the phone:** ImageIO resizes (`CGImageSourceCreateThumbnailAtIndex`, no full decode, fast and light on
   memory). The location and time are read into the photo record, then the files are written **without** metadata,
   so no GPS position leaks.
2. **Upload:** the record first, then the two files. Each upload can be retried and resumed from the outbox.
3. **On the server:** it checks it's really an image (HEIC/JPEG header), at most 1,600 px, at most 1 MB, then stores it
   by its hash (`/srv/photos/ab/cd/abcd….heic`). It never decodes or re-encodes, so the Pi's CPU barely notices.
4. **Serving:** `Cache-Control: public, max-age=31536000, immutable`. Cloudflare keeps a copy, so each photo leaves
   the house about once, however many people view it.

The display size and thumbnail size are server settings sent to the app (`GET /v1/config`), so they can change later
without an app update.

Storage: about 165 KB a photo, so a 256 GB SSD holds ~1.5 million photos.

## Accounts

- **Email code** (6 digits, valid 10 minutes) and **Sign in with Google**. Both work in a sideloaded app.
  Sign in with Apple and passkeys need a paid Apple Developer account, so they come later if the app goes on the App Store.
- Email is sent through **Resend** (free: 3,000 emails a month) or Amazon SES (~$0.10 per 1,000).
- **Access token:** a signed JWT that lasts 15 minutes, checked without touching the database.
  **Refresh token:** random, stored only as a hash, rotated each use, kept in the iPhone Keychain.
- Delete account in Settings removes the user and everything they posted.

## Smooth on the phone

- **Outbox:** every write (review, photo, hike) goes into a queue saved on the phone, and a background task sends it
  when there's signal. The UI shows your own post at once ("Posting…"), even on the trail with no signal.
- **Cache reads** with the existing cache style (LZFSE files): ratings per cell, reviews per trail.
  A trail page shows what's saved instantly and refreshes behind it.
- **Thumbnails first**, display photo when it scrolls into view.
- **Everything works signed out.** Reviews and ratings are readable by anyone. Only posting asks you to sign in.

## Speed and capacity (rough, to be measured)

Before launch, a load test (k6, from another machine through Cloudflare) measures what the Pi really does.
Expected from similar ARM boards:

- Cached reads (ratings, reviews, photos) are served by Cloudflare and never reach the Pi.
- Uncached API reads: around 1,000–2,000 a second. Writes: a few hundred a second.
- The real limits are likely **home upload speed** (for photos Cloudflare hasn't cached yet) and **SSD space**.

That's comfortably enough for tens of thousands of users posting at a normal rate.

## Backups and recovery

- **Database:** WAL-G sends each change to R2 as it happens (continuous archiving) plus a full backup each night.
  We can restore to any moment in the last 14 days.
- **Photos:** rclone copies new files to R2 each night.
- **Config:** everything that sets up the Pi is a script in this repo, so a new Pi (or a cloud server) is set up the
  same way in minutes.
- **A restore test every month** (into a spare database), or the backups can't be trusted.
- R2 free tier is 10 GB; past that it costs $0.015 per GB per month (100 GB ≈ $1.50).

## Security and moderation

- Nothing open to the internet at home: the tunnel only connects outward.
- Cloudflare: free WAF rules, rate limits on sign-in and posting, bot protection.
- The API limits each user too (for example 20 reviews and 100 photos a day) and limits each IP on the sign-in endpoints.
- Every query runs with the user it's for; tests check that nobody can edit or delete someone else's posts.
- **Report** button on every review, photo and profile. Three reports hide a post until it's checked.
  An admin page (on the home network or behind Cloudflare Access, free for up to 50 users) shows reports and can
  hide, delete or ban.
- Health check: **Healthchecks.io** (free) pings us if the Pi stops answering or a backup doesn't run.

## Growing past the Pi

| Stage | What changes | When |
|---|---|---|
| 1 | Everything on the Pi | Now |
| 2 | Photos move to **R2** (copy the files, change the storage setting) | SSD past ~70%, or home upload is the bottleneck |
| 3 | Postgres moves to a bigger box or a managed host. The Pi keeps running the API, or becomes a read replica and backup | Database past ~2 GB of hot data, or writes slow down |
| 4 | More API servers (another Pi, a $5 VPS…) running the same binary; cloudflared spreads traffic over them | API CPU busy at peak |
| 5 | Postgres read replicas; search with Postgres full-text first, a search service only if needed | Lots of users |

Each step changes settings and where things run, not the app.

## Changes in the app

| | What | Where |
|---|---|---|
| Client | `API.swift`: URLSession with async/await, tokens, retries with backoff, ETags | `Switchback/Services/` |
| Account | `Account.swift`: sign in by email code or Google, Keychain, refresh, delete | `Services/`, Settings screen |
| Outbox | `Outbox.swift`: saved queue of writes, sent in the background, survives the app closing | `Services/` |
| Photos | `PhotoUpload.swift`: resize to 1,000 px short side + 400 px thumbnail in HEIC, keep location as data, strip metadata | `Services/` |
| Trail page | Stars and review count under the title; a Reviews section; "Write a review" (stars, conditions, text, photos); hikers' photos first in the header, then Commons | `TrailDetailView.swift`, `TrailMedia.swift` |
| List and map | Stars on list rows from the cell endpoint; sort by rating | `ExploreView.swift` |
| Activity | "Share" (link or public) and "Back up" on a recorded hike | `ActivityViews.swift` |
| Settings | Account, sign out, delete account; "Back up my hikes" toggle | `SettingsView.swift` |

## Repo layout

```
server/
  api/openapi.yaml          the API contract
  cmd/switchback-api/       main
  internal/…                handlers, auth, storage (disk, s3), db
  migrations/               SQL, applied in order at start
  deploy/
    setup-pi.sh             one script: packages, Postgres, tuning, users, firewall, services
    switchback-api.service
    cloudflared.yml
    walg.env.example
  loadtest/                 k6 scripts
```

## Build order

1. **Contract and database:** `openapi.yaml`, migrations, and a local Docker Compose (Postgres + API) for working on a laptop.
2. **API core:** auth (email code), reviews, cell stats, ETags, rate limits, tests.
3. **Photos:** upload, storage drivers (disk, R2), serving.
4. **Pi:** `setup-pi.sh`, Cloudflare Tunnel on our domain, backups, health checks, load test.
5. **App:** API client, account, outbox, reviews on trail pages, stars on the list.
6. **App:** photo upload and photos in the header.
7. **Hikes:** backup and sharing.
8. **Moderation:** reports, admin page. **Before** opening it up to the public.
9. Google sign-in.

## Running costs

| | Cost |
|---|---|
| Orange Pi, power (~3 W) | ~$1 a year |
| Domain | already owned |
| Cloudflare (DNS, tunnel, cache, WAF, Access) | free |
| R2 backups | free to 10 GB, then $0.015/GB/month |
| Email (Resend) | free to 3,000 a month |
| Healthchecks.io | free |

## Still to decide

- Display names only, or public profile pages (with their hikes and reviews)?
- Should reviews be editable after posting, and should the edit show?
- Is the NVMe SSD already in the Pi, and what size?
- Home upload speed (from a speed test), to know when photos should move to R2.
