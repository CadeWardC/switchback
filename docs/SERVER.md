# Switchback server: sync, submissions and review

The phone app works fully with no account. Signing in (Settings › Account & sync: server address + API key, kept
in the phone's secure store) backs saved trails and recorded hikes up to a self-hosted Switchback server and keeps
them in sync between devices. Hikes can also be submitted for review, to be added to the public trail data.

## Collections

The phone app (`mobile/`) writes these. Code: `mobile/src/core/server.ts` (the API), `sync.ts` (syncing),
`syncFormat.ts` (ids and document shapes, unit-tested in `mobile/test/sync.test.ts`, which also runs against a
live server when `SB_URL` and `SB_KEY` are set).

| Collection | Document id | Body | Written by |
| --- | --- | --- | --- |
| `saved_trails` | `t.<region>.<trail id>`, or `h.<hash>` when the id has characters the server doesn't allow | `{v: 2, trail}`: the saved trail as the app keeps it (region, id, name, length, climb, difficulty, start, `saved` in ms). Your own trail (a hike you recorded, kept in Saved) has region `own` and `walk` = the hike's id | the app |
| `activities` | `w.<hike id>` | `{v: 2, walk}`: the recorded hike with its marked spots; each stretch's points as `{line, ele, t, acc}`: `line` an encoded polyline at 1e-6° (~0.1 m), heights, seconds after the start, GPS accuracy. A 30 km hike is a few hundred KB | the app |
| `submissions` | `s.<hike id>.<time>` | `{v: 2, status, submitted_at, name, review: {rating, text}, public_use_consent, app_version, hike: {start, distance, moving_time, gain, trail_name, segments: [{line, alt, t}], points: [{kind: "spot", note, lat, lon, time}]}, gpx, reviewed_at, reviewer_note}`; `status` is `pending`, then `approved` or `rejected`; `gpx` is the submission file `docs/SUBMISSIONS.md` describes | the app creates it; the review page sets the status |
| `approved_hikes` | the submission's id | `{v, name, approved_at, submitted_at, review, hike}` | the review page, on approval (removed again on rejection) |

Settings, caches, offline maps, trail packs and the hike being recorded stay on the phone.

## How the app syncs

- The app watches its two lists (saved trails, kept hikes): whatever is added or changed is queued for upload,
  whatever is removed for deletion. Everything works offline; the queue is sent when the server can be reached: at
  launch, when the app comes back to the screen, when the connection returns, a couple of seconds after a change,
  and from Settings › Account & sync › Sync now.
- Then each collection is pulled with `GET /v1/{collection}?since=<server_time from the last list>`: live documents
  are applied, `deleted: true` ones removed. A change on the phone that hasn't been sent yet wins over the server's
  copy of the same item; otherwise the server's (last write wins).
- **First sync** (or after signing in to a different server): the server's copy is taken first, so a second phone
  can't overwrite the first, then everything only the phone has is uploaded.
- Errors: no connection is shown as offline in Settings (changes wait); anything else (a wrong key, a block in
  front of the server, an item over ~2 MB) is shown once as a message and stays in Settings until a sync succeeds.

## Submissions

A finished hike goes to the Log and to Saved as your own trail, then the app offers to submit it (also from the
hike's page in the Log). A submission needs a real trail name (not "Morning hike"), may carry a 1-5 star review,
and includes the spots marked with Mark a spot during the hike: spots can only be submitted as part of a recorded
hike, so every spot comes from someone who walked there. The hiker must agree that what they submit may be shown
publicly and that photos they submit are for public use. Nothing is added until it is approved.

**Review page:** open `web/review.html` in a browser (it has no secrets in it), enter the server address and the
owner key (kept only for that browser tab), and approve or reject each submission. It shows the track and spots on
a map, the review, and the hiker's consent. Approving copies it to `approved_hikes`.

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
