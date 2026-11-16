package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"switchback/server/internal/images"
)

// Photo sizes the app makes (sent to it by /v1/config, so they can change without an app update) and what the
// server accepts (a little slack for rounding).
const (
	displayShortSide = 1000
	thumbShortSide   = 400
	maxDisplayBytes  = 1 << 20
	maxThumbBytes    = 200 << 10
)

type photoOut struct {
	ID          string     `json:"id"`
	UserID      string     `json:"user_id"`
	DisplayName string     `json:"display_name"`
	TrailID     *string    `json:"trail_id"`
	ReviewID    *string    `json:"review_id"`
	LogID       *string    `json:"log_id"`
	WalkID      *string    `json:"walk_id"`
	URL         *string    `json:"url"`
	ThumbURL    *string    `json:"thumb_url"`
	Width       *int       `json:"width"`
	Height      *int       `json:"height"`
	Lat         *float64   `json:"lat"`
	Lon         *float64   `json:"lon"`
	TakenAt     *time.Time `json:"taken_at"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
}

const photoSelect = `
	SELECT p.id, p.user_id, u.display_name, p.trail_id, p.review_id, p.log_id, p.walk_id, p.display_key, p.thumb_key, p.width,
	       p.height, round(p.lat::numeric, 4)::float8, round(p.lon::numeric, 4)::float8, p.taken_at, p.status, p.created_at
	FROM photos p JOIN users u ON u.id = p.user_id`

// Photos are listed oldest first: by when each was taken, or when it was uploaded if that isn't known.
const (
	photoWhen  = `coalesce(p.taken_at, p.created_at)`
	photoOrder = ` ORDER BY ` + photoWhen + `, p.id`
)

func (s *Server) scanPhoto(row pgx.Row) (photoOut, error) {
	var o photoOut
	var display, thumb *string
	err := row.Scan(&o.ID, &o.UserID, &o.DisplayName, &o.TrailID, &o.ReviewID, &o.LogID, &o.WalkID, &display, &thumb, &o.Width,
		&o.Height, &o.Lat, &o.Lon, &o.TakenAt, &o.Status, &o.CreatedAt)
	o.URL, o.ThumbURL = s.photoURL(display), s.photoURL(thumb)
	return o, err
}

func (s *Server) trailPhotos(w http.ResponseWriter, r *http.Request) {
	trail := r.URL.Query().Get("trail")
	if trail == "" {
		writeErr(w, r, fail(http.StatusBadRequest, "no_trail", "Add ?trail=<trail id>."))
		return
	}
	// oldest first, by when the photo was taken (when it was uploaded, if that isn't known): the newest come last
	args := []any{trail}
	where := ` WHERE p.trail_id = $1 AND p.status = 'ready'`
	if t, id, ok := decodeCursor(r.URL.Query().Get("cursor")); ok {
		where += ` AND (` + photoWhen + `, p.id) > ($2, $3)`
		args = append(args, t, id)
	}
	rows, err := s.DB.Query(r.Context(), photoSelect+where+photoOrder+` LIMIT 31`, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	photos := []photoOut{}
	for rows.Next() {
		o, err := s.scanPhoto(rows)
		if err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		photos = append(photos, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	var cursor *string
	if len(photos) == 31 {
		photos = photos[:30]
		at := photos[29].CreatedAt
		if photos[29].TakenAt != nil {
			at = *photos[29].TakenAt
		}
		c := encodeCursor(at, photos[29].ID)
		cursor = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"photos": photos, "cursor": cursor})
}

// myPhotos lists the caller's own photos (whatever their state), oldest first; ?walk= keeps one recorded hike's.
func (s *Server) myPhotos(w http.ResponseWriter, r *http.Request, c caller) {
	where, args := ` WHERE p.user_id = $1`, []any{c.UserID}
	if walk := r.URL.Query().Get("walk"); walk != "" {
		if !docNameRE.MatchString(walk) {
			writeErr(w, r, fail(http.StatusBadRequest, "bad_name", "walk is 1 to 128 letters, digits, _ - or ."))
			return
		}
		where += ` AND p.walk_id = $2`
		args = append(args, walk)
	}
	s.writePhotos(w, r, photoSelect+where+photoOrder+` LIMIT 2000`, args...)
}

// writePhotos answers {"photos": [...]} for a photo query.
func (s *Server) writePhotos(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	rows, err := s.DB.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	photos := []photoOut{}
	for rows.Next() {
		o, err := s.scanPhoto(rows)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		photos = append(photos, o)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"photos": photos})
}

// putPhoto creates or updates a photo's record. Its files are sent next with putPhotoFile.
func (s *Server) putPhoto(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Trail    *TrailRef  `json:"trail"`
		ReviewID *string    `json:"review_id"`
		LogID    *string    `json:"log_id"`
		WalkID   *string    `json:"walk_id"`
		Lat      *float64   `json:"lat"`
		Lon      *float64   `json:"lon"`
		TakenAt  *time.Time `json:"taken_at"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := optUUID(in.ReviewID); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := optUUID(in.LogID); err != nil {
		writeErr(w, r, err)
		return
	}
	if in.WalkID != nil && !docNameRE.MatchString(*in.WalkID) {
		writeErr(w, r, fail(http.StatusBadRequest, "bad_name", "walk_id is 1 to 128 letters, digits, _ - or ."))
		return
	}
	if (in.Lat == nil) != (in.Lon == nil) || (in.Lat != nil && !validLatLon(*in.Lat, *in.Lon)) {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_location", "lat and lon go together and must be valid."))
		return
	}
	var trailID *string
	if in.Trail != nil {
		if err := in.Trail.validate(); err != nil {
			writeErr(w, r, err)
			return
		}
		trailID = &in.Trail.ID
	}
	var out photoOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		// a review or log the photo belongs to must be the caller's own
		for _, ref := range []struct {
			table string
			id    *string
		}{{"reviews", in.ReviewID}, {"hike_logs", in.LogID}} {
			if ref.id == nil {
				continue
			}
			var owner string
			if err := tx.QueryRow(r.Context(), `SELECT user_id FROM `+ref.table+` WHERE id = $1`, *ref.id).Scan(&owner); err != nil {
				return err
			}
			if owner != c.UserID {
				return errForbidden
			}
		}
		var owner string
		var oldTrail *string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id FROM photos WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &oldTrail)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := s.allow("photo:"+c.UserID, 100, 24*time.Hour); err != nil {
				return err
			}
		case err != nil:
			return err
		case owner != c.UserID:
			return errForbidden
		}
		if in.Trail != nil {
			if err := saveTrailRef(r.Context(), tx, *in.Trail); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO photos (id, user_id, trail_id, review_id, log_id, walk_id, lat, lon, taken_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (id) DO UPDATE SET trail_id = $3, review_id = $4, log_id = $5, walk_id = $6, lat = $7, lon = $8, taken_at = $9`,
			id, c.UserID, trailID, in.ReviewID, in.LogID, in.WalkID, in.Lat, in.Lon, in.TakenAt); err != nil {
			return err
		}
		if err := refreshStats(r.Context(), tx, trailID); err != nil {
			return err
		}
		if oldTrail != nil && (trailID == nil || *oldTrail != *trailID) {
			if err := refreshStats(r.Context(), tx, oldTrail); err != nil {
				return err
			}
		}
		out, err = s.scanPhoto(tx.QueryRow(r.Context(), photoSelect+` WHERE p.id = $1`, id))
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// putPhotoFile takes the photo's display or thumbnail file (?size=display|thumb). The server checks it and takes
// any metadata out of a JPEG, but never decodes or re-encodes the picture.
func (s *Server) putPhotoFile(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	size := r.URL.Query().Get("size")
	limit, short := int64(maxDisplayBytes), displayShortSide
	column := "display_key"
	switch size {
	case "display":
	case "thumb":
		limit, short, column = maxThumbBytes, thumbShortSide, "thumb_key"
	default:
		writeErr(w, r, fail(http.StatusBadRequest, "bad_size", "Add ?size=display or ?size=thumb."))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		writeErr(w, r, fail(http.StatusRequestEntityTooLarge, "too_big", "That file is too big."))
		return
	}
	info, err := images.Sniff(data)
	switch {
	case err != nil:
		err = fail(http.StatusUnsupportedMediaType, "not_a_photo", "Photos must be HEIC or JPEG.")
	case info.Ext == "jpg":
		// metadata is taken out here rather than refused: an iPhone writes an EXIF block into every JPEG it makes
		data, err = images.CleanJPEG(data)
		if err != nil {
			err = fail(http.StatusUnsupportedMediaType, "not_a_photo", "Photos must be HEIC or JPEG.")
		}
	case info.HasEXIF:
		err = fail(http.StatusUnprocessableEntity, "has_metadata", "Remove the photo's metadata (EXIF) before uploading.")
	}
	if err == nil {
		lo, hi := min(info.Width, info.Height), max(info.Width, info.Height)
		if lo > short+short/10 || lo < 16 || hi > lo*4 {
			err = fail(http.StatusUnprocessableEntity, "bad_dimensions", "That photo is the wrong size for this slot.")
		}
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var owner string
	if err := s.DB.QueryRow(r.Context(), `SELECT user_id FROM photos WHERE id = $1`, id).Scan(&owner); err != nil {
		writeErr(w, r, err)
		return
	}
	if owner != c.UserID {
		writeErr(w, r, errForbidden)
		return
	}
	key, err := s.Store.Put(r.Context(), data, info.Ext)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var out photoOut
	var replaced *string
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var old *string
		var status string
		var trail *string
		if err := tx.QueryRow(r.Context(), `SELECT `+column+`, status, trail_id FROM photos WHERE id = $1 FOR UPDATE`, id).
			Scan(&old, &status, &trail); err != nil {
			return err
		}
		if old != nil && *old != key {
			replaced = old
		}
		q := `UPDATE photos SET ` + column + ` = $2`
		args := []any{id, key}
		if size == "display" {
			q += `, width = $3, height = $4`
			args = append(args, info.Width, info.Height)
		}
		if _, err := tx.Exec(r.Context(), q+` WHERE id = $1`, args...); err != nil {
			return err
		}
		// ready once both files are in
		var ready bool
		if err := tx.QueryRow(r.Context(), `
			UPDATE photos SET status = 'ready'
			WHERE id = $1 AND status = 'uploading' AND display_key IS NOT NULL AND thumb_key IS NOT NULL
			RETURNING true`, id).Scan(&ready); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if ready {
			if err := refreshStats(r.Context(), tx, trail); err != nil {
				return err
			}
		}
		out, err = s.scanPhoto(tx.QueryRow(r.Context(), photoSelect+` WHERE p.id = $1`, id))
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if replaced != nil {
		s.removeUnusedFiles(r.Context(), []string{*replaced})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deletePhoto(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var keys []string
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner string
		var trail, display, thumb *string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id, display_key, thumb_key FROM photos WHERE id = $1 FOR UPDATE`, id).
			Scan(&owner, &trail, &display, &thumb)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if owner != c.UserID {
			return errForbidden
		}
		for _, k := range []*string{display, thumb} {
			if k != nil {
				keys = append(keys, *k)
			}
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM photos WHERE id = $1`, id); err != nil {
			return err
		}
		if err := refreshStats(r.Context(), tx, trail); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.removeUnusedFiles(r.Context(), keys)
	w.WriteHeader(http.StatusNoContent)
}

// removeUnusedFiles deletes photo files no photo refers to any more (the same bytes can be shared by two photos).
func (s *Server) removeUnusedFiles(ctx context.Context, keys []string) {
	for _, k := range keys {
		var used bool
		if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM photos WHERE display_key = $1 OR thumb_key = $1)`, k).Scan(&used); err != nil {
			slog.Error("check photo file", "key", k, "err", err)
			continue
		}
		if !used {
			if err := s.Store.Delete(ctx, k); err != nil {
				slog.Error("delete photo file", "key", k, "err", err)
			}
		}
	}
}
