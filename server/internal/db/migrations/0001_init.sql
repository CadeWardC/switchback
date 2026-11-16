-- Accounts

CREATE TABLE users (
    id           uuid PRIMARY KEY,
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- How someone signs in. Email addresses are never stored: only a keyed hash (HMAC) of them, enough to sign in and
-- to make an email and a Google account with the same verified email one user.
CREATE TABLE identities (
    provider   text NOT NULL CHECK (provider IN ('email', 'google')),
    subject    text NOT NULL,
    user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    email_hash bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);
CREATE INDEX identities_email ON identities (email_hash);

-- Sign-in codes waiting to be entered (only hashes are kept).
CREATE TABLE email_codes (
    email_hash bytea PRIMARY KEY,
    code_hash  bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts   int NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    device       text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Trails, as the app knows them. Ids made from a name and start point change when OpenStreetMap is edited, so the
-- name, start and box are kept to match posts to the new id later.

CREATE TABLE trail_refs (
    trail_id   text PRIMARY KEY CHECK (length(trail_id) BETWEEN 1 AND 300),
    name       text NOT NULL DEFAULT '',
    start_lat  double precision NOT NULL,
    start_lon  double precision NOT NULL,
    min_lat    double precision NOT NULL,
    min_lon    double precision NOT NULL,
    max_lat    double precision NOT NULL,
    max_lon    double precision NOT NULL,
    cell       text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trail_refs_cell ON trail_refs (cell);

-- Kept up to date by the API in the same transaction as each change.
CREATE TABLE trail_stats (
    trail_id       text PRIMARY KEY REFERENCES trail_refs ON DELETE CASCADE ON UPDATE CASCADE,
    cell           text NOT NULL,
    review_count   int NOT NULL DEFAULT 0,
    rating_sum     int NOT NULL DEFAULT 0,
    photo_count    int NOT NULL DEFAULT 0,
    hiker_count    int NOT NULL DEFAULT 0,
    last_review_at timestamptz
);
CREATE INDEX trail_stats_cell ON trail_stats (cell);

-- Posts

CREATE TABLE reviews (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    trail_id   text NOT NULL REFERENCES trail_refs ON UPDATE CASCADE,
    rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body       text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
    hiked_on   date,
    conditions text[] NOT NULL DEFAULT '{}',
    hidden     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, trail_id)
);
CREATE INDEX reviews_trail ON reviews (trail_id, created_at DESC, id DESC) WHERE NOT hidden;

CREATE TABLE hike_logs (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    trail_id   text NOT NULL REFERENCES trail_refs ON UPDATE CASCADE,
    hiked_on   date NOT NULL,
    hike_id    uuid,
    note       text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    public     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hike_logs_user ON hike_logs (user_id, hiked_on DESC, id DESC);
CREATE INDEX hike_logs_trail ON hike_logs (trail_id);

CREATE TABLE photos (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    trail_id    text REFERENCES trail_refs ON UPDATE CASCADE,
    review_id   uuid REFERENCES reviews ON DELETE SET NULL,
    log_id      uuid REFERENCES hike_logs ON DELETE SET NULL,
    lat         double precision,
    lon         double precision,
    taken_at    timestamptz,
    width       int,
    height      int,
    display_key text,
    thumb_key   text,
    status      text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'hidden')),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_trail ON photos (trail_id, created_at DESC, id DESC) WHERE status = 'ready';
CREATE INDEX photos_user ON photos (user_id);

-- Trail submissions: new trails and corrections, approved before anyone else sees them.

CREATE TABLE trail_submissions (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('new_trail', 'correction')),
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    trail_id    text REFERENCES trail_refs ON UPDATE CASCADE,
    field       text,
    value       text CHECK (length(value) <= 500),
    note        text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    name        text CHECK (length(name) <= 120),
    difficulty  text,
    line        text CHECK (length(line) <= 200000),
    min_lat     double precision,
    min_lon     double precision,
    max_lat     double precision,
    max_lon     double precision,
    cell        text,
    reply       text NOT NULL DEFAULT '',
    reviewed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trail_submissions_user ON trail_submissions (user_id, created_at DESC);
CREATE INDEX trail_submissions_pending ON trail_submissions (created_at) WHERE status = 'pending';

CREATE TABLE trail_overrides (
    trail_id      text NOT NULL REFERENCES trail_refs ON DELETE CASCADE ON UPDATE CASCADE,
    field         text NOT NULL,
    value         text NOT NULL,
    submission_id uuid REFERENCES trail_submissions ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trail_id, field)
);

CREATE TABLE community_trails (
    id            uuid PRIMARY KEY,
    name          text NOT NULL,
    difficulty    text,
    line          text NOT NULL,
    min_lat       double precision NOT NULL,
    min_lon       double precision NOT NULL,
    max_lat       double precision NOT NULL,
    max_lon       double precision NOT NULL,
    cell          text NOT NULL,
    submitted_by  uuid REFERENCES users ON DELETE SET NULL,
    approved_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_trails_cell ON community_trails (cell);

-- Moderation

CREATE TABLE reports (
    reporter    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    target_kind text NOT NULL CHECK (target_kind IN ('review', 'photo', 'user', 'submission')),
    target_id   uuid NOT NULL,
    reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reporter, target_kind, target_id)
);
CREATE INDEX reports_target ON reports (target_kind, target_id) WHERE status = 'open';
