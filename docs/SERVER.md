# Switchback server: accounts, your hikes, photos and review

The phone app (`mobile/`) works fully without an account. With one (Settings › Account › Create an account, or
Log in: email and password), your recorded hikes, saved trails and hike photos are kept on your account on the
Switchback server and synced to every phone you log in on, so they survive a lost phone or a reinstall. Trail
reviews and photos are public: every trail's page shows its rating, reviews and photos to everyone, with or without
an account. Hikes can be submitted as new trails, which you approve or reject on the review page.

The server is `server/` in this repository (Go and PostgreSQL); its own README has every route and setting. This
page is the overview and how to put it on the Orange Pi.

## What the app stores on your account

| Where on the server | What | Who sees it |
| --- | --- | --- |
| `/v1/me/docs/saved_trails/<id>` | each saved trail `{v: 2, trail}` (your own recorded trails too: region `own`) | only you |
| `/v1/me/docs/activities/<id>` | each recorded hike `{v: 2, walk}` with its marked spots; points as 1e-6° polylines with heights and times (a 30 km hike is a few hundred KB) | only you |
| `/v1/photos/<uuid>` | photos on your recorded hikes (taken while recording or added later from the library): a display copy (≤ 1000 px short side) and a thumbnail, JPEG, no metadata, with the hike's id, its trail, and where and when | everyone, on the trail's page, when the hike followed a known trail (public use); otherwise only you |
| `/v1/reviews/<uuid>` | your review of a trail you recorded a hike of: 1-5 stars and words, one per trail (edit or delete it any time) | everyone, on the trail's page, with your name |
| `/v1/submissions/<uuid>` | only when you choose to send it: a hike sent in as a new trail (name, line, a note with the spots you marked and your agreement to public use), or a problem with a trail you hiked (which trail, what is wrong, the walked line) | you and the reviewer; a new trail is shown to everyone once approved |

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

After a hike is kept (in the Log, and in Saved as your own trail), the app opens a sheet to review the trail (1-5
stars and words) and add photos. Neither sends the hike's recorded track anywhere. The track is only sent in when
the hiker picks one of two things on that sheet:

- **There's a problem with this trail** (its line is wrong, it is closed, it is not there, something else): a
  correction for that trail, with what they wrote and the walked line so you can see what is on the ground.
- **This is a new trail**: the walked line, a real trail name and the spots marked on the way.

Before either is sent, the hiker agrees that it may be shown publicly and that photos they add are for public use.
The same sheet opens from a kept hike in the Log and from Write a review on a trail's page. The hike's page in the
Log shows whether what was sent is waiting, approved or left as it is, and your reply.

Photos are listed with the earliest first and the latest last (by when each was taken), on a trail's page and on a
hike. A trail's page opens with its photos in a tall row; tapping one opens them full screen, where you swipe from
one to the next.

**Review page:** https://switchback2.opcw032522.uk/review, served by the server itself. Unlock it with your PIN
(chosen when you install; 6-12 digits; a wrong guess is limited to 5 tries per 15 minutes, 20 an hour in all). It
stays unlocked in that browser tab for 12 hours. New PIN: run the install command again with `-s -- --pin`. Submissions (new trails and problems with a trail): see the line on a map, the
note, who sent it; approve (a new trail is added to the community trails) or reject, with a reply. Reviews and Photos: they are
public as soon as they're posted; hide any one to take it down (or show it again).

## Putting it on the Orange Pi

Your Pi currently runs the simple document store behind the Cloudflare tunnel at `switchback2.opcw032522.uk`. The
accounts server replaces it (the document store's data was only tests). On the Pi, run:

```sh
curl -fsSL https://raw.githubusercontent.com/CadeWardC/switchback/main/server/deploy/install.sh | sudo bash
```

`server/deploy/install.sh` fetches this repository to `/opt/switchback`, stops whatever else uses port 8080 (the old
store, as a service or a Docker container), runs `setup-pi.sh` (Postgres 17, the API on `127.0.0.1:8080`, a firewall,
automatic security updates, a nightly maintenance job, low-power settings; Wi-Fi and Bluetooth are turned off only
when the Pi is on Ethernet), asks you to choose the review page's PIN, and checks the server answers on the Pi and at
`https://switchback2.opcw032522.uk/healthz`. If only the second fails, point the tunnel at it: Cloudflare Zero Trust ›
Networks › Tunnels › your tunnel › Public hostnames › `switchback2.opcw032522.uk` → `http://localhost:8080`.

Run the same command again any time to update the server (your data, settings and PIN are kept). New PIN:
`curl -fsSL https://raw.githubusercontent.com/CadeWardC/switchback/main/server/deploy/install.sh | sudo bash -s -- --pin`.

The app has the address built in (`mobile/app.config.js`); nothing to set there.

## Notes

- Email-code and Google sign-in also exist on the server, but the app uses email and password. A password account
  is never merged with an email-code or Google sign-in for the same address (the email isn't checked when
  registering, so merging would let someone take over another person's account).
- There is no "forgot password" yet: it needs the server to send email (`RESEND_API_KEY`), which it can, for the
  email-code sign-in.
