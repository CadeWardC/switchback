package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Updating the server from the review page.
//
// The API runs as an account that can't touch its own program, so it doesn't update itself. Asked to (POST
// /v1/admin/update), it leaves an empty file, "request", in Update.Dir. On the Pi, systemd watches for that file and
// runs deploy/switchback-update.sh as root, which downloads the published release (always the same address: nothing
// in the request says what to install), checks it against its checksum, swaps it in, restarts the API, puts the
// previous program back if the new one doesn't answer, and writes how it went to Update.StatusFile.
//
// Checking (GET /v1/admin/update?check=1) compares this program's own SHA-256 with the published one.

// Update is what the review page's Server tab needs. The zero value shows the running version and nothing else.
type Update struct {
	// Version is what this build calls itself (the commit it was built from); SHA256 is this program's own file.
	Version string
	SHA256  string
	Started time.Time
	// Dir is where the request file goes; empty when updating from the page isn't set up on this machine.
	Dir string
	// StatusFile is where the updater writes how the last update went.
	StatusFile string
	// BinaryURL is the published program; its checksum is at BinaryURL + ".sha256". NotesURL (optional) is GitHub's
	// description of the release, as JSON.
	BinaryURL string
	NotesURL  string
	// Client makes the two requests (http.DefaultClient with a timeout when nil).
	Client *http.Client
}

var sha256RE = regexp.MustCompile(`^[0-9a-f]{64}$`)

type updateStatus struct {
	State   string `json:"state"` // running, ok or failed
	Message string `json:"message"`
	At      string `json:"at"`
}

type updateLatest struct {
	SHA256      string  `json:"sha256"`
	Notes       *string `json:"notes"`
	PublishedAt *string `json:"published_at"`
}

type updateOut struct {
	Version   string    `json:"version"`
	SHA256    string    `json:"sha256"`
	StartedAt time.Time `json:"started_at"`
	// CanUpdate: the updater is set up on this machine.
	CanUpdate bool `json:"can_update"`
	// Requested: an update has been asked for and hasn't been picked up yet.
	Requested bool          `json:"requested"`
	Status    *updateStatus `json:"status"`
	// Only with ?check=1.
	Latest          *updateLatest `json:"latest,omitempty"`
	UpdateAvailable *bool         `json:"update_available,omitempty"`
	CheckError      *string       `json:"check_error,omitempty"`
}

func (u *Update) requestFile() string { return filepath.Join(u.Dir, "request") }

// canUpdate says whether the request folder is there (the Pi's setup makes it).
func (u *Update) canUpdate() bool {
	if u.Dir == "" || u.BinaryURL == "" {
		return false
	}
	st, err := os.Stat(u.Dir)
	return err == nil && st.IsDir()
}

func (u *Update) status() *updateStatus {
	if u.StatusFile == "" {
		return nil
	}
	b, err := os.ReadFile(u.StatusFile)
	if err != nil || len(b) > 4096 {
		return nil
	}
	var st updateStatus
	if json.Unmarshal(b, &st) != nil || st.State == "" {
		return nil
	}
	return &st
}

func (u *Update) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	client := u.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "switchback-api")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// latest asks what is published: its checksum, and (if GitHub answers) what it was built from and when.
func (u *Update) latest(ctx context.Context) (*updateLatest, error) {
	b, err := u.get(ctx, u.BinaryURL+".sha256", 1024)
	if err != nil {
		return nil, err
	}
	sum, _, _ := strings.Cut(strings.TrimSpace(string(b)), " ")
	if !sha256RE.MatchString(sum) {
		return nil, errors.New("the published checksum isn't a SHA-256")
	}
	out := &updateLatest{SHA256: sum}
	if u.NotesURL != "" {
		if b, err := u.get(ctx, u.NotesURL, 1<<20); err == nil {
			var rel struct {
				Body   string `json:"body"`
				Assets []struct {
					Name      string `json:"name"`
					UpdatedAt string `json:"updated_at"`
				} `json:"assets"`
			}
			if json.Unmarshal(b, &rel) == nil {
				if n := strings.TrimSpace(rel.Body); n != "" {
					if len(n) > 500 {
						n = n[:500]
					}
					out.Notes = &n
				}
				for _, a := range rel.Assets {
					if a.Name == filepath.Base(u.BinaryURL) && a.UpdatedAt != "" {
						at := a.UpdatedAt
						out.PublishedAt = &at
					}
				}
			}
		}
	}
	return out, nil
}

func (s *Server) updateState() updateOut {
	u := &s.Update
	out := updateOut{Version: u.Version, SHA256: u.SHA256, StartedAt: u.Started, CanUpdate: u.canUpdate(), Status: u.status()}
	if out.CanUpdate {
		_, err := os.Stat(u.requestFile())
		out.Requested = err == nil
	}
	return out
}

// adminUpdate tells the review page what is running and how the last update went; with ?check=1 it also looks at
// what is published.
func (s *Server) adminUpdate(w http.ResponseWriter, r *http.Request) {
	out := s.updateState()
	if r.URL.Query().Get("check") == "1" {
		if err := s.allow("admin-update-check", 30, time.Hour); err != nil {
			writeErr(w, r, err)
			return
		}
		if s.Update.BinaryURL == "" {
			msg := "This server doesn't know where its updates are published."
			out.CheckError = &msg
		} else if latest, err := s.Update.latest(r.Context()); err != nil {
			msg := "Couldn't reach the published version: " + err.Error()
			out.CheckError = &msg
		} else {
			out.Latest = latest
			newer := s.Update.SHA256 != "" && latest.SHA256 != s.Update.SHA256
			out.UpdateAvailable = &newer
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// adminStartUpdate asks the machine's updater to install the published version.
func (s *Server) adminStartUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.Update.canUpdate() {
		writeErr(w, r, fail(http.StatusConflict, "not_set_up",
			"Updating from this page isn't set up on the server yet. Run the install command on it once more."))
		return
	}
	if err := s.allow("admin-update", 6, time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := os.WriteFile(s.Update.requestFile(), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, s.updateState())
}
