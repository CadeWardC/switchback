package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"switchback/server/internal/auth"
	"switchback/server/internal/db"
	"switchback/server/internal/ratelimit"
	"switchback/server/internal/storage"
)

// Run with a throwaway database:
//
//	TEST_DATABASE_URL=postgres://switchback:test@localhost/switchback_test go test ./...
//
// The test wipes and recreates the database's public schema.

type codeMailer struct {
	mu    sync.Mutex
	codes map[string]string
}

func (m *codeMailer) SendCode(_ context.Context, to, code string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.codes[to] = code
	return nil
}

type env struct {
	pool  *pgxpool.Pool
	t     *testing.T
	url   string
	mail  *codeMailer
	store storage.Disk
}

// setup starts a server on a fresh database; opts can change its settings first.
func setup(t *testing.T, opts ...func(*Server)) *env {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, dsn, 5)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	signer, _ := auth.NewSigner(bytes.Repeat([]byte{7}, 32), 15*time.Minute)
	mail := &codeMailer{codes: map[string]string{}}
	store := storage.Disk{Dir: t.TempDir()}
	srv := &Server{EmailKey: bytes.Repeat([]byte{9}, 32), DB: pool, Tokens: signer, Google: auth.NewGoogle(nil), Mail: mail, Store: store,
		Limit: ratelimit.New(), Cfg: Config{PublicURL: "https://api.test"}}
	for _, o := range opts {
		o(srv)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &env{pool: pool, t: t, url: ts.URL, mail: mail, store: store}
}

type resp struct {
	status int
	header http.Header
	body   []byte
}

func (r resp) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("not JSON (%d): %s", r.status, r.body)
	}
	return m
}

func (e *env) do(method, path, token string, body any, headers ...string) resp {
	e.t.Helper()
	var rd io.Reader
	ctype := "application/json"
	switch b := body.(type) {
	case nil:
	case []byte:
		rd, ctype = bytes.NewReader(b), "application/octet-stream"
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, e.url+path, rd)
	req.Header.Set("Content-Type", ctype)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return resp{res.StatusCode, res.Header, b}
}

func (e *env) expect(r resp, status int) resp {
	e.t.Helper()
	if r.status != status {
		e.t.Fatalf("status %d, want %d: %s", r.status, status, r.body)
	}
	return r
}

type account struct {
	id, access, refresh string
}

func (e *env) signIn(email string) account {
	e.t.Helper()
	e.expect(e.do("POST", "/v1/auth/email/start", "", map[string]string{"email": email}), 204)
	code := e.mail.codes[strings.ToLower(email)]
	m := e.expect(e.do("POST", "/v1/auth/email/verify", "", map[string]string{"email": email, "code": code, "device": "test"}), 200).json(e.t)
	return account{m["user"].(map[string]any)["id"].(string), m["access_token"].(string), m["refresh_token"].(string)}
}

var trail = map[string]any{"id": "w Ridge Trail-44.970,-93.260", "name": "Ridge Trail",
	"start": []float64{44.97, -93.26}, "bbox": []float64{44.96, -93.27, 44.98, -93.25}}

func uuid() string { return auth.NewUUIDv7() }

func jpegBytes(t *testing.T, w, h int, exif bool) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y += 7 {
		for x := 0; x < w; x += 7 {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 60}); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	if exif {
		seg := append([]byte{0xFF, 0xE1, 0x00, 0x10}, []byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08")...)
		b = append(append(append([]byte{}, b[:2]...), seg...), b[2:]...)
	}
	return b
}

