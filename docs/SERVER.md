# Switchback server: sync, submissions and review

The app works fully on the phone with no account. Signing in (Settings › Account & sync: server address + API
key, kept in the Keychain) backs saved trails and recorded hikes up to a self-hosted Switchback server and keeps
them in sync between devices. Hikes can also be submitted for review, to be added to the public trail data.

## Collections

| Collection | Document id | Body | Written by |
| --- | --- | --- | --- |
| `saved_trails` | `t.<trail id>`, or `h.<sha256 of trail id>` when the id has characters the server doesn't allow (`u123\|456`) or is too long | `{v, trail, saved_at}`: `trail` is the trail exactly as the app stores it (lines as encoded polylines, 1e-5°); `saved_at` in ms | the app (owner) |
| `activities` | the hike's UUID, lower case | `{v, id, name, start, end, distance, moving_time, elapsed_time, gain, trail_id, trail_name, segments: [{line, alt, t}], points, submission_id}`: `line` is an encoded polyline at 1e-6° (~0.1 m), `alt` metres (null where GPS had none), `t` seconds after `start`; dates in ms. A 30 km hike is about 145 KB | the app (owner) |
| `submissions` | a new UUID | `{v, status, submitted_at, name, review: {rating, text}, public_use_consent, app_version, hike: <activity body>, reviewed_at, reviewer_note}`; `status` is `pending`, then `approved` or `rejected` | the app creates it; the review page sets the status |
| `approved_hikes` | the submission's id | `{v, name, approved_at, submitted_at, review, hike}` | the review page, on approval (removed again on rejection) |

Settings, caches, offline maps, trail packs and the in-progress recording stay on the phone.

## How the app syncs

- Every change on the phone (save, rename, delete, a new hike) is applied locally first and queued
  (`sync-state.json`), so everything works offline. The queue is sent when the server can be reached: on launch,
  each time the app comes back to the foreground, a couple of seconds after a change, on pull-to-refresh in Saved
  or Activity, and from Settings › Sync now.
- Then each collection is pulled with `GET /v1/{collection}?since=<server_time from the last list>`: live
  documents are upserted, `deleted: true` ones removed. A local change that hasn't been sent yet wins over the
  server's copy of the same item; otherwise the server's (last write wins).
- **First sync** (or after signing in to a different server): the full list is taken first, so the server's copy
  wins for anything both have (a second phone can't overwrite the first), then everything only the phone has is
  uploaded.
- Errors: no connection is shown as "offline" (changes wait); a wrong key, a block in front of the server, or an
  item over ~2 MB is shown in Settings and as a cloud icon in Saved and Activity (tap it for the message).

## Submissions

After a recorded hike is saved (it goes to Activity and to Saved as your own trail), the app offers to submit it.
A submission needs a real trail name (not "Morning hike"), may include a 1-5 star review, and carries the points
the hiker marked during the hike. Points can only be submitted as part of a recorded hike, so every point comes
from someone who walked there. The hiker must agree that what they submit may be shown publicly and that photos
they submit are for public use. Nothing is added until it is approved.

**Review page:** open `web/review.html` in a browser (from the repository, or published with GitHub Pages; it
has no secrets in it), enter the server address and the owner key (kept only for that browser tab), and approve
or reject each submission. It shows the track and points on a map, the review, and the hiker's consent.

## Opening it to other people: what the server needs

Today the server has one key that can read, write and delete everything. That's fine while you're the only user,
but every person given the app would need that same key, and could then read everyone's hikes, delete data,
or approve their own submissions. A public website couldn't read anything without embedding the key. To open
Switchback up, the server needs these changes (all on the Orange Pi; nothing changes for the API the app uses
today):

1. **Accounts with their own keys.** `POST /v1/auth/signup` / `login` returning a per-person key. Store each
   person's documents under their account (e.g. key the store on `(user, collection, id)`), so
   `GET/PUT/DELETE /v1/saved_trails/...` and `/v1/activities/...` only ever see that person's own documents.
   The app's sync code then works unchanged: only the key differs per person. Signing in stays optional.
2. **Submit-only access to `submissions`.** A person's key may `PUT` a new submission (stamped with their account)
   and `GET` their own, but can't list others' or change `status`.
3. **An owner/admin key** (the current one) that alone can list all submissions and write `status` and
   `approved_hikes`. The review page keeps working with it as is.
4. **A public read-only route** for approved data, e.g. `GET /public/v1/approved_hikes` (and `?since=`), no key,
   cached. A public trail site (and the app, to show approved points to everyone) would read only from there.
5. Optionally: rate limits on signup and submissions, and a size cap per account.

If you add the server's code to this repository (or another repository I can open), I can make these changes
and build the public site on top of route 4.

### Cloudflare

The tunnel's Browser Integrity Check blocks some non-browser clients (it answered `error code: 1010` to Python's
default HTTP client in testing; curl and browsers got through). If the app ever shows "blocked before it reached
the server (403)", turn Browser Integrity Check off for this hostname, or add a WAF skip rule for `/v1/*` and
`/health`.
