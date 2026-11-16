// Package api is Switchback's HTTP API: accounts, reviews, hike logs, photos, trail submissions and reports.
package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"switchback/server/internal/auth"
	"switchback/server/internal/ratelimit"
	"switchback/server/internal/storage"
)

type Config struct {
	PublicURL string // e.g. https://api.example.com, used for photo links
	TrustCF   bool   // take the client IP from Cloudflare's CF-Connecting-IP header
}

type Server struct {
	// EmailKey keys the hash that stands in for email addresses. It must never change, or email sign-ins stop
	// matching their accounts.
	EmailKey []byte
	DB       *pgxpool.Pool
	Tokens   *auth.Signer
	Google   *auth.Google
	Mail     auth.Mailer
	Store    storage.Store
	Limit    *ratelimit.Limiter
	Cfg      Config
	// AdminToken lets the owner's review page approve submissions and hide photos. Empty turns the admin routes
	// off (they answer 404).
	AdminToken string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /v1/config", cached(3600, s.config))

	mux.HandleFunc("POST /v1/auth/email/start", s.emailStart)
	mux.HandleFunc("POST /v1/auth/email/verify", s.emailVerify)
	mux.HandleFunc("POST /v1/auth/google", s.googleSignIn)
	mux.HandleFunc("POST /v1/auth/register", s.register)
	mux.HandleFunc("POST /v1/auth/login", s.login)
	mux.HandleFunc("POST /v1/auth/refresh", s.refresh)
	mux.HandleFunc("POST /v1/auth/logout", s.logout)

	mux.HandleFunc("GET /v1/me", s.authed(s.getMe))
	mux.HandleFunc("PATCH /v1/me", s.authed(s.patchMe))
	mux.HandleFunc("DELETE /v1/me", s.authed(s.deleteMe))
	mux.HandleFunc("GET /v1/me/logs", s.authed(s.myLogs))
	mux.HandleFunc("GET /v1/me/submissions", s.authed(s.mySubmissions))
	mux.HandleFunc("GET /v1/me/photos", s.authed(s.myPhotos))
	mux.HandleFunc("POST /v1/me/password", s.authed(s.changePassword))
	mux.HandleFunc("GET /v1/me/docs/{collection}", s.authed(s.listDocs))
	mux.HandleFunc("PUT /v1/me/docs/{collection}/{id}", s.authed(s.putDoc))
	mux.HandleFunc("DELETE /v1/me/docs/{collection}/{id}", s.authed(s.deleteDoc))

	mux.HandleFunc("GET /v1/cells/{cell}/stats", cached(300, s.cellStats))
	mux.HandleFunc("GET /v1/trails/reviews", cached(60, s.trailReviews))
	mux.HandleFunc("GET /v1/trails/photos", cached(60, s.trailPhotos))
	mux.HandleFunc("GET /v1/users/{id}/logs", cached(60, s.userLogs))

	mux.HandleFunc("PUT /v1/reviews/{id}", s.authed(s.putReview))
	mux.HandleFunc("DELETE /v1/reviews/{id}", s.authed(s.deleteReview))
	mux.HandleFunc("PUT /v1/logs/{id}", s.authed(s.putLog))
	mux.HandleFunc("DELETE /v1/logs/{id}", s.authed(s.deleteLog))
	mux.HandleFunc("PUT /v1/photos/{id}", s.authed(s.putPhoto))
	mux.HandleFunc("PUT /v1/photos/{id}/file", s.authed(s.putPhotoFile))
	mux.HandleFunc("DELETE /v1/photos/{id}", s.authed(s.deletePhoto))
	mux.HandleFunc("PUT /v1/submissions/{id}", s.authed(s.putSubmission))
	mux.HandleFunc("POST /v1/reports", s.authed(s.postReport))

	mux.HandleFunc("GET /v1/admin/submissions", s.admin(s.adminSubmissions))
	mux.HandleFunc("POST /v1/admin/submissions/{id}", s.admin(s.reviewSubmission))
	mux.HandleFunc("GET /v1/admin/photos", s.admin(s.adminPhotos))
	mux.HandleFunc("POST /v1/admin/photos/{id}", s.admin(s.setPhotoStatus))

	mux.HandleFunc("GET /p/{key}", func(w http.ResponseWriter, r *http.Request) { s.Store.Serve(w, r, r.PathValue("key")) })
	return recoverer(cors(mux))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.DB.Ping(ctx); err != nil {
		http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte("ok\n"))
}