func TestEverything(t *testing.T) {
	e := setup(t)

	// sign in by email code
	e.expect(e.do("POST", "/v1/auth/email/start", "", map[string]string{"email": "nope"}), 422)
	e.expect(e.do("POST", "/v1/auth/email/start", "", map[string]string{"email": "Ana@Example.com"}), 204)
	e.expect(e.do("POST", "/v1/auth/email/verify", "", map[string]string{"email": "ana@example.com", "code": "000000x"}), 401)
	ana := e.signIn("ana@example.com")
	bo := e.signIn("bo@example.com")
	cy := e.signIn("cy@example.com")
	dee := e.signIn("dee@example.com")
	if again := e.signIn("ana@example.com"); again.id != ana.id {
		t.Fatal("signing in again made a new account")
	}
	me := e.expect(e.do("GET", "/v1/me", ana.access, nil), 200).json(t)
	if me["display_name"] != "Hiker" || len(me["sign_ins"].([]any)) != 1 || strings.Contains(string(e.do("GET", "/v1/me", ana.access, nil).body), "example.com") {
		t.Fatalf("me %v", me)
	}
	e.expect(e.do("GET", "/v1/me", "", nil), 401)
	e.expect(e.do("GET", "/v1/me", "garbage", nil), 401)
	e.expect(e.do("PATCH", "/v1/me", ana.access, map[string]string{"display_name": "  Ana   R  "}), 200)

	// refresh tokens rotate: the old one stops working
	m := e.expect(e.do("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": ana.refresh}), 200).json(t)
	e.expect(e.do("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": ana.refresh}), 401)
	ana.access, ana.refresh = m["access_token"].(string), m["refresh_token"].(string)

	// reviews
	rid := uuid()
	review := map[string]any{"trail": trail, "rating": 5, "body": "Lovely ridge.", "hiked_on": "2026-10-01", "conditions": []string{"muddy"}}
	e.expect(e.do("PUT", "/v1/reviews/"+rid, ana.access, review), 201)
	review["rating"] = 4
	r := e.expect(e.do("PUT", "/v1/reviews/"+rid, ana.access, review), 200).json(t)
	if r["rating"].(float64) != 4 || r["display_name"] != "Ana R" {
		t.Fatalf("edited review %v", r)
	}
	e.expect(e.do("PUT", "/v1/reviews/"+rid, bo.access, review), 403)
	e.expect(e.do("PUT", "/v1/reviews/"+uuid(), ana.access, review), 409) // one review per trail each
	review["rating"] = 2
	e.expect(e.do("PUT", "/v1/reviews/"+uuid(), bo.access, review), 201)
	bad := map[string]any{"trail": trail, "rating": 9}
	e.expect(e.do("PUT", "/v1/reviews/"+uuid(), cy.access, bad), 422)
	bad = map[string]any{"trail": trail, "rating": 3, "conditions": []string{"lava"}}
	e.expect(e.do("PUT", "/v1/reviews/"+uuid(), cy.access, bad), 422)

	path := "/v1/trails/reviews?trail=" + strings.ReplaceAll(trail["id"].(string), " ", "%20")
	res := e.expect(e.do("GET", path, "", nil), 200)
	list := res.json(t)
	if n := len(list["reviews"].([]any)); n != 2 {
		t.Fatalf("%d reviews", n)
	}
	if st := list["stats"].(map[string]any); st["rating"].(float64) != 3 || st["reviews"].(float64) != 2 {
		t.Fatalf("stats %v", st)
	}
	if !strings.Contains(res.header.Get("Cache-Control"), "max-age=60") {
		t.Fatalf("cache header %q", res.header.Get("Cache-Control"))
	}
	e.expect(e.do("GET", path, "", nil, "If-None-Match", res.header.Get("ETag")), 304)

	// the map's per-cell numbers (44.97 / 0.25 = 179.88, -93.26 / 0.25 = -373.04)
	cell := e.expect(e.do("GET", "/v1/cells/179_-374/stats", "", nil), 200).json(t)
	if trails := cell["trails"].([]any); len(trails) != 1 || trails[0].(map[string]any)["rating"].(float64) != 3 {
		t.Fatalf("cell %v", cell)
	}
	e.expect(e.do("GET", "/v1/cells/nope/stats", "", nil), 400)

	// hike logs
	lid := uuid()
	e.expect(e.do("PUT", "/v1/logs/"+lid, ana.access, map[string]any{"trail": trail, "hiked_on": "2026-10-01", "note": "Windy", "public": true}), 201)
	e.expect(e.do("PUT", "/v1/logs/"+uuid(), ana.access, map[string]any{"trail": trail, "hiked_on": "2026-09-01"}), 201)
	e.expect(e.do("PUT", "/v1/logs/"+uuid(), ana.access, map[string]any{"trail": trail}), 422)
	if logs := e.expect(e.do("GET", "/v1/me/logs", ana.access, nil), 200).json(t)["logs"].([]any); len(logs) != 2 {
		t.Fatalf("my logs %v", logs)
	}
	pub := e.expect(e.do("GET", "/v1/users/"+ana.id+"/logs", "", nil), 200).json(t)
	if logs := pub["logs"].([]any); len(logs) != 1 || logs[0].(map[string]any)["note"] != "Windy" {
		t.Fatalf("public logs %v", pub)
	}

	// photos: record, then the two files
	pid := uuid()
	e.expect(e.do("PUT", "/v1/photos/"+pid, ana.access, map[string]any{"trail": trail, "review_id": rid, "lat": 44.971234, "lon": -93.259876}), 200)
	e.expect(e.do("PUT", "/v1/photos/"+pid, bo.access, map[string]any{"trail": trail}), 403)
	e.expect(e.do("PUT", "/v1/photos/"+uuid(), bo.access, map[string]any{"review_id": rid}), 403) // not bo's review
	e.expect(e.do("PUT", "/v1/photos/"+pid+"/file?size=display", ana.access, jpegBytes(t, 1000, 1333, true)), 422)
	e.expect(e.do("PUT", "/v1/photos/"+pid+"/file?size=display", ana.access, jpegBytes(t, 1600, 2000, false)), 422)
	e.expect(e.do("PUT", "/v1/photos/"+pid+"/file?size=display", ana.access, []byte("hello")), 415)
	p := e.expect(e.do("PUT", "/v1/photos/"+pid+"/file?size=display", ana.access, jpegBytes(t, 1000, 1333, false)), 200).json(t)
	if p["status"] != "uploading" || p["width"].(float64) != 1000 {
		t.Fatalf("after display %v", p)
	}
	p = e.expect(e.do("PUT", "/v1/photos/"+pid+"/file?size=thumb", ana.access, jpegBytes(t, 400, 533, false)), 200).json(t)
	if p["status"] != "ready" || p["lat"].(float64) != 44.9712 {
		t.Fatalf("after thumb %v", p)
	}
	key := strings.TrimPrefix(p["url"].(string), "https://api.test")
	file := e.expect(e.do("GET", key, "", nil), 200)
	if !strings.Contains(file.header.Get("Cache-Control"), "immutable") || file.header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("photo headers %v", file.header)
	}
	photos := e.expect(e.do("GET", "/v1/trails/photos?trail="+strings.ReplaceAll(trail["id"].(string), " ", "%20"), "", nil), 200).json(t)
	if n := len(photos["photos"].([]any)); n != 1 {
		t.Fatalf("%d trail photos", n)
	}
	r = e.expect(e.do("GET", path, "", nil), 200).json(t)
	if ids := r["reviews"].([]any)[1].(map[string]any)["photo_ids"].([]any); len(ids) != 1 && len(r["reviews"].([]any)[0].(map[string]any)["photo_ids"].([]any)) != 1 {
		t.Fatalf("review photos %v", r)
	}

	// trail submissions
	sub := map[string]any{"kind": "new_trail", "name": "Creek Spur", "difficulty": "easy", "line": "oenqG~yexPg^g^g^g^", "note": "New this year"}
	s := e.expect(e.do("PUT", "/v1/submissions/"+uuid(), bo.access, sub), 201).json(t)
	if s["status"] != "pending" {
		t.Fatalf("submission %v", s)
	}
	sub["line"] = "!!!"
	e.expect(e.do("PUT", "/v1/submissions/"+uuid(), bo.access, sub), 422)
	corr := map[string]any{"kind": "correction", "trail": trail, "field": "closed", "note": "Bridge out"}
	e.expect(e.do("PUT", "/v1/submissions/"+uuid(), bo.access, corr), 201)
	if subs := e.expect(e.do("GET", "/v1/me/submissions", bo.access, nil), 200).json(t)["submissions"].([]any); len(subs) != 2 {
		t.Fatalf("submissions %v", subs)
	}

	// three reports hide a review
	for _, a := range []account{ana, cy, dee} {
		e.expect(e.do("POST", "/v1/reports", a.access, map[string]any{"target_kind": "review", "target_id": rid, "reason": "spam"}), 204)
	}
	list = e.expect(e.do("GET", path, "", nil), 200).json(t)
	if n := len(list["reviews"].([]any)); n != 1 {
		t.Fatalf("hidden review still listed: %d", n)
	}

	// deleting the account removes its posts and photo files
	// no email address is stored anywhere
	var stored int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM identities WHERE position('example.com' in encode(email_hash, 'escape')) > 0 OR subject LIKE '%@%'`).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("an email address was stored (%d, %v)", stored, err)
	}

	e.expect(e.do("DELETE", "/v1/me", ana.access, nil), 204)
	e.expect(e.do("GET", key, "", nil), 404)
	cell = e.expect(e.do("GET", "/v1/cells/179_-374/stats", "", nil), 200).json(t)
	tr := cell["trails"].([]any)[0].(map[string]any)
	if tr["photos"].(float64) != 0 || tr["hikers"].(float64) != 0 || tr["rating"].(float64) != 2 {
		t.Fatalf("stats after delete %v", tr)
	}
	e.expect(e.do("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": ana.refresh}), 401)
}

func TestCellKey(t *testing.T) {
	for _, c := range []struct {
		lat, lon float64
		want     string
	}{{44.97, -93.26, "179_-374"}, {0, 0, "0_0"}, {-0.1, -0.1, "-1_-1"}, {38.25, -90.5, "153_-362"}} {
		if got := cellKey(c.lat, c.lon); got != c.want {
			t.Errorf("cellKey(%v, %v) = %s, want %s", c.lat, c.lon, got, c.want)
		}
	}
}

func TestPolyline(t *testing.T) {
	// Google's documented example
	pts, ok := decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
	if !ok || len(pts) != 3 || pts[0] != [2]float64{38.5, -120.2} || pts[2] != [2]float64{43.252, -126.453} {
		t.Fatalf("got %v %v", pts, ok)
	}
	if _, ok := decodePolyline("_p~iF~ps|U_"); ok {
		t.Fatal("accepted a cut-off line")
	}
}
