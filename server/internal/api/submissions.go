package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	correctionFields = []string{"name", "closed", "seasonal_closure", "difficulty", "trailhead", "not_exists", "other"}
	difficulties     = []string{"easy", "moderate", "hard", "very_hard"}
)

func oneOf(s string, list []string) bool {
	for _, x := range list {
		if s == x {
			return true
		}
	}
	return false
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"photo": map[string]any{
			"format":             "heic",
			"formats":            []string{"heic", "jpeg"}, // either is accepted; the files are stored as sent
			"display_short_side": displayShortSide,
			"thumb_short_side":   thumbShortSide,
			"max_display_bytes":  maxDisplayBytes,
			"max_thumb_bytes":    maxThumbBytes,
		},
		"conditions":        conditionNames,
		"correction_fields": correctionFields,
		"difficulties":      difficulties,
		"licences": map[string]string{
			"data":   "ODbL-1.0",
			"photos": "CC-BY-SA-4.0",
		},
	})
}

// decodePolyline reads a Google encoded polyline (5 decimal places), as the app writes them.
func decodePolyline(s string) ([][2]float64, bool) {
	var out [][2]float64
	var lat, lon int
	i := 0
	next := func() (int, bool) {
		result, shift := 0, 0
		for {
			if i >= len(s) {
				return 0, false
			}
			b := int(s[i]) - 63
			i++
			if b < 0 || b > 63 {
				return 0, false
			}
			result |= (b & 0x1f) << shift
			shift += 5
			if b < 0x20 {
				break
			}
			if shift > 30 {
				return 0, false
			}
		}
		if result&1 != 0 {
			return ^(result >> 1), true
		}
		return result >> 1, true
	}
	for i < len(s) {
		dlat, ok1 := next()
		dlon, ok2 := next()
		if !ok1 || !ok2 {
			return nil, false
		}
		lat += dlat
		lon += dlon
		p := [2]float64{float64(lat) / 1e5, float64(lon) / 1e5}
		if !validLatLon(p[0], p[1]) {
			return nil, false
		}
		out = append(out, p)
	}
	return out, true
}

type submissionOut struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Status     string     `json:"status"`
	TrailID    *string    `json:"trail_id"`
	Field      *string    `json:"field"`
	Value      *string    `json:"value"`
	Note       string     `json:"note"`
	Name       *string    `json:"name"`
	Difficulty *string    `json:"difficulty"`
	Line       *string    `json:"line"`
	Reply      string     `json:"reply"`
	ReviewedAt *time.Time `json:"reviewed_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

const submissionSelect = `
	SELECT id, kind, status, trail_id, field, value, note, name, difficulty, line, reply, reviewed_at, created_at
	FROM trail_submissions`

func scanSubmission(row pgx.Row) (submissionOut, error) {
	var o submissionOut
	err := row.Scan(&o.ID, &o.Kind, &o.Status, &o.TrailID, &o.Field, &o.Value, &o.Note, &o.Name, &o.Difficulty, &o.Line,
		&o.Reply, &o.ReviewedAt, &o.CreatedAt)
	return o, err
}

// putSubmission sends a new trail or a correction (a problem with a trail) to the review queue. It can be changed until it's reviewed.
func (s *Server) putSubmission(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Kind       string    `json:"kind"`
		Trail      *TrailRef `json:"trail"`
		Field      *string   `json:"field"`
		Value      *string   `json:"value"`
		Note       string    `json:"note"`
		Name       *string   `json:"name"`
		Difficulty *string   `json:"difficulty"`
		Line       *string   `json:"line"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	in.Note = strings.TrimSpace(in.Note)
	if len([]rune(in.Note)) > 2000 {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "too_long", "Notes are up to 2,000 characters."))
		return
	}
	if in.Difficulty != nil && !oneOf(*in.Difficulty, difficulties) {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_difficulty", "Unknown difficulty."))
		return
	}
	var box [4]float64
	var cell *string
	switch in.Kind {
	case "new_trail":
		if in.Name == nil || strings.TrimSpace(*in.Name) == "" || len([]rune(*in.Name)) > 120 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_name", "A new trail needs a name (up to 120 characters)."))
			return
		}
		n := strings.TrimSpace(*in.Name)
		in.Name = &n
		if in.Line == nil || len(*in.Line) > 200000 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_line", "A new trail needs its line."))
			return
		}
		pts, ok := decodePolyline(*in.Line)
		if !ok || len(pts) < 2 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_line", "The trail line isn't valid."))
			return
		}
		box = [4]float64{pts[0][0], pts[0][1], pts[0][0], pts[0][1]}
		for _, p := range pts {
			box[0], box[1] = min(box[0], p[0]), min(box[1], p[1])
			box[2], box[3] = max(box[2], p[0]), max(box[3], p[1])
		}
		if box[2]-box[0] > 2 || box[3]-box[1] > 2 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_line", "That trail is too long to be one trail."))
			return
		}
		k := cellKey(pts[0][0], pts[0][1])
		cell = &k
		in.Trail, in.Field, in.Value = nil, nil, nil
	case "correction":
		if in.Trail == nil {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_trail", "A correction needs the trail."))
			return
		}
		if err := in.Trail.validate(); err != nil {
			writeErr(w, r, err)
			return
		}
		if in.Field == nil || !oneOf(*in.Field, correctionFields) {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_field", "Unknown kind of correction."))
			return
		}
		if in.Value != nil && len([]rune(*in.Value)) > 500 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "too_long", "Values are up to 500 characters."))
			return
		}
		// the walked line may come with it (the hiker chose to send it, to show what is wrong); it is only kept for
		// the reviewer to look at
		if in.Line != nil {
			if pts, ok := decodePolyline(*in.Line); !ok || len(pts) < 2 || len(*in.Line) > 200000 {
				writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_line", "The line isn't valid."))
				return
			}
		}
		in.Name = nil
	default:
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_kind", "kind is new_trail or correction."))
		return
	}
	created := false
	var out submissionOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner, status string
		err := tx.QueryRow(r.Context(), `SELECT user_id, status FROM trail_submissions WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &status)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := s.allow("submit:"+c.UserID, 10, 24*time.Hour); err != nil {
				return err
			}
			created = true
		case err != nil:
			return err
		case owner != c.UserID:
			return errForbidden
		case status != "pending":
			return fail(http.StatusConflict, "already_reviewed", "This has already been reviewed, so it can't be changed.")
		}
		var trailID *string
		if in.Trail != nil {
			if err := saveTrailRef(r.Context(), tx, *in.Trail); err != nil {
				return err
			}
			trailID = &in.Trail.ID
		}
		var b []any
		if cell != nil {
			b = []any{box[0], box[1], box[2], box[3]}
		} else {
			b = []any{nil, nil, nil, nil}
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO trail_submissions (id, user_id, kind, trail_id, field, value, note, name, difficulty, line,
			                               min_lat, min_lon, max_lat, max_lon, cell)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			ON CONFLICT (id) DO UPDATE SET kind = $3, trail_id = $4, field = $5, value = $6, note = $7, name = $8,
			    difficulty = $9, line = $10, min_lat = $11, min_lon = $12, max_lat = $13, max_lon = $14, cell = $15`,
			id, c.UserID, in.Kind, trailID, in.Field, in.Value, in.Note, in.Name, in.Difficulty, in.Line,
			b[0], b[1], b[2], b[3], cell)
		if err != nil {
			return err
		}
		out, err = scanSubmission(tx.QueryRow(r.Context(), submissionSelect+` WHERE id = $1`, id))
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, out)
}

