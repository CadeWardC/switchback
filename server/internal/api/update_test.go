package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"switchback/server/internal/ratelimit"
)

// The review page's Server tab: what is running, what is published, and asking for an update. No database needed.
func TestAdminUpdate(t *testing.T) {
	const mine = "1111111111111111111111111111111111111111111111111111111111111111"
	const theirs = "2222222222222222222222222222222222222222222222222222222222222222"
	published := theirs
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api.sha256":
			_, _ = w.Write([]byte(published + "  switchback-api-linux-arm64\n"))
		case "/notes":
			_, _ = w.Write([]byte(`{"body":"built from main @ abc1234","assets":[{"name":"api","updated_at":"2026-11-16T12:00:00Z"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gh.Close()

	dir := t.TempDir()
	token := strings.Repeat("k", 40)
	s := &Server{AdminToken: token, Limit: ratelimit.New(), Update: Update{
		Version: "old1234", SHA256: mine, Started: time.Now(), StatusFile: filepath.Join(dir, "status.json"),
		BinaryURL: gh.URL + "/api", NotesURL: gh.URL + "/notes",
	}}
	h := s.Handler()
	call := func(method, path, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	// only the owner
	if code, _ := call("GET", "/v1/admin/update", ""); code != 401 {
		t.Fatalf("without the key: %d", code)
	}
	if code, _ := call("POST", "/v1/admin/update", "wrong"); code != 401 {
		t.Fatalf("with a wrong key: %d", code)
	}

	// where the updater isn't set up: the version shows, a check works, an update is refused
	code, d := call("GET", "/v1/admin/update", token)
	if code != 200 || d["version"] != "old1234" || d["can_update"] != false || d["latest"] != nil || d["status"] != nil {
		t.Fatalf("state %d %v", code, d)
	}
	code, d = call("GET", "/v1/admin/update?check=1", token)
	latest, _ := d["latest"].(map[string]any)
	if code != 200 || d["update_available"] != true || latest["sha256"] != theirs || latest["notes"] != "built from main @ abc1234" ||
		latest["published_at"] != "2026-11-16T12:00:00Z" {
		t.Fatalf("check %d %v", code, d)
	}
	if code, _ := call("POST", "/v1/admin/update", token); code != 409 {
		t.Fatalf("update where it isn't set up: %d", code)
	}

	// set up: asking leaves the request file for the machine's updater, and nothing else
	s.Update.Dir = filepath.Join(dir, "update")
	if err := os.Mkdir(s.Update.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	code, d = call("POST", "/v1/admin/update", token)
	if code != 202 || d["can_update"] != true || d["requested"] != true {
		t.Fatalf("update %d %v", code, d)
	}
	if _, err := os.Stat(filepath.Join(s.Update.Dir, "request")); err != nil {
		t.Fatal("no request file was left")
	}

	// the updater takes the request away and says how it went; once the published file is the running one, it's up to date
	_ = os.Remove(filepath.Join(s.Update.Dir, "request"))
	_ = os.WriteFile(s.Update.StatusFile, []byte(`{"state":"ok","message":"Updated to version abc1234","at":"2026-11-16T12:05:00Z"}`), 0o644)
	published = mine
	code, d = call("GET", "/v1/admin/update?check=1", token)
	st, _ := d["status"].(map[string]any)
	if code != 200 || d["requested"] != false || d["update_available"] != false || st["state"] != "ok" || st["message"] != "Updated to version abc1234" {
		t.Fatalf("after %d %v", code, d)
	}

	// a checksum that isn't one is an error to show, not an update
	published = "not a checksum"
	if _, d = call("GET", "/v1/admin/update?check=1", token); d["check_error"] == nil || d["update_available"] != nil {
		t.Fatalf("bad checksum %v", d)
	}
}
