package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"switchback/server/internal/auth"
)

// passwordCost is bcrypt's work factor: about a tenth of a second per check on a laptop, a few tenths on the Pi.
// Tests lower it.
var passwordCost = 11

const (
	minPasswordLn = 8
	maxPasswordLn = 200
)

var (
	errWrongLogin   = fail(http.StatusUnauthorized, "wrong_login", "That email and password don't match.")
	errWeakPassword = fail(http.StatusUnprocessableEntity, "weak_password", "Passwords are 8 to 200 characters.")
	errBadEmail     = fail(http.StatusUnprocessableEntity, "bad_email", "That email address doesn't look right.")
)

// bcrypt only reads the first 72 bytes, so it's given a fixed-length digest of the password instead.
func passwordInput(password string) []byte {
	sum := sha256.Sum256([]byte(password))
	return []byte(base64.StdEncoding.EncodeToString(sum[:]))
}

func hashPassword(password string) ([]byte, error) {
	return bcrypt.GenerateFromPassword(passwordInput(password), passwordCost)
}

func checkPassword(hash []byte, password string) bool {
	return bcrypt.CompareHashAndPassword(hash, passwordInput(password)) == nil
}

var (
	dummyOnce sync.Once
	dummyHash []byte
)

// dummyPasswordHash is checked against when the email is unknown, so a wrong email takes as long as a wrong
// password and the answer doesn't tell anyone which emails have accounts.
func dummyPasswordHash() []byte {
	dummyOnce.Do(func() { dummyHash, _ = hashPassword("not anyone's password") })
	return dummyHash
}

func validPassword(p string) bool {
	n := utf8.RuneCountInString(p)
	return n >= minPasswordLn && n <= maxPasswordLn
}

// lockEmail keeps two sign-ups with the same email from racing each other.
func lockEmail(ctx context.Context, tx pgx.Tx, emailHash []byte) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('email:' || $1, 0))`, hex.EncodeToString(emailHash))
	return err
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Device      string `json:"device"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !emailRE.MatchString(email) {
		writeErr(w, r, errBadEmail)
		return
	}
	if !validPassword(in.Password) {
		writeErr(w, r, errWeakPassword)
		return
	}
	if err := s.allow("register-ip:"+s.clientIP(r), 20, time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	emailHash := auth.EmailHash(s.EmailKey, email)
	var out tokensOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		if err := lockEmail(r.Context(), tx, emailHash); err != nil {
			return err
		}
		// one account per email, however it signs in
		var taken bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM identities WHERE email_hash = $1)`, emailHash).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return fail(http.StatusConflict, "email_taken", "There's already an account with that email. Log in instead.")
		}
		u := userOut{ID: auth.NewUUIDv7(), DisplayName: cleanName(in.DisplayName)}
		if _, err := tx.Exec(r.Context(), `INSERT INTO users (id, display_name) VALUES ($1, $2)`, u.ID, u.DisplayName); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO identities (provider, subject, user_id, email_hash, password_hash) VALUES ('password', $1, $2, $3, $4)`,
			hex.EncodeToString(emailHash), u.ID, emailHash, hash); err != nil {
			return err
		}
		out, err = s.newSession(r.Context(), tx, u, in.Device)
		out.NewUser = true
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Device   string `json:"device"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	emailHash := auth.EmailHash(s.EmailKey, email)
	if err := s.allow("login-ip:"+s.clientIP(r), 30, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := s.allow("login-email:"+hex.EncodeToString(emailHash), 10, 10*time.Minute); err != nil {
		writeErr(w, r, err)
		return
	}
	var u userOut
	var hash []byte
	err := s.DB.QueryRow(r.Context(), `
		SELECT u.id, u.display_name, i.password_hash FROM identities i JOIN users u ON u.id = i.user_id
		WHERE i.provider = 'password' AND i.subject = $1`, hex.EncodeToString(emailHash)).Scan(&u.ID, &u.DisplayName, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		checkPassword(dummyPasswordHash(), in.Password)
		writeErr(w, r, errWrongLogin)
		return
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !checkPassword(hash, in.Password) {
		writeErr(w, r, errWrongLogin)
		return
	}
	var out tokensOut
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		var err error
		out, err = s.newSession(r.Context(), tx, u, in.Device)
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// changePassword needs the current password, and signs out the account's other devices.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, c caller) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, r, err)
		return
	}
	if !validPassword(in.NewPassword) {
		writeErr(w, r, errWeakPassword)
		return
	}
	if err := s.allow("password:"+c.UserID, 10, time.Hour); err != nil {
		writeErr(w, r, err)
		return
	}
	var subject string
	var hash []byte
	err := s.DB.QueryRow(r.Context(), `SELECT subject, password_hash FROM identities WHERE user_id = $1 AND provider = 'password'`,
		c.UserID).Scan(&subject, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, r, fail(http.StatusConflict, "no_password", "This account signs in without a password."))
		return
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !checkPassword(hash, in.CurrentPassword) {
		writeErr(w, r, fail(http.StatusUnauthorized, "wrong_password", "That isn't your current password."))
		return
	}
	next, err := hashPassword(in.NewPassword)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	err = s.inTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `UPDATE identities SET password_hash = $3 WHERE provider = 'password' AND subject = $1 AND user_id = $2`,
			subject, c.UserID, next); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, c.UserID, c.SessionID)
		return err
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