func (s *Server) mySubmissions(w http.ResponseWriter, r *http.Request, c caller) {
	rows, err := s.DB.Query(r.Context(), submissionSelect+` WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, c.UserID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out := []submissionOut{}
	for rows.Next() {
		o, err := scanSubmission(rows)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, map[string]any{"submissions": out})
}

// reportsToHide is how many different people must report a review or photo before it's hidden until checked.
const reportsToHide = 3

func (s *Server) postReport(w http.ResponseWriter, r *http.Request, c caller) {
	var in struct {
		TargetKind string `json:"target_kind"`
		TargetID   string `json:"target_id"`
		Reason     string `json:"reason"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	switch {
	case !oneOf(in.TargetKind, []string{"review", "photo", "user", "submission"}):
		err := fail(http.StatusUnprocessableEntity, "bad_kind", "target_kind is review, photo, user or submission.")
		writeErr(w, r, err)
		return
	case !uuidRE.MatchString(in.TargetID):
		writeErr(w, r, fail(http.StatusBadRequest, "bad_id", "target_id must be a UUID."))
		return
	case len([]rune(in.Reason)) > 500:
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "too_long", "Reasons are up to 500 characters."))
		return
	}
	if err := s.allow("report:"+c.UserID, 20, 24*time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	err := s.inTx(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO reports (reporter, target_kind, target_id, reason) VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING`, c.UserID, in.TargetKind, in.TargetID, in.Reason)
		if err != nil || tag.RowsAffected() == 0 {
			return err // already reported by this person: nothing more to do
		}
		var n int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM reports WHERE target_kind = $1 AND target_id = $2 AND status = 'open'`,
			in.TargetKind, in.TargetID).Scan(&n); err != nil {
			return err
		}
		if n < reportsToHide {
			return nil
		}
		var trail *string
		switch in.TargetKind {
		case "review":
			err = tx.QueryRow(r.Context(), `UPDATE reviews SET hidden = true WHERE id = $1 AND NOT hidden RETURNING trail_id`,
				in.TargetID).Scan(&trail)
		case "photo":
			err = tx.QueryRow(r.Context(), `UPDATE photos SET status = 'hidden' WHERE id = $1 AND status <> 'hidden' RETURNING trail_id`,
				in.TargetID).Scan(&trail)
		default:
			return nil // users and submissions wait for a person to look
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		return refreshStats(r.Context(), tx, trail)
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
