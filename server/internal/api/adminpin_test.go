package api

import (
	"testing"
	"time"
)

func TestAdminSessions(t *testing.T) {
	s := &Server{AdminToken: "admintoken-0123456789abcdef0123456789abcdef", AdminPIN: "482913"}
	now := time.Now()
	tok := s.newAdminSession(now)
	if !s.validAdminSession(tok, now) {
		t.Fatal("a new session should be valid")
	}
	if s.validAdminSession(tok, now.Add(adminSessionLife+time.Second)) {
		t.Fatal("a session should run out after 12 hours")
	}
	if s.validAdminSession(tok[:len(tok)-1]+"0", now) && tok[len(tok)-1] != '0' {
		t.Fatal("a changed signature should be refused")
	}
	other := &Server{AdminToken: s.AdminToken, AdminPIN: "111111"}
	if other.validAdminSession(tok, now) {
		t.Fatal("changing the PIN should end old sessions")
	}
	if (&Server{AdminToken: s.AdminToken}).validAdminSession(tok, now) {
		t.Fatal("without a PIN there are no sessions")
	}
	for pin, ok := range map[string]bool{"123456": true, "123456789012": true, "12345": false, "1234567890123": false, "12a456": false, "": false} {
		if ValidPIN(pin) != ok {
			t.Errorf("ValidPIN(%q) = %v", pin, !ok)
		}
	}
}
