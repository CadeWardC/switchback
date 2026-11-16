package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// GoogleIdentity is who a Google ID token says signed in.
type GoogleIdentity struct {
	Subject string
	Email   string
	Name    string
}

// Google checks ID tokens from Google Sign-In against Google's public keys (fetched and cached), so no Google
// secret is needed anywhere.
type Google struct {
	ClientIDs []string
	CertsURL  string
	HTTP      *http.Client

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
	now     func() time.Time
}

func NewGoogle(clientIDs []string) *Google {
	return &Google{
		ClientIDs: clientIDs,
		CertsURL:  "https://www.googleapis.com/oauth2/v3/certs",
		HTTP:      &http.Client{Timeout: 10 * time.Second},
		now:       time.Now,
	}
}

var ErrGoogleDisabled = errors.New("google sign-in is not configured")

func (g *Google) Verify(ctx context.Context, idToken string) (GoogleIdentity, error) {
	if len(g.ClientIDs) == 0 {
		return GoogleIdentity{}, ErrGoogleDisabled
	}
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return GoogleIdentity{}, ErrBadToken
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodePart(parts[0], &header); err != nil || header.Alg != "RS256" {
		return GoogleIdentity{}, ErrBadToken
	}
	key, err := g.key(ctx, header.Kid)
	if err != nil {
		return GoogleIdentity{}, err
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil {
		return GoogleIdentity{}, ErrBadToken
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig) != nil {
		return GoogleIdentity{}, ErrBadToken
	}
	var c struct {
		Iss           string `json:"iss"`
		Aud           string `json:"aud"`
		Sub           string `json:"sub"`
		Exp           int64  `json:"exp"`
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := decodePart(parts[1], &c); err != nil {
		return GoogleIdentity{}, ErrBadToken
	}
	if c.Iss != "accounts.google.com" && c.Iss != "https://accounts.google.com" {
		return GoogleIdentity{}, ErrBadToken
	}
	if !contains(g.ClientIDs, c.Aud) || c.Sub == "" || g.now().Unix() >= c.Exp {
		return GoogleIdentity{}, ErrBadToken
	}
	email := ""
	if c.EmailVerified == true || c.EmailVerified == "true" {
		email = strings.ToLower(c.Email)
	}
	return GoogleIdentity{Subject: c.Sub, Email: email, Name: c.Name}, nil
}

func (g *Google) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if k, ok := g.keys[kid]; ok && g.now().Sub(g.fetched) < 6*time.Hour {
		return k, nil
	}
	// unknown key or old cache: refetch (Google rotates keys), at most once a minute
	if g.now().Sub(g.fetched) > time.Minute {
		if err := g.fetch(ctx); err != nil {
			return nil, err
		}
	}
	if k, ok := g.keys[kid]; ok {
		return k, nil
	}
	return nil, ErrBadToken
}

func (g *Google) fetch(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, g.CertsURL, nil)
	resp, err := g.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("fetch google keys: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch google keys: %s", resp.Status)
	}
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := b64.DecodeString(k.N)
		e, err2 := b64.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	g.keys, g.fetched = keys, g.now()
	return nil
}

func decodePart(s string, v any) error {
	b, err := b64.DecodeString(s)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
