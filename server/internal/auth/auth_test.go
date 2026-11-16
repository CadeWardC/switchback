package auth

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAccessTokens(t *testing.T) {
	s, _ := NewSigner(bytes.Repeat([]byte{1}, 32), time.Minute)
	tok := s.Sign("user-1", "session-1")
	c, err := s.Verify(tok)
	if err != nil || c.Sub != "user-1" || c.Sid != "session-1" {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := s.Verify(tok[:len(tok)-2] + "xx"); err == nil {
		t.Fatal("accepted a tampered signature")
	}
	other, _ := NewSigner(bytes.Repeat([]byte{2}, 32), time.Minute)
	if _, err := other.Verify(tok); err == nil {
		t.Fatal("accepted a token signed with another secret")
	}
	s.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if _, err := s.Verify(tok); err == nil {
		t.Fatal("accepted an expired token")
	}
	if _, err := NewSigner([]byte("short"), time.Minute); err == nil {
		t.Fatal("accepted a short secret")
	}
}

func TestCodes(t *testing.T) {
	for i := 0; i < 50; i++ {
		if c := NewCode(); len(c) != 6 || strings.Trim(c, "0123456789") != "" {
			t.Fatalf("bad code %q", c)
		}
	}
	if id := NewUUIDv7(); len(id) != 36 || id[14] != '7' {
		t.Fatalf("bad uuid %q", id)
	}
}

func TestGoogle(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	certs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": "k1", "kty": "RSA",
			"n": b64.EncodeToString(key.N.Bytes()),
			"e": b64.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer certs.Close()
	g := NewGoogle([]string{"my-ios-client"})
	g.CertsURL = certs.URL

	sign := func(claims map[string]any) string {
		h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
		c, _ := json.Marshal(claims)
		unsigned := b64.EncodeToString(h) + "." + b64.EncodeToString(c)
		sum := sha256.Sum256([]byte(unsigned))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
		return unsigned + "." + b64.EncodeToString(sig)
	}
	good := map[string]any{"iss": "https://accounts.google.com", "aud": "my-ios-client", "sub": "123",
		"exp": time.Now().Add(time.Hour).Unix(), "email": "Ana@Gmail.com", "email_verified": true, "name": "Ana"}
	id, err := g.Verify(context.Background(), sign(good))
	if err != nil || id.Subject != "123" || id.Email != "ana@gmail.com" {
		t.Fatalf("%+v %v", id, err)
	}
	for name, change := range map[string]map[string]any{
		"other app":      {"aud": "someone-else"},
		"expired":        {"exp": time.Now().Add(-time.Minute).Unix()},
		"wrong issuer":   {"iss": "https://evil.example"},
		"unverified ok?": nil,
	} {
		if change == nil {
			continue
		}
		claims := map[string]any{}
		for k, v := range good {
			claims[k] = v
		}
		for k, v := range change {
			claims[k] = v
		}
		if _, err := g.Verify(context.Background(), sign(claims)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	unverified := map[string]any{}
	for k, v := range good {
		unverified[k] = v
	}
	unverified["email_verified"] = false
	if id, err := g.Verify(context.Background(), sign(unverified)); err != nil || id.Email != "" {
		t.Fatalf("unverified email should be dropped: %+v %v", id, err)
	}
	if _, err := NewGoogle(nil).Verify(context.Background(), "x.y.z"); err != ErrGoogleDisabled {
		t.Fatalf("got %v", err)
	}
}
