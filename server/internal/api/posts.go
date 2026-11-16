package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var conditionNames = []string{"great", "muddy", "snow", "ice", "overgrown", "blowdown", "washed_out", "flooded",
	"closed", "bugs", "crowded"}

func validConditions(list []string) bool {
	if len(list) > len(conditionNames) {
		return false
	}
	for _, c := range list {
		ok := false
		for _, n := range conditionNames {
			if c == n {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func parseDay(s *string) (*time.Time, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	t, err := time.Parse("2006-01-02", *s)
	if err != nil || t.After(time.Now().Add(48*time.Hour)) || t.Year() < 1950 {
		return nil, fail(http.StatusUnprocessableEntity, "bad_date", "Dates are YYYY-MM-DD and not in the future.")
	}
	return &t, nil
}

// MARK: reviews

type reviewOut struct {
	ID          string    `json:"id"`
	TrailID     string    `json:"trail_id"`
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Rating      int16     `json:"rating"`
	Body        string    `json:"body"`
	HikedOn     *string   `json:"hiked_on"`
	Conditions  []string  `json:"conditions"`
	PhotoIDs    []string  `json:"photo_ids"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	hikedOn     *time.Time
}

const reviewSelect = `
	SELECT r.id, r.trail_id, r.user_id, u.display_name, r.rating, r.body, r.hiked_on, r.conditions,
	       coalesce((SELECT array_agg(p.id::text ORDER BY p.created_at) FROM photos p WHERE p.review_id = r.id AND p.status = 'ready'), '{}'),
	       r.created_at, r.updated_at
	FROM reviews r JOIN users u ON u.id = r.user_id`

func scanReview(row pgx.Row) (reviewOut, error) {
	var o reviewOut
	err := row.Scan(&o.ID, &o.TrailID, &o.UserID, &o.DisplayName, &o.Rating, &o.Body, &o.hikedOn, &o.Conditions,
		&o.PhotoIDs, &o.CreatedAt, &o.UpdatedAt)
	if o.hikedOn != nil {
		d := o.hikedOn.Format("2006-01-02")
		o.HikedOn = &d
	}
	return o, err
}

func (s *Server) trailReviews(w http.ResponseWriter, r *http.Request) {
	trail := r.URL.Query().Get("trail")
	if trail == "" {
		writeErr(w, r, fail(http.StatusBadRequest, "no_trail", "Add ?trail=<trail id>."))
		return
	}
	args := []any{trail}
	where := `WHERE r.trail_id = $1 AND NOT r.hidden`
	if t, id, ok := decodeCursor(r.URL.Query().Get("cursor")); ok {
		where += ` AND (r.created_at, r.id) < ($2, $3)`
		args = append(args, t, id)
	}
	rows, err := s.DB.Query(r.Context(), reviewSelect+" "+where+` ORDER BY r.created_at DESC, r.id DESC LIMIT 21`, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	reviews := []reviewOut{}
	for rows.Next() {
		o, err := scanReview(rows)
		if err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		reviews = append(reviews, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	var cursor *string
	if len(reviews) == 21 {
		reviews = reviews[:20]
		c := encodeCursor(reviews[19].CreatedAt, reviews[19].ID)
		cursor = &c
	}
	var count, sum, photos, hikers int
	err = s.DB.QueryRow(r.Context(), `SELECT review_count, rating_sum, photo_count, hiker_count FROM trail_stats WHERE trail_id = $1`,
		trail).Scan(&count, &sum, &photos, &hikers)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stats":   statsOut(count, sum, photos, hikers),
		"reviews": reviews,
		"cursor":  cursor,
	})
}

func statsOut(count, sum, photos, hikers int) map[string]any {
	var avg *float64
	if count > 0 {
		a := float64(int(float64(sum)/float64(count)*10+0.5)) / 10
		avg = &a
	}
	return map[string]any{"reviews": count, "rating": avg, "photos": photos, "hikers": hikers}
}

func (s *Server) putReview(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Trail      TrailRef `json:"trail"`
		Rating     int16    `json:"rating"`
		Body       string   `json:"body"`
		HikedOn    *string  `json:"hiked_on"`
		Conditions []string `json:"conditions"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Conditions == nil {
		in.Conditions = []string{}
	}
	hikedOn, err := parseDay(in.HikedOn)
	switch {
	case err != nil:
	case in.Rating < 1 || in.Rating > 5:
		err = fail(http.StatusUnprocessableEntity, "bad_rating", "Ratings are 1 to 5 stars.")
	case len([]rune(in.Body)) > 4000:
		err = fail(http.StatusUnprocessableEntity, "too_long", "Reviews are up to 4,000 characters.")
	case !validConditions(in.Conditions):
		err = fail(http.StatusUnprocessableEntity, "bad_conditions", "Unknown trail condition.")
	default:
		err = in.Trail.validate()
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	created := false
	var out reviewOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner, trail string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id FROM reviews WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &trail)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := s.allow("review:"+c.UserID, 20, 24*time.Hour); err != nil {
				return err
			}
			var existing string
			err := tx.QueryRow(r.Context(), `SELECT id FROM reviews WHERE user_id = $1 AND trail_id = $2`, c.UserID, in.Trail.ID).Scan(&existing)
			if err == nil {
				return fail(http.StatusConflict, "already_reviewed", "You've already reviewed this trail (review "+existing+"). Edit that one.")
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err := saveTrailRef(r.Context(), tx, in.Trail); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO reviews (id, user_id, trail_id, rating, body, hiked_on, conditions) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				id, c.UserID, in.Trail.ID, in.Rating, in.Body, hikedOn, in.Conditions); err != nil {
				return err
			}
			created = true
		case err != nil:
			return err
		case owner != c.UserID:
			return errForbidden
		case trail != in.Trail.ID:
			return fail(http.StatusConflict, "trail_changed", "A review can't move to another trail.")
		default:
			if _, err := tx.Exec(r.Context(), `
				UPDATE reviews SET rating = $2, body = $3, hiked_on = $4, conditions = $5, updated_at = now() WHERE id = $1`,
				id, in.Rating, in.Body, hikedOn, in.Conditions); err != nil {
				return err
			}
		}
		if err := refreshStats(r.Context(), tx, &in.Trail.ID); err != nil {
			return err
		}
		out, err = scanReview(tx.QueryRow(r.Context(), reviewSelect+` WHERE r.id = $1`, id))
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

func (s *Server) deleteReview(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner, trail string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id FROM reviews WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &trail)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // already gone: deleting twice is fine
		}
		if err != nil {
			return err
		}
		if owner != c.UserID {
			return errForbidden
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM reviews WHERE id = $1`, id); err != nil {
			return err
		}
		if err := refreshStats(r.Context(), tx, &trail); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MARK: hike logs

type logOut struct {
	ID        string    `json:"id"`
	TrailID   string    `json:"trail_id"`
	TrailName string    `json:"trail_name"`
	HikedOn   string    `json:"hiked_on"`
	HikeID    *string   `json:"hike_id"`
	Note      string    `json:"note"`
	Public    bool      `json:"public"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	hikedOn   time.Time
}

const logSelect = `
	SELECT l.id, l.trail_id, t.name, l.hiked_on, l.hike_id, l.note, l.public, l.created_at, l.updated_at
	FROM hike_logs l JOIN trail_refs t ON t.trail_id = l.trail_id`

func scanLog(row pgx.Row) (logOut, error) {
	var o logOut
	err := row.Scan(&o.ID, &o.TrailID, &o.TrailName, &o.hikedOn, &o.HikeID, &o.Note, &o.Public, &o.CreatedAt, &o.UpdatedAt)
	o.HikedOn = o.hikedOn.Format("2006-01-02")
	return o, err
}

func (s *Server) putLog(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Trail   TrailRef `json:"trail"`
		HikedOn *string  `json:"hiked_on"`
		HikeID  *string  `json:"hike_id"`
		Note    string   `json:"note"`
		Public  bool     `json:"public"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	in.Note = strings.TrimSpace(in.Note)
	hikedOn, err := parseDay(in.HikedOn)
	switch {
	case err != nil:
	case hikedOn == nil:
		err = fail(http.StatusUnprocessableEntity, "bad_date", "hiked_on is required.")
	case len([]rune(in.Note)) > 500:
		err = fail(http.StatusUnprocessableEntity, "too_long", "Notes are up to 500 characters.")
	default:
		if err = optUUID(in.HikeID); err == nil {
			err = in.Trail.validate()
		}
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	created := false
	var out logOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner, trail string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id FROM hike_logs WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &trail)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := s.allow("log:"+c.UserID, 50, 24*time.Hour); err != nil {
				return err
			}
			if err := saveTrailRef(r.Context(), tx, in.Trail); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO hike_logs (id, user_id, trail_id, hiked_on, hike_id, note, public) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				id, c.UserID, in.Trail.ID, hikedOn, in.HikeID, in.Note, in.Public); err != nil {
				return err
			}
			created = true
		case err != nil:
			return err
		case owner != c.UserID:
			return errForbidden
		case trail != in.Trail.ID:
			return fail(http.StatusConflict, "trail_changed", "A hike log can't move to another trail.")
		default:
			if _, err := tx.Exec(r.Context(), `
				UPDATE hike_logs SET hiked_on = $2, hike_id = $3, note = $4, public = $5, updated_at = now() WHERE id = $1`,
				id, hikedOn, in.HikeID, in.Note, in.Public); err != nil {
				return err
			}
		}
		if err := refreshStats(r.Context(), tx, &in.Trail.ID); err != nil {
			return err
		}
		out, err = scanLog(tx.QueryRow(r.Context(), logSelect+` WHERE l.id = $1`, id))
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

func (s *Server) deleteLog(w http.ResponseWriter, r *http.Request, c caller) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var owner, trail string
		err := tx.QueryRow(r.Context(), `SELECT user_id, trail_id FROM hike_logs WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &trail)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if owner != c.UserID {
			return errForbidden
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM hike_logs WHERE id = $1`, id); err != nil {
			return err
		}
		if err := refreshStats(r.Context(), tx, &trail); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listLogs pages through hike logs, newest hike first. The cursor holds the hike date and id.
func (s *Server) listLogs(w http.ResponseWriter, r *http.Request, userID string, publicOnly bool) {
	args := []any{userID}
	where := ` WHERE l.user_id = $1`
	if publicOnly {
		where += ` AND l.public`
	}
	if t, id, ok := decodeCursor(r.URL.Query().Get("cursor")); ok {
		where += ` AND (l.hiked_on, l.id) < ($2::date, $3)`
		args = append(args, t.UTC().Format("2006-01-02"), id)
	}
	rows, err := s.DB.Query(r.Context(), logSelect+where+` ORDER BY l.hiked_on DESC, l.id DESC LIMIT 51`, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	logs := []logOut{}
	for rows.Next() {
		o, err := scanLog(rows)
		if err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		logs = append(logs, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	var cursor *string
	if len(logs) == 51 {
		logs = logs[:50]
		c := encodeCursor(logs[49].hikedOn, logs[49].ID)
		cursor = &c
	}
	out := map[string]any{"logs": logs, "cursor": cursor}
	if publicOnly {
		var name string
		if err := s.DB.QueryRow(r.Context(), `SELECT display_name FROM users WHERE id = $1`, userID).Scan(&name); err != nil {
			writeErr(w, r, err)
			return
		}
		out["display_name"] = name
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) myLogs(w http.ResponseWriter, r *http.Request, c caller) {
	s.listLogs(w, r, c.UserID, false)
}

func (s *Server) userLogs(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.listLogs(w, r, id, true)
}

// MARK: cells

// cellStats is what the map needs for one 0.25° cell: every trail's numbers, approved corrections and community
// trails. One cached request per cell on screen.
func (s *Server) cellStats(w http.ResponseWriter, r *http.Request) {
	cell := r.PathValue("cell")
	if !cellRE.MatchString(cell) {
		writeErr(w, r, fail(http.StatusBadRequest, "bad_cell", "Cells are <row>_<col>."))
		return
	}
	ctx := r.Context()
	trails := []map[string]any{}
	rows, err := s.DB.Query(ctx, `
		SELECT trail_id, review_count, rating_sum, photo_count, hiker_count FROM trail_stats
		WHERE cell = $1 AND (review_count > 0 OR photo_count > 0 OR hiker_count > 0) ORDER BY trail_id`, cell)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	for rows.Next() {
		var id string
		var count, sum, photos, hikers int
		if err := rows.Scan(&id, &count, &sum, &photos, &hikers); err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		t := statsOut(count, sum, photos, hikers)
		t["trail_id"] = id
		trails = append(trails, t)
	}
	rows.Close()

	overrides := []map[string]string{}
	rows, err = s.DB.Query(ctx, `
		SELECT o.trail_id, o.field, o.value FROM trail_overrides o JOIN trail_refs t ON t.trail_id = o.trail_id
		WHERE t.cell = $1 ORDER BY o.trail_id, o.field`, cell)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	for rows.Next() {
		var id, field, value string
		if err := rows.Scan(&id, &field, &value); err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		overrides = append(overrides, map[string]string{"trail_id": id, "field": field, "value": value})
	}
	rows.Close()

	community := []map[string]any{}
	rows, err = s.DB.Query(ctx, `SELECT id, name, difficulty, line FROM community_trails WHERE cell = $1 ORDER BY id`, cell)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	for rows.Next() {
		var id, name, line string
		var difficulty *string
		if err := rows.Scan(&id, &name, &difficulty, &line); err != nil {
			rows.Close()
			writeErr(w, r, err)
			return
		}
		community = append(community, map[string]any{"id": id, "name": name, "difficulty": difficulty, "line": line})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cell": cell, "trails": trails, "overrides": overrides, "community_trails": community,
	})
}
