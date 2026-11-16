-- Email + password accounts. The subject is the email hash (as for email codes), and only a bcrypt hash of the
-- password is kept.
ALTER TABLE identities DROP CONSTRAINT identities_provider_check;
ALTER TABLE identities ADD CONSTRAINT identities_provider_check CHECK (provider IN ('email', 'google', 'password'));
ALTER TABLE identities ADD COLUMN password_hash bytea;
ALTER TABLE identities ADD CONSTRAINT identities_password_check CHECK ((provider = 'password') = (password_hash IS NOT NULL));

-- Each person's own documents: the phone's recorded hikes and saved trails, synced between their devices. A
-- deleted document stays as a tombstone (deleted, no data) so other devices learn it's gone.
CREATE TABLE user_docs (
    user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    collection text NOT NULL CHECK (collection ~ '^[A-Za-z0-9_.-]{1,128}$'),
    id         text NOT NULL CHECK (id ~ '^[A-Za-z0-9_.-]{1,128}$'),
    data       jsonb,
    deleted    boolean NOT NULL DEFAULT false,
    size       int NOT NULL DEFAULT 0, -- bytes as sent, for the per-person cap
    updated_at bigint NOT NULL,
    PRIMARY KEY (user_id, collection, id),
    CHECK (deleted = (data IS NULL))
);
CREATE INDEX user_docs_changes ON user_docs (user_id, collection, updated_at);

-- The clock documents' updated_at comes from: milliseconds, but always at least one more than the last value given
-- out, so it never goes backwards or repeats even if the system clock does.
CREATE TABLE doc_clock (
    one boolean PRIMARY KEY DEFAULT true CHECK (one),
    t   bigint NOT NULL
);
INSERT INTO doc_clock (t) VALUES ((extract(epoch FROM clock_timestamp()) * 1000)::bigint);

-- Photos taken on a recorded hike (the phone's id for the hike).
ALTER TABLE photos ADD COLUMN walk_id text CHECK (walk_id ~ '^[A-Za-z0-9_.-]{1,128}$');
CREATE INDEX photos_user_walk ON photos (user_id, walk_id, created_at DESC);
