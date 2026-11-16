package api

import (
	"context"
	"crypto/hmac"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"switchback/server/internal/auth"
)

const (
	codeTTL     = 10 * time.Minute
	codeTries   = 5
	sessionTTL  = 90 * 24 * time.Hour
	maxDeviceLn = 80
)

var emailRE = regexp.MustCompile(`^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$`)

type userOut struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type tokensOut struct {
	AccessToken  string  `json:"access_token"`
	TokenType    string  `json:"token_type"`
	ExpiresIn    int     `json:"expires_in"`
	RefreshToken string  `json:"refresh_token"`
	User         userOut `json:"user"`
	NewUser      bool    `json:"new_user"`
}

func (s *Server) emailStart(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !emailRE.MatchString(email) {
		writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_email", "That email address doesn't look right."))
		return
	}
	if err := s.allow("code-ip:"+s.clientIP(r), 10, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("code-email:"+email, 3, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	code := auth.NewCode()
	_, err := s.DB.Exec(r.Context(), `
		INSERT INTO email_codes (email_hash, code_hash, expires_at, attempts) VALUES ($1, $2, $3, 0)
		ON CONFLICT (email_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
		auth.EmailHash(s.EmailKey, email), s.Tokens.HashSecret("code", email+"|"+code), time.Now().Add(codeTTL))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.Mail.SendCode(r.Context(), email, code); err != nil {
		slog.Error("send sign-in code", "err", err)
		writeErr(w, r, fail(http.StatusBadGateway, "email_failed", "The email couldn't be sent. Try again in a minute."))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) emailVerify(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email  string `json:"email"`
		Code   string `json:"code"`
		Device string `json:"device"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("verify-ip:"+s.clientIP(r), 20, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	emailHash := auth.EmailHash(s.EmailKey, email)
	code := strings.TrimSpace(in.Code)
	var out tokensOut
	wrongCode := false
	err := s.inTx(r.Context(), func(tx pgx.Tx) error {
		var hash []byte
		var expires time.Time
		var attempts int
		err := tx.QueryRow(r.Context(), `SELECT code_hash, expires_at, attempts FROM email_codes WHERE email_hash = $1 FOR UPDATE`,
			emailHash).Scan(&hash, &expires, &attempts)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && time.Now().After(expires)) {
			return fail(http.StatusUnauthorized, "code_expired", "That code has expired. Ask for a new one.")
		}
		if err != nil {
			return err
		}
		if attempts >= codeTries {
			return fail(http.StatusTooManyRequests, "too_many_tries", "Too many wrong codes. Ask for a new one.")
		}
		if !hmac.Equal(hash, s.Tokens.HashSecret("code", email+"|"+code)) {
			wrongCode = true
			_, err := tx.Exec(r.Context(), `UPDATE email_codes SET attempts = attempts + 1 WHERE email_hash = $1`, emailHash)
			return err
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM email_codes WHERE email_hash = $1`, emailHash); err != nil {
			return err
		}
		// the subject is the hash too; new accounts are "Hiker" until the person picks a name
		user, created, err := findOrCreateUser(r.Context(), tx, "email", hex.EncodeToString(emailHash), emailHash, "")
		if err != nil {
			return err
		}
		out, err = s.newSession(r.Context(), tx, user, in.Device)
		out.NewUser = created
		return err
	})
	if err == nil && wrongCode {
		err = fail(http.StatusUnauthorized, "wrong_code", "That code isn't right.")
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) googleSignIn(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"id_token"`
		Device  string `json:"device"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("google-ip:"+s.clientIP(r), 20, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	id, err := s.Google.Verify(r.Context(), in.IDToken)
	if errors.Is(err, auth.ErrGoogleDisabled) {
		writeErr(w, r, fail(http.StatusNotImplemented, "google_disabled", "Google sign-in isn't set up on this server."))
		return
	}
	if err != nil {
		writeErr(w, r, fail(http.StatusUnauthorized, "bad_google_token", "Google sign-in didn't work. Try again."))
		return
	}
	var out tokensOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var emailHash []byte
		if id.Email != "" {
			emailHash = auth.EmailHash(s.EmailKey, id.Email)
		}
		user, created, err := findOrCreateUser(r.Context(), tx, "google", id.Subject, emailHash, id.Name)
		if err != nil {
			return err
		}
		out, err = s.newSession(r.Context(), tx, user, in.Device)
		out.NewUser = created
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// findOrCreateUser finds the account for an identity, links it to an account with the same verified email, or makes
// a new account.
func findOrCreateUser(ctx context.Context, tx pgx.Tx, provider, subject string, emailHash []byte, name string) (userOut, bool, error) {
	var u userOut
	err := tx.QueryRow(ctx, `
		SELECT u.id, u.display_name FROM identities i JOIN users u ON u.id = i.user_id
		WHERE i.provider = $1 AND i.subject = $2`, provider, subject).Scan(&u.ID, &u.DisplayName)
	if err == nil {
		return u, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return u, false, err
	}
	if emailHash != nil {
		err = tx.QueryRow(ctx, `
			SELECT u.id, u.display_name FROM identities i JOIN users u ON u.id = i.user_id
			WHERE i.email_hash = $1 ORDER BY i.created_at LIMIT 1`, emailHash).Scan(&u.ID, &u.DisplayName)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO identities (provider, subject, user_id, email_hash) VALUES ($1, $2, $3, $4)`,
				provider, subject, u.ID, emailHash)
			return u, false, err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return u, false, err
		}
	}
	u = userOut{ID: auth.NewUUIDv7(), DisplayName: cleanName(name)}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, display_name) VALUES ($1, $2)`, u.ID, u.DisplayName); err != nil {
		return u, false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO identities (provider, subject, user_id, email_hash) VALUES ($1, $2, $3, $4)`,
		provider, subject, u.ID, emailHash)
	return u, true, err
}

func cleanName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		return "Hiker"
	}
	return name
}

