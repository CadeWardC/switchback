package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func init() { passwordCost = bcrypt.MinCost } // the tests check passwords many times

func errCode(t *testing.T, r resp) string {
	t.Helper()
	e, _ := r.json(t)["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func (e *env) expectErr(r resp, status int, code string) {
	e.t.Helper()
	e.expect(r, status)
	if got := errCode(e.t, r); got != code {
		e.t.Fatalf("error %q, want %q: %s", got, code, r.body)
	}
}

func (e *env) register(email, password, name string) account {
	e.t.Helper()
	m := e.expect(e.do("POST", "/v1/auth/register", "", map[string]string{"email": email, "password": password, "display_name": name, "device": "test"}), 200).json(e.t)
	if m["new_user"] != true || m["token_type"] != "Bearer" || m["expires_in"].(float64) <= 0 {
		e.t.Fatalf("register %v", m)
	}
	return account{m["user"].(map[string]any)["id"].(string), m["access_token"].(string), m["refresh_token"].(string)}
}

func TestPasswords(t *testing.T) {
	e := setup(t)
	reg := func(email, password string) resp {
		return e.do("POST", "/v1/auth/register", "", map[string]string{"email": email, "password": password})
	}
	login := func(email, password string) resp {
		return e.do("POST", "/v1/auth/login", "", map[string]string{"email": email, "password": password, "device": "test"})
	}

	e.expectErr(reg("nope", "long enough"), 422, "bad_email")
	e.expectErr(reg("ana@example.com", "short"), 422, "weak_password")
	e.expectErr(reg("ana@example.com", strings.Repeat("x", 201)), 422, "weak_password")
	ana := e.register("Ana@Example.com", "correct horse", "  Ana  ")
	me := e.expect(e.do("GET", "/v1/me", ana.access, nil), 200).json(t)
	if me["display_name"] != "Ana" || fmt.Sprint(me["sign_ins"]) != "[password]" {
		t.Fatalf("me %v", me)
	}
	if u := e.register("bo@example.com", strings.Repeat("é", 200), ""); u.id == ana.id {
		t.Fatal("same account")
	}
	e.expectErr(reg(" ANA@example.com ", "another password"), 409, "email_taken")
	cy := e.signIn("cy@example.com") // an email-code account: the email is taken too
	e.expectErr(reg("cy@example.com", "another password"), 409, "email_taken")

	// logging in: a wrong email and a wrong password get the same answer
	wrongPw := login("ana@example.com", "wrong horse")
	e.expectErr(wrongPw, 401, "wrong_login")
	noOne := login("nobody@example.com", "correct horse")
	e.expectErr(noOne, 401, "wrong_login")
	if !bytes.Equal(wrongPw.body, noOne.body) {
		t.Fatalf("answers differ: %s / %s", wrongPw.body, noOne.body)
	}
	e.expectErr(login("cy@example.com", "anything at all"), 401, "wrong_login") // no password on that account
	m := e.expect(login(" ana@EXAMPLE.com", "correct horse"), 200).json(t)
	if m["new_user"] != false || m["user"].(map[string]any)["id"] != ana.id || m["refresh_token"] == "" {
		t.Fatalf("login %v", m)
	}
	ana2 := account{ana.id, m["access_token"].(string), m["refresh_token"].(string)}

	// an email code for a password account's email makes a separate account: that email was never checked
	if other := e.signIn("ana@example.com"); other.id == ana.id {
		t.Fatal("an email-code sign-in was linked to a password account")
	}
	_ = cy

	// changing the password signs out the other devices
	pw := func(a account, cur, next string) resp {
		return e.do("POST", "/v1/me/password", a.access, map[string]string{"current_password": cur, "new_password": next})
	}
	e.expectErr(pw(ana2, "wrong horse", "battery staple"), 401, "wrong_password")
	e.expectErr(pw(ana2, "correct horse", "short"), 422, "weak_password")
	e.expectErr(pw(cy, "x", "battery staple"), 409, "no_password")
	e.expect(pw(ana2, "correct horse", "battery staple"), 204)
	e.expectErr(login("ana@example.com", "correct horse"), 401, "wrong_login")
	e.expect(login("ana@example.com", "battery staple"), 200)
	e.expect(e.do("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": ana.refresh}), 401)
	e.expect(e.do("POST", "/v1/auth/refresh", "", map[string]string{"refresh_token": ana2.refresh}), 200)

	// stored: a bcrypt hash, and no email address or password anywhere
	var hash []byte
	var subject string
	if err := e.pool.QueryRow(context.Background(), `SELECT subject, password_hash FROM identities WHERE user_id = $1`, ana.id).Scan(&subject, &hash); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(hash, []byte("$2a$")) || bytes.Contains(hash, []byte("staple")) || strings.Contains(subject, "@") {
		t.Fatalf("stored %q %q", subject, hash)
	}

	// too many tries for one email
	limited := false
	for i := 0; i < 12 && !limited; i++ {
		limited = login("bo@example.com", "guess "+fmt.Sprint(i)).status == 429
	}
	if !limited {
		t.Fatal("login isn't rate limited")
	}

	// deleting the account removes its password sign-in, so the email is free again
	e.expect(e.do("DELETE", "/v1/me", ana2.access, nil), 204)
	e.expectErr(login("ana@example.com", "battery staple"), 401, "wrong_login")
}

