package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// Mailer sends sign-in codes.
type Mailer interface {
	SendCode(ctx context.Context, to, code string) error
}

// Resend sends through resend.com's HTTP API (free for 3,000 emails a month).
type Resend struct {
	APIKey string
	From   string
	HTTP   *http.Client
}

func (r *Resend) SendCode(ctx context.Context, to, code string) error {
	body, _ := json.Marshal(map[string]any{
		"from":    r.From,
		"to":      []string{to},
		"subject": "Your Switchback sign-in code: " + code,
		"text": "Your Switchback sign-in code is " + code + ".\n\n" +
			"It works for 10 minutes. If you didn't ask for it, you can ignore this email.",
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+r.APIKey)
	req.Header.Set("Content-Type", "application/json")
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("resend: %s", resp.Status)
	}
	return nil
}

// LogMailer writes the code to the log instead of sending it: for working on a laptop.
type LogMailer struct{}

func (LogMailer) SendCode(_ context.Context, to, code string) error {
	slog.Info("sign-in code (not emailed: no RESEND_API_KEY)", "to", to, "code", code)
	return nil
}
