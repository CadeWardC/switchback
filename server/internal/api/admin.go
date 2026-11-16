package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The owner's review page (served at /review) uses these. It unlocks with ADMIN_PIN, which buys a session key good
// for 12 hours; ADMIN_TOKEN itself works too. Without ADMIN_TOKEN none of this exists.

//go:embed review.html
var reviewPage []byte

// MinPIN and MaxPIN bound ADMIN_PIN: digits only. Guesses are limited to 5 per 15 minutes from one address and 20
// an hour from everywhere, so even a 6-digit PIN would take years to guess.
const MinPIN, MaxPIN = 6, 12

var pinRE = regexp.MustCompile(`^[0-9]{6,12}$`)

// ValidPIN says whether a PIN is usable as ADMIN_PIN.
func ValidPIN(p string) bool { return pinRE.MatchString(p) }

const adminSessionLife = 12 * time.Hour

// adminSessionKey signs review-page sessions: changing the PIN or the admin token ends every session.
func (s *Server) adminSessionKey() []byte {
	k := sha256.Sum256([]byte("switchback-admin-session|" + s.AdminToken + "|" + s.AdminPIN))
	return k[:]
}

func (s *Server) newAdminSession(now time.Time) string {
	exp := strconv.FormatInt(now.Add(adminSessionLife).Unix(), 10)
	m := hmac.New(sha256.New, s.adminSessionKey())
	m.Write([]byte(exp))
	return "pin." + exp + "." + hex.EncodeToString(m.Sum(nil))
}

func (s *Server) validAdminSession(tok string, now time.Time) bool {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] != "pin" || s.AdminPIN == "" {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || now.Unix() >= exp {
		return false
	}
	sig, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, s.adminSessionKey())
	m.Write([]byte(parts[1]))
	return hmac.Equal(sig, m.Sum(nil))
}