func TestDocs(t *testing.T) {
	e := setup(t)
	ana := e.register("ana@example.com", "correct horse", "Ana")
	bo := e.register("bo@example.com", "correct horse", "Bo")
	list := func(a account, c string, since *int64) (items []map[string]any, serverTime int64) {
		t.Helper()
		path := "/v1/me/docs/" + c
		if since != nil {
			path += fmt.Sprintf("?since=%d", *since)
		}
		var out struct {
			Items      []map[string]any `json:"items"`
			ServerTime int64            `json:"server_time"`
		}
		r := e.expect(e.do("GET", path, a.access, nil), 200)
		if err := json.Unmarshal(r.body, &out); err != nil || out.Items == nil || out.ServerTime == 0 {
			t.Fatalf("list %s: %v", r.body, err)
		}
		return out.Items, out.ServerTime
	}
	put := func(a account, c, id string, body any) int64 {
		t.Helper()
		m := e.expect(e.do("PUT", "/v1/me/docs/"+c+"/"+id, a.access, body), 200).json(t)
		if m["id"] != id || m["deleted"] != false {
			t.Fatalf("put %v", m)
		}
		return int64(m["updated_at"].(float64))
	}

	e.expect(e.do("GET", "/v1/me/docs/activities", "", nil), 401)
	e.expectErr(e.do("GET", "/v1/me/docs/bad%20name", ana.access, nil), 400, "bad_name")
	e.expectErr(e.do("PUT", "/v1/me/docs/activities/"+strings.Repeat("x", 129), ana.access, map[string]any{}), 400, "bad_name")
	e.expectErr(e.do("PUT", "/v1/me/docs/activities/a%2Fb", ana.access, map[string]any{}), 400, "bad_name")
	e.expectErr(e.do("GET", "/v1/me/docs/activities?since=soon", ana.access, nil), 400, "bad_since")
	e.expectErr(e.do("PUT", "/v1/me/docs/activities/w.1", ana.access, []byte(`{"v":`)), 400, "bad_json")

	items, start := list(ana, "activities", nil)
	if len(items) != 0 {
		t.Fatalf("new account has docs %v", items)
	}
	t1 := put(ana, "activities", "w.1", map[string]any{"v": 2, "walk": map[string]any{"name": "Ridge"}})
	t2 := put(ana, "activities", "w.2", map[string]any{"v": 2, "walk": map[string]any{"name": "Creek"}})
	put(ana, "saved_trails", "t.mn.r1", map[string]any{"v": 2, "trail": map[string]any{"id": "r1"}})
	if !(start < t1 && t1 < t2) {
		t.Fatalf("times don't increase: %d %d %d", start, t1, t2)
	}
	items, mid := list(ana, "activities", nil)
	if len(items) != 2 || items[0]["id"] != "w.1" || items[0]["data"].(map[string]any)["walk"].(map[string]any)["name"] != "Ridge" ||
		items[0]["deleted"] != false || int64(items[0]["updated_at"].(float64)) != t1 || mid < t2 {
		t.Fatalf("list %v %d", items, mid)
	}

	// changes since a list: the replaced doc and a tombstone
	put(ana, "activities", "w.1", map[string]any{"v": 2, "walk": map[string]any{"name": "Ridge again"}})
	d := e.expect(e.do("DELETE", "/v1/me/docs/activities/w.2", ana.access, nil), 200).json(t)
	if d["id"] != "w.2" || d["deleted"] != true || int64(d["updated_at"].(float64)) <= mid {
		t.Fatalf("delete %v", d)
	}
	items, last := list(ana, "activities", &mid)
	if len(items) != 2 || items[0]["id"] != "w.1" || items[1]["id"] != "w.2" || items[1]["deleted"] != true || items[1]["data"] != nil ||
		items[0]["data"].(map[string]any)["walk"].(map[string]any)["name"] != "Ridge again" {
		t.Fatalf("since %v", items)
	}
	if items, _ := list(ana, "activities", &last); len(items) != 0 {
		t.Fatalf("nothing changed, but got %v", items)
	}
	if items, _ := list(ana, "activities", nil); len(items) != 1 || items[0]["id"] != "w.1" {
		t.Fatalf("live docs %v", items)
	}
	if d := e.expect(e.do("DELETE", "/v1/me/docs/activities/never-was", ana.access, nil), 200).json(t); d["deleted"] != true {
		t.Fatalf("delete missing %v", d)
	}
	if items, _ := list(ana, "activities", &last); len(items) != 1 || items[0]["id"] != "never-was" {
		t.Fatalf("tombstone of a missing doc %v", items)
	}
	_, last = list(ana, "activities", nil)

	// another person sees none of it, and their doc with the same id is their own
	if items, _ := list(bo, "activities", nil); len(items) != 0 {
		t.Fatalf("bo sees %v", items)
	}
	put(bo, "activities", "w.1", []byte(`[1, 2, 3]`))
	if items, _ := list(ana, "activities", &last); len(items) != 0 {
		t.Fatalf("bo's write shows up for ana: %v", items)
	}
	if items, _ := list(bo, "activities", nil); len(items) != 1 || fmt.Sprint(items[0]["data"]) != "[1 2 3]" {
		t.Fatalf("bo's docs %v", items)
	}
	if items, _ := list(ana, "activities", nil); items[0]["data"].(map[string]any)["v"].(float64) != 2 {
		t.Fatalf("ana's doc changed: %v", items)
	}

	// up to 2 MB a document
	big := func(n int) []byte { return []byte(`"` + strings.Repeat("a", n-2) + `"`) }
	e.expect(e.do("PUT", "/v1/me/docs/activities/big", ana.access, big(2<<20)), 200)
	e.expectErr(e.do("PUT", "/v1/me/docs/activities/bigger", ana.access, big(2<<20+1)), 413, "too_large")
	e.expectErr(e.do("PUT", "/v1/me/docs/activities/nul", ana.access, []byte(`{"a":"\u0000"}`)), 422, "invalid")

	// deleting the account deletes its documents
	e.expect(e.do("DELETE", "/v1/me", bo.access, nil), 204)
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM user_docs WHERE user_id = $1`, bo.id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d docs left (%v)", n, err)
	}
}

// TestDocsSince writes from several goroutines while another keeps listing with ?since=: every write must turn up.
func TestDocsSince(t *testing.T) {
	e := setup(t)
	ana := e.register("ana@example.com", "correct horse", "Ana")
	call := func(method, path string, body []byte) (*http.Response, []byte, error) {
		req, _ := http.NewRequest(method, e.url+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+ana.access)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		return res, b, err
	}
	const writers, each = 4, 25
	var wg sync.WaitGroup
	errs := make(chan error, writers*each)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				res, b, err := call("PUT", fmt.Sprintf("/v1/me/docs/activities/w%d.%d", w, i), []byte(`{"n":1}`))
				if err == nil && res.StatusCode != 200 {
					err = fmt.Errorf("put: %d %s", res.StatusCode, b)
				}
				if err != nil {
					errs <- err
				}
			}
		}(w)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	seen := map[string]bool{}
	var since int64
	for finished := false; ; {
		select {
		case <-done:
			finished = true
		default:
		}
		_, b, err := call("GET", fmt.Sprintf("/v1/me/docs/activities?since=%d", since), nil)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			ServerTime int64 `json:"server_time"`
		}
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatalf("%v: %s", err, b)
		}
		for _, it := range out.Items {
			seen[it.ID] = true
		}
		since = out.ServerTime
		if finished {
			break // this list started after every write had finished
		}
	}
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(seen) != writers*each {
		t.Fatalf("saw %d of %d writes", len(seen), writers*each)
	}
}

const testAdminToken = "0123456789abcdef0123456789abcdef-test"

func TestAdminAndHikePhotos(t *testing.T) {
	off := setup(t)
	off.expect(off.do("GET", "/v1/admin/submissions", testAdminToken, nil), 404)

	e := setup(t, func(s *Server) { s.AdminToken = testAdminToken })
	ana := e.register("ana@example.com", "correct horse", "Ana")
	bo := e.register("bo@example.com", "correct horse", "Bo")

	// CORS for the review page
	pre := e.do("OPTIONS", "/v1/admin/submissions/"+uuid(), "", nil, "Origin", "https://example.org", "Access-Control-Request-Method", "POST")
	e.expect(pre, 204)
	if pre.header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(pre.header.Get("Access-Control-Allow-Headers"), "Authorization") ||
		!strings.Contains(pre.header.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight %v", pre.header)
	}
	if h := e.do("GET", "/v1/config", "", nil).header.Get("Access-Control-Allow-Origin"); h != "*" {
		t.Fatalf("no CORS header on GET: %q", h)
	}
	cfg := e.expect(e.do("GET", "/v1/config", "", nil), 200).json(t)
	if fmt.Sprint(cfg["photo"].(map[string]any)["formats"]) != "[heic jpeg]" {
		t.Fatalf("config %v", cfg)
	}

	// photos on a recorded hike (no trail), and on a trail
	e.expectErr(e.do("PUT", "/v1/photos/"+uuid(), ana.access, map[string]any{"walk_id": "w 1"}), 400, "bad_name")
	hikePhoto := uuid()
	p := e.expect(e.do("PUT", "/v1/photos/"+hikePhoto, ana.access, map[string]any{"walk_id": "w.abc", "lat": 44.97, "lon": -93.26}), 200).json(t)
	if p["walk_id"] != "w.abc" || p["trail_id"] != nil || p["status"] != "uploading" {
		t.Fatalf("hike photo %v", p)
	}
	e.expect(e.do("PUT", "/v1/photos/"+hikePhoto+"/file?size=display", ana.access, jpegBytes(t, 1000, 750, false)), 200)
	p = e.expect(e.do("PUT", "/v1/photos/"+hikePhoto+"/file?size=thumb", ana.access, jpegBytes(t, 533, 400, false)), 200).json(t)
	if p["status"] != "ready" || p["walk_id"] != "w.abc" {
		t.Fatalf("after upload %v", p)
	}
	trailPhoto := uuid()
	e.expect(e.do("PUT", "/v1/photos/"+trailPhoto, ana.access, map[string]any{"trail": trail, "walk_id": "w.def"}), 200)
	e.expect(e.do("PUT", "/v1/photos/"+trailPhoto+"/file?size=display", ana.access, jpegBytes(t, 1000, 1333, false)), 200)
	e.expect(e.do("PUT", "/v1/photos/"+trailPhoto+"/file?size=thumb", ana.access, jpegBytes(t, 400, 533, false)), 200)
	e.expect(e.do("PUT", "/v1/photos/"+uuid(), ana.access, map[string]any{"walk_id": "w.abc"}), 200) // not uploaded yet

	myPhotos := func(a account, query string) []any {
		t.Helper()
		return e.expect(e.do("GET", "/v1/me/photos"+query, a.access, nil), 200).json(t)["photos"].([]any)
	}
	if ps := myPhotos(ana, ""); len(ps) != 3 || ps[2].(map[string]any)["id"] != hikePhoto {
		t.Fatalf("my photos %v", ps)
	}
	if ps := myPhotos(ana, "?walk=w.abc"); len(ps) != 2 {
		t.Fatalf("hike photos %v", ps)
	}
	if ps := myPhotos(ana, "?walk=w.none"); len(ps) != 0 {
		t.Fatalf("other hike %v", ps)
	}
	if ps := myPhotos(bo, ""); len(ps) != 0 {
		t.Fatalf("bo sees %v", ps)
	}
	e.expectErr(e.do("GET", "/v1/me/photos?walk=a%20b", ana.access, nil), 400, "bad_name")

	// admin key
	e.expect(e.do("GET", "/v1/admin/submissions", "", nil), 401)
	e.expect(e.do("GET", "/v1/admin/submissions", testAdminToken+"x", nil), 401)
	e.expect(e.do("GET", "/v1/admin/submissions", ana.access, nil), 401)
	e.expectErr(e.do("GET", "/v1/admin/submissions?status=maybe", testAdminToken, nil), 400, "bad_status")

	// approving and rejecting submissions
	newTrail := uuid()
	e.expect(e.do("PUT", "/v1/submissions/"+newTrail, bo.access, map[string]any{"kind": "new_trail", "name": "Creek Spur", "difficulty": "easy", "line": "oenqG~yexPg^g^g^g^", "note": "New"}), 201)
	corr := uuid()
	e.expect(e.do("PUT", "/v1/submissions/"+corr, bo.access, map[string]any{"kind": "correction", "trail": trail, "field": "closed", "note": "Bridge out"}), 201)
	subs := e.expect(e.do("GET", "/v1/admin/submissions?status=pending", testAdminToken, nil), 200).json(t)["submissions"].([]any)
	if len(subs) != 2 {
		t.Fatalf("pending %v", subs)
	}
	nt := subs[1].(map[string]any)
	if nt["id"] != newTrail || nt["user_display_name"] != "Bo" || nt["line"] != "oenqG~yexPg^g^g^g^" || len(nt["box"].([]any)) != 4 || nt["user_id"] != bo.id {
		t.Fatalf("new trail submission %v", nt)
	}
	if c := subs[0].(map[string]any); c["trail_name"] != "Ridge Trail" || c["box"] != nil || c["field"] != "closed" {
		t.Fatalf("correction %v", c)
	}
	review := func(id, status, reply string) map[string]any {
		t.Helper()
		body := map[string]any{"status": status}
		if reply != "" {
			body["reply"] = reply
		}
		return e.expect(e.do("POST", "/v1/admin/submissions/"+id, testAdminToken, body), 200).json(t)
	}
	count := func(q, id string) int {
		t.Helper()
		var n int
		if err := e.pool.QueryRow(context.Background(), q, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const trailsQ = `SELECT count(*) FROM community_trails WHERE id = $1`
	const overridesQ = `SELECT count(*) FROM trail_overrides WHERE submission_id = $1`
	e.expectErr(e.do("POST", "/v1/admin/submissions/"+newTrail, testAdminToken, map[string]any{"status": "pending"}), 422, "bad_status")
	e.expect(e.do("POST", "/v1/admin/submissions/"+uuid(), testAdminToken, map[string]any{"status": "approved"}), 404)
	if s := review(newTrail, "approved", "Thanks!"); s["status"] != "approved" || s["reply"] != "Thanks!" || s["reviewed_at"] == nil {
		t.Fatalf("approved %v", s)
	}
	review(newTrail, "approved", "") // again: nothing changes, the reply stays
	if count(trailsQ, newTrail) != 1 {
		t.Fatal("approved trail isn't on the map")
	}
	review(corr, "approved", "")
	if count(overridesQ, corr) != 1 {
		t.Fatal("approved correction isn't applied")
	}
	cell := e.expect(e.do("GET", "/v1/cells/179_-374/stats", "", nil), 200).json(t)
	if o := cell["overrides"].([]any); len(o) != 1 || o[0].(map[string]any)["field"] != "closed" {
		t.Fatalf("cell overrides %v", cell)
	}
	mine := e.expect(e.do("GET", "/v1/me/submissions", bo.access, nil), 200).json(t)["submissions"].([]any)
	if mine[1].(map[string]any)["reply"] != "Thanks!" || mine[1].(map[string]any)["status"] != "approved" {
		t.Fatalf("bo's submissions %v", mine)
	}
	if s := review(newTrail, "rejected", "Sorry, it's private land"); s["status"] != "rejected" || count(trailsQ, newTrail) != 0 {
		t.Fatalf("rejected %v", s)
	}
	review(corr, "rejected", "")
	if count(overridesQ, corr) != 0 {
		t.Fatal("rejected correction still applied")
	}
	if subs := e.expect(e.do("GET", "/v1/admin/submissions?status=rejected", testAdminToken, nil), 200).json(t)["submissions"].([]any); len(subs) != 2 {
		t.Fatalf("rejected %v", subs)
	}
	if subs := e.expect(e.do("GET", "/v1/admin/submissions?status=approved", testAdminToken, nil), 200).json(t)["submissions"].([]any); len(subs) != 0 {
		t.Fatalf("approved %v", subs)
	}

	// taking a photo down, and putting it back
	ready := e.expect(e.do("GET", "/v1/admin/photos?status=ready", testAdminToken, nil), 200).json(t)["photos"].([]any)
	if len(ready) != 2 {
		t.Fatalf("ready photos %v", ready)
	}
	trailPath := "/v1/trails/photos?trail=" + strings.ReplaceAll(trail["id"].(string), " ", "%20")
	if n := len(e.expect(e.do("GET", trailPath, "", nil), 200).json(t)["photos"].([]any)); n != 1 {
		t.Fatalf("%d trail photos", n)
	}
	if p := e.expect(e.do("POST", "/v1/admin/photos/"+trailPhoto, testAdminToken, map[string]string{"status": "hidden"}), 200).json(t); p["status"] != "hidden" {
		t.Fatalf("hidden %v", p)
	}
	if n := len(e.expect(e.do("GET", trailPath, "", nil), 200).json(t)["photos"].([]any)); n != 0 {
		t.Fatalf("hidden photo still listed (%d)", n)
	}
	if hidden := e.expect(e.do("GET", "/v1/admin/photos?status=hidden", testAdminToken, nil), 200).json(t)["photos"].([]any); len(hidden) != 1 {
		t.Fatalf("hidden photos %v", hidden)
	}
	if all := e.expect(e.do("GET", "/v1/admin/photos?status=all", testAdminToken, nil), 200).json(t)["photos"].([]any); len(all) != 3 {
		t.Fatalf("all photos %v", all)
	}
	e.expectErr(e.do("POST", "/v1/admin/photos/"+trailPhoto, testAdminToken, map[string]string{"status": "gone"}), 422, "bad_status")
	e.expect(e.do("POST", "/v1/admin/photos/"+trailPhoto, testAdminToken, map[string]string{"status": "ready"}), 200)
	if n := len(e.expect(e.do("GET", trailPath, "", nil), 200).json(t)["photos"].([]any)); n != 1 {
		t.Fatalf("photo not back (%d)", n)
	}
	e.expect(e.do("POST", "/v1/admin/photos/"+uuid(), testAdminToken, map[string]string{"status": "hidden"}), 404)
}
