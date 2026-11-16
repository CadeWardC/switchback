package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Each person's own documents (the phone's recorded hikes and saved trails), kept in sync between their devices.
// A document is any JSON; writing one replaces it (last write wins). Lists with ?since= return what changed after
// that time, deleted ones included, so a phone only fetches what's new.
const (
	maxDocBytes  = 2 << 20   // one document
	maxUserBytes = 200 << 20 // all of one person's documents
)

var docNameRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

func docNames(r *http.Request, withID bool) (collection, id string, err error) {
	collection = r.PathValue("collection")
	if withID {
		id = r.PathValue("id")
	}
	if !docNameRE.MatchString(collection) || (withID && !docNameRE.MatchString(id)) {
		return "", "", fail(http.StatusBadRequest, "bad_name", "Collections and ids are 1 to 128 letters, digits, _ - or .")
	}
	return collection, id, nil
}

// lockUserDocs makes one person's document writes and lists take turns, so a list's server_time is never later
// than a write it didn't see.
func lockUserDocs(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('docs:' || $1, 0))`, userID)
	return err
}

// nextDocTime gives out the next updated_at: the time in milliseconds, or one more than the last value if that's
// later. The row stays locked until the transaction ends, so values are handed out in commit order.
func nextDocTime(ctx context.Context, tx pgx.Tx) (int64, error) {
	var t int64
	err := tx.QueryRow(ctx, `
		UPDATE doc_clock SET t = greatest(t + 1, (extract(epoch FROM clock_timestamp()) * 1000)::bigint) RETURNING t`).Scan(&t)
	return t, err
}

type docOut struct {
	ID        string          `json:"id"`
	UpdatedAt int64           `json:"updated_at"`
	Deleted   bool            `json:"deleted"`
	Data      json.RawMessage `json:"data"`
}

func (s *Server) listDocs(w http.ResponseWriter, r *http.Request, c caller) {
	collection, _, err := docNames(r, false)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var since *int64
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, r, fail(http.StatusBadRequest, "bad_since", "since is a number from an earlier list's server_time."))
			return
		}
		since = &n
	}
	// One snapshot for the clock and the documents. The answer is written out while it's read, so a person with
	// many hikes doesn't need them all in memory at once.
	tx, err := s.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err := lockUserDocs(r.Context(), tx, c.UserID); err != nil {
		writeErr(w, r, err)
		return
	}
	var serverTime int64
	if err := tx.QueryRow(r.Context(), `SELECT t FROM doc_clock`).Scan(&serverTime); err != nil {
		writeErr(w, r, err)
		return
	}
	var rows pgx.Rows
	if since == nil {
		rows, err = tx.Query(r.Context(), `
			SELECT id, updated_at, deleted, data::text FROM user_docs
			WHERE user_id = $1 AND collection = $2 AND NOT deleted ORDER BY updated_at`, c.UserID, collection)
	} else {
		rows, err = tx.Query(r.Context(), `
			SELECT id, updated_at, deleted, data::text FROM user_docs
			WHERE user_id = $1 AND collection = $2 AND updated_at > $3 ORDER BY updated_at`, c.UserID, collection, *since)
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	started := false
	enc := json.NewEncoder(w)
	for rows.Next() {
		var d docOut
		var data *string
		if err := rows.Scan(&d.ID, &d.UpdatedAt, &d.Deleted, &data); err != nil {
			if !started {
				writeErr(w, r, err)
			}
			return
		}
		d.Data = json.RawMessage("null")
		if data != nil {
			d.Data = json.RawMessage(*data)
		}
		if !started {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"items":[`))
			started = true
		} else {
			w.Write([]byte(","))
		}
		if err := enc.Encode(d); err != nil {
			return
		}
	}
	if err := rows.Err(); err != nil {
		if !started {
			writeErr(w, r, err)
		}
		return // cut short: the phone sees broken JSON and tries again
	}
	if !started {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"items":[`))
	}
	w.Write([]byte(`],"server_time":` + strconv.FormatInt(serverTime, 10) + "}\n"))
}

func (s *Server) putDoc(w http.ResponseWriter, r *http.Request, c caller) {
	collection, id, err := docNames(r, true)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDocBytes))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeErr(w, r, fail(http.StatusRequestEntityTooLarge, "too_large", "That's more than 2 MB."))
		return
	}
	if err != nil {
		writeErr(w, r, fail(http.StatusBadRequest, "bad_body", "The request body couldn't be read."))
		return
	}
	if !json.Valid(body) {
		writeErr(w, r, fail(http.StatusBadRequest, "bad_json", "The request body isn't valid JSON."))
		return
	}
	if err := s.allow("docs:"+c.UserID, 2000, time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	var t int64
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		if err := lockUserDocs(r.Context(), tx, c.UserID); err != nil {
			return err
		}
		var used int64
		if err := tx.QueryRow(r.Context(), `
			SELECT coalesce(sum(size), 0) FROM user_docs WHERE user_id = $1 AND NOT (collection = $2 AND id = $3)`,
			c.UserID, collection, id).Scan(&used); err != nil {
			return err
		}
		if used+int64(len(body)) > maxUserBytes {
			return fail(http.StatusRequestEntityTooLarge, "account_full", "Your account is full (200 MB). Delete some hikes to make room.")
		}
		var err error
		if t, err = nextDocTime(r.Context(), tx); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO user_docs (user_id, collection, id, data, deleted, size, updated_at) VALUES ($1, $2, $3, $4, false, $5, $6)
			ON CONFLICT (user_id, collection, id) DO UPDATE SET data = $4, deleted = false, size = $5, updated_at = $6`,
			c.UserID, collection, id, string(body), len(body), t)
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "updated_at": t, "deleted": false})
}

// deleteDoc leaves a tombstone so the person's other devices remove it too. Deleting what isn't there is fine.
func (s *Server) deleteDoc(w http.ResponseWriter, r *http.Request, c caller) {
	collection, id, err := docNames(r, true)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("docs:"+c.UserID, 2000, time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	var t int64
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		if err := lockUserDocs(r.Context(), tx, c.UserID); err != nil {
			return err
		}
		var err error
		if t, err = nextDocTime(r.Context(), tx); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO user_docs (user_id, collection, id, data, deleted, size, updated_at) VALUES ($1, $2, $3, NULL, true, 0, $4)
			ON CONFLICT (user_id, collection, id) DO UPDATE SET data = NULL, deleted = true, size = 0, updated_at = $4`,
			c.UserID, collection, id, t)
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "updated_at": t, "deleted": true})
}