// reviewPageHandler serves the review page. It holds no secrets; everything it shows needs the PIN.
func (s *Server) reviewPageHandler(w http.ResponseWriter, r *http.Request) {
	if len(s.AdminToken) < MinAdminToken {
		writeErr(w, r, errNotFound)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "+
		"style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://tile.openstreetmap.org "+
		"https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	_, _ = w.Write(reviewPage)
}

// adminLogin trades the PIN for a session key.
func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	if len(s.AdminToken) < MinAdminToken || s.AdminPIN == "" {
		writeErr(w, r, errNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if err := s.allow("admin-pin:"+s.clientIP(r), 5, 15*time.Minute); err != nil {
		writeErr(w, r, fail(http.StatusTooManyRequests, "slow_down", "Too many tries. Wait 15 minutes and try again."))
		return
	}
	if err := s.allow("admin-pin-all", 20, time.Hour); err != nil {
		writeErr(w, r, fail(http.StatusTooManyRequests, "slow_down", "Too many tries. Wait an hour and try again."))
		return
	}
	var in struct {
		PIN string `json:"pin"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	got, want := sha256.Sum256([]byte(strings.TrimSpace(in.PIN))), sha256.Sum256([]byte(s.AdminPIN))
	if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
		writeErr(w, r, fail(http.StatusUnauthorized, "wrong_pin", "That PIN isn't right."))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": s.newAdminSession(time.Now()), "expires_in": int(adminSessionLife.Seconds())})
}

// MinAdminToken is the shortest ADMIN_TOKEN the server accepts.
const MinAdminToken = 32

func (s *Server) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(s.AdminToken) < MinAdminToken {
			writeErr(w, r, errNotFound)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		// compare digests so neither the content nor the length of the token leaks through timing
		got, want := sha256.Sum256([]byte(token)), sha256.Sum256([]byte(s.AdminToken))
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 && !s.validAdminSession(token, time.Now()) {
			if err := s.allow("admin-fail:"+s.clientIP(r), 20, 10*time.Minute); err != nil {
				writeErr(w, r, err)
				return
			}
			writeErr(w, r, fail(http.StatusUnauthorized, "unauthorized", "Enter the PIN again."))
			return
		}
		h(w, r)
	}
}

// cors lets the review page call the API from wherever it's opened. Nothing uses cookies, so this gives a web page
// no more than it could get with the same token anyway.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
		h.Set("Access-Control-Expose-Headers", "ETag")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type adminSubmissionOut struct {
	submissionOut
	UserID          string      `json:"user_id"`
	UserDisplayName string      `json:"user_display_name"`
	TrailName       *string     `json:"trail_name"`
	Box             *[4]float64 `json:"box"` // south, west, north, east (new trails)
}

const adminSubmissionSelect = `
	SELECT s.id, s.kind, s.status, s.trail_id, s.field, s.value, s.note, s.name, s.difficulty, s.line, s.reply,
	       s.reviewed_at, s.created_at, s.user_id, u.display_name, t.name, s.min_lat, s.min_lon, s.max_lat, s.max_lon
	FROM trail_submissions s JOIN users u ON u.id = s.user_id LEFT JOIN trail_refs t ON t.trail_id = s.trail_id`

func scanAdminSubmission(row pgx.Row) (adminSubmissionOut, error) {
	var o adminSubmissionOut
	var box [4]*float64
	err := row.Scan(&o.ID, &o.Kind, &o.Status, &o.TrailID, &o.Field, &o.Value, &o.Note, &o.Name, &o.Difficulty, &o.Line,
		&o.Reply, &o.ReviewedAt, &o.CreatedAt, &o.UserID, &o.UserDisplayName, &o.TrailName, &box[0], &box[1], &box[2], &box[3])
	if box[0] != nil && box[1] != nil && box[2] != nil && box[3] != nil {
		o.Box = &[4]float64{*box[0], *box[1], *box[2], *box[3]}
	}
	return o, err
}

func (s *Server) adminSubmissions(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	where, args := ``, []any{}
	switch status {
	case "all":
	case "pending", "approved", "rejected":
		where, args = ` WHERE s.status = $1`, []any{status}
	default:
		writeErr(w, r, fail(http.StatusBadRequest, "bad_status", "status is pending, approved, rejected or all."))
		return
	}
	rows, err := s.DB.Query(r.Context(), adminSubmissionSelect+where+` ORDER BY s.created_at DESC, s.id DESC LIMIT 1000`, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out := []adminSubmissionOut{}
	for rows.Next() {
		o, err := scanAdminSubmission(rows)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submissions": out})
}

// reviewSubmission approves or rejects a submission. Approving puts a new trail on the map or applies a correction;
// rejecting (even after approving) takes it off again.
func (s *Server) reviewSubmission(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Status string  `json:"status"`
		Reply  *string `json:"reply"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if in.Status != "approved" && in.Status != "rejected" {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_status", "status is approved or rejected."))
		return
	}
	if in.Reply != nil {
		reply := strings.TrimSpace(*in.Reply)
		if len([]rune(reply)) > 2000 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "too_long", "Replies are up to 2,000 characters."))
			return
		}
		in.Reply = &reply
	}
	var out adminSubmissionOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var kind string
		if err := tx.QueryRow(r.Context(), `SELECT kind FROM trail_submissions WHERE id = $1 FOR UPDATE`, id).Scan(&kind); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE trail_submissions SET status = $2, reply = coalesce($3, reply), reviewed_at = now() WHERE id = $1`,
			id, in.Status, in.Reply); err != nil {
			return err
		}
		var q string
		switch {
		case in.Status == "approved" && kind == "new_trail":
			q = `INSERT INTO community_trails (id, name, difficulty, line, min_lat, min_lon, max_lat, max_lon, cell, submitted_by)
			     SELECT id, name, difficulty, line, min_lat, min_lon, max_lat, max_lon, cell, user_id
			     FROM trail_submissions WHERE id = $1
			     ON CONFLICT (id) DO NOTHING`
		case in.Status == "approved" && kind == "correction":
			// the latest approved correction of a trail's field wins
			q = `INSERT INTO trail_overrides (trail_id, field, value, submission_id)
			     SELECT trail_id, field, coalesce(value, ''), id FROM trail_submissions WHERE id = $1
			     ON CONFLICT (trail_id, field) DO UPDATE SET value = excluded.value, submission_id = excluded.submission_id,
			         created_at = now()`
		case kind == "new_trail":
			q = `DELETE FROM community_trails WHERE id = $1`
		default:
			q = `DELETE FROM trail_overrides WHERE submission_id = $1`
		}
		if _, err := tx.Exec(r.Context(), q, id); err != nil {
			return err
		}
		var err error
		out, err = scanAdminSubmission(tx.QueryRow(r.Context(), adminSubmissionSelect+` WHERE s.id = $1`, id))
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) adminPhotos(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "all"
	}
	where, args := ``, []any{}
	switch status {
	case "all":
	case "ready", "hidden", "uploading":
		where, args = ` WHERE p.status = $1`, []any{status}
	default:
		writeErr(w, r, fail(http.StatusBadRequest, "bad_status", "status is ready, hidden, uploading or all."))
		return
	}
	s.writePhotos(w, r, photoSelect+where+` ORDER BY p.created_at DESC, p.id DESC LIMIT 1000`, args...)
}

// setPhotoStatus hides a photo (or shows it again). Open reports about it are closed, since a person has decided.
func (s *Server) setPhotoStatus(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if in.Status != "ready" && in.Status != "hidden" {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_status", "status is ready or hidden."))
		return
	}
	var out photoOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var trail, display, thumb *string
		if err := tx.QueryRow(r.Context(), `SELECT trail_id, display_key, thumb_key FROM photos WHERE id = $1 FOR UPDATE`, id).
			Scan(&trail, &display, &thumb); err != nil {
			return err
		}
		if in.Status == "ready" && (display == nil || thumb == nil) {
			return fail(http.StatusConflict, "not_uploaded", "This photo's files haven't all been uploaded yet.")
		}
		if _, err := tx.Exec(r.Context(), `UPDATE photos SET status = $2 WHERE id = $1`, id, in.Status); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE reports SET status = 'closed' WHERE target_kind = 'photo' AND target_id = $1 AND status = 'open'`, id); err != nil {
			return err
		}
		if err := refreshStats(r.Context(), tx, trail); err != nil {
			return err
		}
		var err error
		out, err = s.scanPhoto(tx.QueryRow(r.Context(), photoSelect+` WHERE p.id = $1`, id))
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// adminReviews lists trail reviews, newest first: ?status=shown, hidden or all (the default).
func (s *Server) adminReviews(w http.ResponseWriter, r *http.Request) {
	where, args := ``, []any{}
	switch r.URL.Query().Get("status") {
	case "", "all":
	case "shown":
		where = ` WHERE NOT r.hidden`
	case "hidden":
		where = ` WHERE r.hidden`
	default:
		writeErr(w, r, fail(http.StatusBadRequest, "bad_status", "status is shown, hidden or all."))
		return
	}
	s.writeAdminReviews(w, r, where, args...)
}