func (s *Server) newSession(ctx context.Context, tx pgx.Tx, u userOut, device string) (tokensOut, error) {
	id := auth.NewUUIDv7()
	refresh := auth.NewRefreshToken()
	if r := []rune(strings.TrimSpace(device)); len(r) > maxDeviceLn {
		device = string(r[:maxDeviceLn])
	}
	_, err := tx.Exec(ctx, `INSERT INTO sessions (id, user_id, token_hash, device, expires_at) VALUES ($1, $2, $3, $4, $5)`,
		id, u.ID, s.Tokens.HashSecret("refresh", refresh), strings.TrimSpace(device), time.Now().Add(sessionTTL))
	if err != nil {
		return tokensOut{}, err
	}
	return s.tokens(u, id, refresh), nil
}

func (s *Server) tokens(u userOut, sessionID, refresh string) tokensOut {
	return tokensOut{
		AccessToken:  s.Tokens.Sign(u.ID, sessionID),
		TokenType:    "Bearer",
		ExpiresIn:    int(s.Tokens.TTL().Seconds()),
		RefreshToken: refresh,
		User:         u,
	}
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("refresh-ip:"+s.clientIP(r), 60, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	next := auth.NewRefreshToken()
	var u userOut
	var sid string
	err := s.DB.QueryRow(r.Context(), `
		UPDATE sessions s SET token_hash = $2, last_used_at = now(), expires_at = $3
		FROM users u
		WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id
		RETURNING s.id, u.id, u.display_name`,
		s.Tokens.HashSecret("refresh", in.RefreshToken), s.Tokens.HashSecret("refresh", next), time.Now().Add(sessionTTL),
	).Scan(&sid, &u.ID, &u.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, r, fail(http.StatusUnauthorized, "signed_out", "You've been signed out. Sign in again."))
		return
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tokens(u, sid, next))
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if _, err := s.DB.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`,
		s.Tokens.HashSecret("refresh", in.RefreshToken)); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request, c caller) {
	var out struct {
		userOut
		CreatedAt time.Time `json:"created_at"`
		SignIns   []string  `json:"sign_ins"`
	}
	err := s.DB.QueryRow(r.Context(), `SELECT id, display_name, created_at FROM users WHERE id = $1`, c.UserID).
		Scan(&out.ID, &out.DisplayName, &out.CreatedAt)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT provider FROM identities WHERE user_id = $1 ORDER BY created_at`, c.UserID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out.SignIns, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) patchMe(w http.ResponseWriter, r *http.Request, c caller) {
	var in struct {
		DisplayName *string `json:"display_name"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	var u userOut
	if in.DisplayName != nil {
		name := strings.Join(strings.Fields(*in.DisplayName), " ")
		if n := len([]rune(name)); n < 1 || n > 40 {
			writeErr(w, r, fail(http.StatusUnprocessableEntity, "bad_name", "Names are 1 to 40 characters."))
			return
		}
		if _, err := s.DB.Exec(r.Context(), `UPDATE users SET display_name = $2 WHERE id = $1`, c.UserID, name); err != nil {
			writeErr(w, r, err)
			return
		}
	}
	if err := s.DB.QueryRow(r.Context(), `SELECT id, display_name FROM users WHERE id = $1`, c.UserID).Scan(&u.ID, &u.DisplayName); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// deleteMe removes the account and everything posted with it, and its photo files.
func (s *Server) deleteMe(w http.ResponseWriter, r *http.Request, c caller) {
	var keys []string
	err := s.inTx(r.Context(), func(tx pgx.Tx) error {
		var trails []string
		rows, err := tx.Query(r.Context(), `
			SELECT trail_id FROM reviews WHERE user_id = $1
			UNION SELECT trail_id FROM hike_logs WHERE user_id = $1
			UNION SELECT trail_id FROM photos WHERE user_id = $1 AND trail_id IS NOT NULL`, c.UserID)
		if err != nil {
			return err
		}
		trails, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		rows, err = tx.Query(r.Context(), `
			SELECT k FROM photos, LATERAL (VALUES (display_key), (thumb_key)) v(k) WHERE user_id = $1 AND k IS NOT NULL`, c.UserID)
		if err != nil {
			return err
		}
		keys, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM users WHERE id = $1`, c.UserID); err != nil {
			return err
		}
		for i := range trails {
			if err := refreshStats(r.Context(), tx, &trails[i]); err != nil {
				return err
			}
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
