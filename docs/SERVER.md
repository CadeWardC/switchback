# Switchback server: accounts, your hikes, photos and review

The phone app (`mobile/`) works fully without an account. With one (Settings › Account › Create an account, or
Log in: email and password), your recorded hikes, saved trails and hike photos are kept on your account on the
Switchback server and synced to every phone you log in on, so they survive a lost phone or a reinstall. Hikes can be
submitted as new trails, which you approve or reject on the review page.

The server is `server/` in this repository (Go and PostgreSQL); its own README has every route and setting. This
page is the overview and how to put it on the Orange Pi.

## What the app stores on your account

| Where on the server | What | Who sees it |
| --- | --- | --- |
| `/v1/me/docs/saved_trails/<id>` | each saved trail `{v: 2, trail}` (your own recorded trails too: region `own`) | only you |
| `/v1/me/docs/activities/<id>` | each recorded hike `{v: 2, walk}` with its marked spots; points as 1e-6° polylines with heights and times (a 30 km hike is a few hundred KB) | only you |
| `/v1/photos/<uuid>` | photos on your recorded hikes (taken while recording or added later from the library): a display copy (≤ 1000 px short side) and a thumbnail, JPEG, no metadata, with the hike's id and where and when | only you (the files are at unguessable links) |
| `/v1/submissions/<uuid>` | a hike you submitted as a new trail: name, line, a note with your review, the spots you marked and your agreement to public use | you and the reviewer; everyone once approved |

The server never stores email addresses: a keyed hash stands in for them, and passwords are kept as bcrypt hashes.
Settings, caches, offline maps, trail packs and the hike being recorded stay on the phone.

Code: `mobile/src/core/server.ts` (accounts and requests), `sync.ts` (syncing), `syncFormat.ts` (ids and document
shapes), `myPhotos.ts` (photos); tests in `mobile/test/sync.test.ts`, which also run against a server when
`SB_URL` is set (for example `SB_URL=http://localhost:8080 npx jest`).

## How syncing works

- Everything works offline. The app watches its saved trails and kept hikes: whatever changes is queued and sent
  when the server can be reached (at launch, when the app comes back to the screen, when the connection returns, a
  couple of seconds after a change, and Settings › Account › Sync now). Photos follow their hikes.
- Then each collection is pulled with `?since=<server_time from the last list>`: changes from your other phones
  come in, deletions included. A change on this phone that hasn't been sent yet wins over the server's copy.
- The first time you log in, what's on your account comes down first, then what only this phone has goes up.
- Logging in returns a short access token and a refresh token; the refresh token is kept in the phone's secure
  store and renews the access token when it runs out.

## Submissions and the review page

After a hike is kept (in the Log, and in Saved as your own trail), the app offers to submit it: it needs a real
trail name, may carry a 1-5 star review, and includes the spots marked on the way. The hiker agrees that it may be
shown publicly and that photos they submit are for public use. The hike's page in the Log shows whether it is
waiting, approved or not added, and your reply.

**Review page:** open `web/review.html` in a browser (it has no secrets in it), enter the server's address and the
admin token (`ADMIN_TOKEN` on the server; kept only for that browser tab). Submissions: see the line on a map, the
note, who sent it; approve (adds it to the community trails) or reject, with a reply. Photos: hide or show any
photo.

## Putting it on the Orange Pi

Your Pi currently runs the simple document store behind the Cloudflare tunnel at `switchback2.opcw032522.uk`. The
accounts server replaces it (the document store's data was only tests).

1. **Read `server/deploy/setup-pi.sh` first.** Besides Postgres 17 and the API it sets up a firewall, automatic
   security updates, a nightly maintenance job and low-power settings, and turns Wi-Fi and Bluetooth off when the Pi
   is on Ethernet (`--keep-radios` keeps them).
2. **Stop the document store** so the new server can have port 8080 (or whichever port it used: the API listens on
   `127.0.0.1:8080`).
3. **Run the setup script** on the Pi (it downloads the latest `server-latest` release, built by the Server
   workflow from main):
   ```sh
   git clone https://github.com/CadeWardC/switchback && cd switchback/server/deploy
   sudo ./setup-pi.sh --domain switchback2.opcw032522.uk
   ```
   Leave out `--tunnel-token` to keep your existing tunnel as it is.
4. **Point the tunnel at it**: in Cloudflare Zero Trust › Networks › Tunnels › your tunnel › Public hostnames, set
   `switchback2.opcw032522.uk` → `http://localhost:8080`. Check `https://switchback2.opcw032522.uk/healthz` says
   `ok`. (If the app ever reports a 403 "blocked before it reached the server", turn off Cloudflare's Browser
   Integrity Check for this host.)
5. **The admin token** for the review page: `sudo grep ADMIN_TOKEN /etc/switchback/api.env`.
6. **Nothing to set in the app**: `https://switchback2.opcw032522.uk` is built in (`mobile/app.config.js`), so
   people just create an account or log in. (A build can point elsewhere, e.g. a test server, with the
   environment variable or GitHub repository variable `SWITCHBACK_SERVER_URL`.)

## Notes

- Email-code and Google sign-in also exist on the server, but the app uses email and password. A password account
  is never merged with an email-code or Google sign-in for the same address (the email isn't checked when
  registering, so merging would let someone take over another person's account).
- There is no "forgot password" yet: it needs the server to send email (`RESEND_API_KEY`), which it can, for the
  email-code sign-in.