// MARK: responses

type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

func fail(status int, code, message string) *apiError {
	return &apiError{status: status, code: code, message: message}
}

var (
	errNotFound  = fail(http.StatusNotFound, "not_found", "Not found.")
	errForbidden = fail(http.StatusForbidden, "forbidden", "That isn't yours.")
	errSlowDown  = fail(http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again later.")
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeErr turns any error into a JSON error. Unexpected ones are logged and shown as 500.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeJSON(w, ae.status, map[string]any{"error": map[string]string{"code": ae.code, "message": ae.message}})
		return
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23503": // foreign key: e.g. the account was deleted while a token was still valid
			writeErr(w, r, fail(http.StatusConflict, "missing_reference", "Something this refers to no longer exists."))
			return
		case "23514", "22001", "22P05": // check constraint, value too long, text Postgres can't store (\u0000)
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "invalid", "Something in the request isn't valid."))
			return
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, r, errNotFound)
		return
	}
	slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "internal", "message": "Something went wrong."}})
}

// readJSON decodes a JSON body of at most 64 KB.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return fail(http.StatusBadRequest, "bad_json", "The request body isn't valid JSON.")
	}
	return nil
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil && v != http.ErrAbortHandler {
				slog.Error("panic", "path", r.URL.Path, "panic", fmt.Sprint(v))
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// MARK: caching

type recorder struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (r *recorder) Header() http.Header         { return r.header }
func (r *recorder) Write(b []byte) (int, error) { return r.buf.Write(b) }
func (r *recorder) WriteHeader(status int)      { r.status = status }

// cached marks a public GET as cacheable by Cloudflare and the app for maxAge seconds, with an ETag so an unchanged
// answer costs a tiny 304.
func cached(maxAge int, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rec := &recorder{header: http.Header{}, status: http.StatusOK}
		h(rec, r)
		for k, v := range rec.header {
			w.Header()[k] = v
		}
		if rec.status != http.StatusOK {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(rec.status)
			w.Write(rec.buf.Bytes())
			return
		}
		sum := sha256.Sum256(rec.buf.Bytes())
		etag := `"` + hex.EncodeToString(sum[:12]) + `"`
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(maxAge))
		if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write(rec.buf.Bytes())
	}
}

// MARK: auth and limits

type ctxKey struct{}

type caller struct {
	UserID    string
	SessionID string
}

func (s *Server) authed(h func(http.ResponseWriter, *http.Request, caller)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			writeErr(w, r, fail(http.StatusUnauthorized, "unauthorized", "Sign in first."))
			return
		}
		c, err := s.Tokens.Verify(token)
		if err != nil {
			writeErr(w, r, fail(http.StatusUnauthorized, "token_expired", "Your sign-in has expired."))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		h(w, r, caller{UserID: c.Sub, SessionID: c.Sid})
	}
}

func (s *Server) clientIP(r *http.Request) string {
	if s.Cfg.TrustCF {
		if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// allow applies a rate limit: burst actions per period, per key.
func (s *Server) allow(key string, burst int, period time.Duration) error {
	if !s.Limit.Allow(key, burst, period) {
		return errSlowDown
	}
	return nil
}

// MARK: ids, cursors and trail references

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func pathID(r *http.Request) (string, error) {
	id := r.PathValue("id")
	if !uuidRE.MatchString(id) {
		return "", fail(http.StatusBadRequest, "bad_id", "The id must be a UUID.")
	}
	return strings.ToLower(id), nil
}

func optUUID(s *string) error {
	if s != nil && !uuidRE.MatchString(*s) {
		return fail(http.StatusBadRequest, "bad_id", "Ids must be UUIDs.")
	}
	return nil
}

// cursor is "<unix micro>|<id>" for lists ordered newest first.
func encodeCursor(t time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(t.UnixMicro(), 10) + "|" + id))
}

