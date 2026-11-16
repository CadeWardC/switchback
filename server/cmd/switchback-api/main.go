// switchback-api serves Switchback's accounts, reviews, hike logs, photos and trail submissions.
//
// Settings come from the environment (on the Pi: /etc/switchback/api.env):
//
//	DATABASE_URL       postgres://switchback@/switchback?host=/run/postgresql
//	LISTEN             127.0.0.1:8080 (cloudflared connects here; never exposed directly)
//	PUBLIC_URL         https://api.example.com
//	TOKEN_SECRET       64 hex characters (openssl rand -hex 32)
//	EMAIL_HASH_KEY     64 hex characters; stands in for email addresses, which are never stored. Never change it.
//	ADMIN_TOKEN        at least 32 characters (openssl rand -hex 32): the review page's key for /v1/admin/*;
//	                   empty turns the admin routes off
//	PHOTO_DIR          /srv/switchback/photos
//	GOOGLE_CLIENT_IDS  comma-separated OAuth client ids (iOS) that may sign in; empty turns Google off
//	RESEND_API_KEY     to email sign-in codes; empty logs them instead (for development)
//	MAIL_FROM          Switchback <signin@example.com>
//	TRUST_CLOUDFLARE   1 to take client IPs from CF-Connecting-IP (only behind the tunnel)
//	DB_MAX_CONNS       default 10
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"switchback/server/internal/api"
	"switchback/server/internal/auth"
	"switchback/server/internal/db"
	"switchback/server/internal/ratelimit"
	"switchback/server/internal/storage"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("stopped", "err", err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	secret, err := hex.DecodeString(env("TOKEN_SECRET", ""))
	if err != nil || len(secret) < 32 {
		return errors.New("TOKEN_SECRET must be at least 64 hex characters (openssl rand -hex 32)")
	}
	emailKey, err := hex.DecodeString(env("EMAIL_HASH_KEY", ""))
	if err != nil || len(emailKey) < 32 {
		return errors.New("EMAIL_HASH_KEY must be at least 64 hex characters (openssl rand -hex 32), and must never change")
	}
	adminToken := env("ADMIN_TOKEN", "")
	if adminToken != "" && len(adminToken) < api.MinAdminToken {
		return errors.New("ADMIN_TOKEN must be at least 32 characters (openssl rand -hex 32), or empty to turn admin off")
	}
	signer, err := auth.NewSigner(secret, 15*time.Minute)
	if err != nil {
		return err
	}
	maxConns, _ := strconv.Atoi(env("DB_MAX_CONNS", "10"))
	pool, err := db.Open(ctx, env("DATABASE_URL", "postgres:///switchback"), int32(max(2, maxConns)))
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	photoDir := env("PHOTO_DIR", "./photos")
	if err := os.MkdirAll(photoDir, 0o755); err != nil {
		return err
	}
	var mailer auth.Mailer = auth.LogMailer{}
	if key := env("RESEND_API_KEY", ""); key != "" {
		mailer = &auth.Resend{APIKey: key, From: env("MAIL_FROM", "Switchback <onboarding@resend.dev>")}
	}
	var clientIDs []string
	for _, id := range strings.Split(env("GOOGLE_CLIENT_IDS", ""), ",") {
		if id = strings.TrimSpace(id); id != "" {
			clientIDs = append(clientIDs, id)
		}
	}

	srv := &api.Server{
		EmailKey:   emailKey,
		DB:         pool,
		Tokens:     signer,
		Google:     auth.NewGoogle(clientIDs),
		Mail:       mailer,
		Store:      storage.Disk{Dir: photoDir},
		Limit:      ratelimit.New(),
		AdminToken: adminToken,
		Cfg: api.Config{
			PublicURL: env("PUBLIC_URL", "http://localhost:8080"),
			TrustCF:   env("TRUST_CLOUDFLARE", "") == "1",
		},
	}
	httpSrv := &http.Server{
		Addr:              env("LISTEN", "127.0.0.1:8080"),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second, // photo and hike uploads on slow connections
		WriteTimeout:      120 * time.Second, // a new phone's first download of every hike
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdown)
	}()
	slog.Info("listening", "addr", httpSrv.Addr, "google", len(clientIDs) > 0, "email", mailer != auth.Mailer(auth.LogMailer{}), "admin", adminToken != "")
	if err := httpSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
