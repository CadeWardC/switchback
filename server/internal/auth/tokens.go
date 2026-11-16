// Package auth signs and checks access tokens, makes refresh tokens and sign-in codes, and checks Google ID tokens.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

// Claims are what an access token says: who, which session, until when.
type Claims struct {
	Sub string `json:"sub"`
	Sid string `json:"sid"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
}

// Signer makes and checks short-lived access tokens (JWT, HS256), so most requests need no database lookup.
type Signer struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

func NewSigner(secret []byte, ttl time.Duration) (*Signer, error) {
	if len(secret) < 32 {
		return nil, errors.New("token secret must be at least 32 bytes")
	}
	return &Signer{secret: secret, ttl: ttl, now: time.Now}, nil
}

func (s *Signer) TTL() time.Duration { return s.ttl }

var jwtHeader = b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

func (s *Signer) Sign(userID, sessionID string) string {
	now := s.now()
	body, _ := json.Marshal(Claims{Sub: userID, Sid: sessionID, Iat: now.Unix(), Exp: now.Add(s.ttl).Unix()})
	unsigned := jwtHeader + "." + b64.EncodeToString(body)
	return unsigned + "." + b64.EncodeToString(s.mac(unsigned))
}

var ErrBadToken = errors.New("invalid or expired token")

func (s *Signer) Verify(token string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != jwtHeader {
		return Claims{}, ErrBadToken
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, s.mac(parts[0]+"."+parts[1])) {
		return Claims{}, ErrBadToken
	}
	body, err := b64.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrBadToken
	}
	var c Claims
	if json.Unmarshal(body, &c) != nil || c.Sub == "" || s.now().Unix() >= c.Exp {
		return Claims{}, ErrBadToken
	}
	return c, nil
}

func (s *Signer) mac(data string) []byte {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// HashSecret is how refresh tokens and sign-in codes are stored: never as themselves.
func (s *Signer) HashSecret(kind, value string) []byte {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(kind + "\x00" + value))
	return m.Sum(nil)
}

// NewRefreshToken is 32 random bytes.
func NewRefreshToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return b64.EncodeToString(b)
}

// NewCode is a 6-digit sign-in code.
func NewCode() string {
	var b [8]byte
	rand.Read(b[:])
	return fmt.Sprintf("%06d", binary.BigEndian.Uint64(b[:])%1_000_000)
}

// NewUUIDv7 makes a time-ordered id.
func NewUUIDv7() string {
	var u [16]byte
	rand.Read(u[:])
	ms := uint64(time.Now().UnixMilli())
	u[0], u[1], u[2], u[3], u[4], u[5] = byte(ms>>40), byte(ms>>32), byte(ms>>24), byte(ms>>16), byte(ms>>8), byte(ms)
	u[6] = u[6]&0x0f | 0x70
	u[8] = u[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", u[0:4], u[4:6], u[6:8], u[8:10], u[10:16])
}