func decodeCursor(s string) (time.Time, string, bool) {
	if s == "" {
		return time.Time{}, "", false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", false
	}
	ts, id, ok := strings.Cut(string(b), "|")
	us, err := strconv.ParseInt(ts, 10, 64)
	if !ok || err != nil || !uuidRE.MatchString(id) {
		return time.Time{}, "", false
	}
	return time.UnixMicro(us), id, true
}

// TrailRef is how the app tells the server which trail a post is about.
type TrailRef struct {
	ID    string     `json:"id"`
	Name  string     `json:"name"`
	Start [2]float64 `json:"start"` // lat, lon
	BBox  [4]float64 `json:"bbox"`  // south, west, north, east
}

const cellSize = 0.25

// cellKey matches the app's trail-pack cells: "<row>_<col>" of 0.25° squares.
func cellKey(lat, lon float64) string {
	return fmt.Sprintf("%d_%d", int(math.Floor(lat/cellSize)), int(math.Floor(lon/cellSize)))
}

var cellRE = regexp.MustCompile(`^-?\d{1,4}_-?\d{1,4}$`)

func validLatLon(lat, lon float64) bool {
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

func (t *TrailRef) validate() error {
	t.ID = strings.TrimSpace(t.ID)
	t.Name = strings.TrimSpace(t.Name)
	if t.ID == "" || len(t.ID) > 300 || len(t.Name) > 200 {
		return fail(http.StatusUnprocessableEntity, "bad_trail", "The trail reference isn't valid.")
	}
	b := t.BBox
	if !validLatLon(t.Start[0], t.Start[1]) || !validLatLon(b[0], b[1]) || !validLatLon(b[2], b[3]) ||
		b[0] > b[2] || b[1] > b[3] || b[2]-b[0] > 5 || b[3]-b[1] > 5 {
		return fail(http.StatusUnprocessableEntity, "bad_trail", "The trail's location isn't valid.")
	}
	return nil
}

// saveTrailRef records the trail the first time anything is posted about it.
func saveTrailRef(ctx context.Context, tx pgx.Tx, t TrailRef) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO trail_refs (trail_id, name, start_lat, start_lon, min_lat, min_lon, max_lat, max_lon, cell)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (trail_id) DO NOTHING`,
		t.ID, t.Name, t.Start[0], t.Start[1], t.BBox[0], t.BBox[1], t.BBox[2], t.BBox[3], cellKey(t.Start[0], t.Start[1]))
	return err
}

// refreshStats recounts one trail's numbers in the same transaction as the change.
func refreshStats(ctx context.Context, tx pgx.Tx, trailID *string) error {
	if trailID == nil {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO trail_stats (trail_id, cell, review_count, rating_sum, photo_count, hiker_count, last_review_at)
		SELECT t.trail_id, t.cell,
		       (SELECT count(*) FROM reviews r WHERE r.trail_id = t.trail_id AND NOT r.hidden),
		       (SELECT coalesce(sum(rating), 0) FROM reviews r WHERE r.trail_id = t.trail_id AND NOT r.hidden),
		       (SELECT count(*) FROM photos p WHERE p.trail_id = t.trail_id AND p.status = 'ready'),
		       (SELECT count(DISTINCT user_id) FROM hike_logs l WHERE l.trail_id = t.trail_id),
		       (SELECT max(created_at) FROM reviews r WHERE r.trail_id = t.trail_id AND NOT r.hidden)
		FROM trail_refs t WHERE t.trail_id = $1
		ON CONFLICT (trail_id) DO UPDATE SET
		    cell = excluded.cell, review_count = excluded.review_count, rating_sum = excluded.rating_sum,
		    photo_count = excluded.photo_count, hiker_count = excluded.hiker_count,
		    last_review_at = excluded.last_review_at`, *trailID)
	return err
}

// inTx runs f in a transaction.
func (s *Server) inTx(ctx context.Context, f func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.DB, f)
}

func (s *Server) photoURL(key *string) *string {
	if key == nil {
		return nil
	}
	u := strings.TrimRight(s.Cfg.PublicURL, "/") + "/p/" + *key
	return &u
}