type adminReviewOut struct {
	reviewOut
	TrailName string `json:"trail_name"`
	Hidden    bool   `json:"hidden"`
}

func (s *Server) writeAdminReviews(w http.ResponseWriter, r *http.Request, where string, args ...any) {
	rows, err := s.DB.Query(r.Context(), `
		SELECT r.id, r.trail_id, r.user_id, u.display_name, r.rating, r.body, r.hiked_on, r.conditions,
		       coalesce((SELECT array_agg(p.id::text ORDER BY p.created_at) FROM photos p WHERE p.review_id = r.id AND p.status = 'ready'), '{}'),
		       r.created_at, r.updated_at, coalesce(t.name, ''), r.hidden
		FROM reviews r JOIN users u ON u.id = r.user_id LEFT JOIN trail_refs t ON t.trail_id = r.trail_id`+where+`
		ORDER BY r.created_at DESC, r.id DESC LIMIT 1000`, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out := []adminReviewOut{}
	for rows.Next() {
		var o adminReviewOut
		if err := rows.Scan(&o.ID, &o.TrailID, &o.UserID, &o.DisplayName, &o.Rating, &o.Body, &o.hikedOn, &o.Conditions,
			&o.PhotoIDs, &o.CreatedAt, &o.UpdatedAt, &o.TrailName, &o.Hidden); err != nil {
			writeErr(w, r, err)
			return
		}
		if o.hikedOn != nil {
			d := o.hikedOn.Format("2006-01-02")
			o.HikedOn = &d
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviews": out})
}

// setReviewHidden hides a review (or shows it again) and recounts its trail's numbers.
func (s *Server) setReviewHidden(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var in struct {
		Hidden bool `json:"hidden"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var trail string
		if err := tx.QueryRow(r.Context(), `UPDATE reviews SET hidden = $2 WHERE id = $1 RETURNING trail_id`, id, in.Hidden).Scan(&trail); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE reports SET status = 'closed' WHERE target_kind = 'review' AND target_id = $1 AND status = 'open'`, id); err != nil {
			return err
		}
		return refreshStats(r.Context(), tx, &trail)
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "hidden": in.Hidden})
}
