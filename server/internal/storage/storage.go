// Package storage keeps photo files. Files are named by their content hash, so a key never changes and can be cached
// forever. The disk driver is used on the Pi; an S3/R2 driver can be added behind the same interface.
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

type Store interface {
	// Put stores data and returns its key ("<sha256>.<ext>").
	Put(ctx context.Context, data []byte, ext string) (string, error)
	// Serve writes the file to w (with caching headers), or 404.
	Serve(w http.ResponseWriter, r *http.Request, key string)
	Delete(ctx context.Context, key string) error
}

var keyRE = regexp.MustCompile(`^[0-9a-f]{64}\.(heic|jpg)$`)

func ValidKey(key string) bool { return keyRE.MatchString(key) }

// Disk stores files under Dir/ab/cd/<key>.
type Disk struct{ Dir string }

func (d Disk) path(key string) string {
	return filepath.Join(d.Dir, key[0:2], key[2:4], key)
}

func (d Disk) Put(_ context.Context, data []byte, ext string) (string, error) {
	sum := sha256.Sum256(data)
	key := hex.EncodeToString(sum[:]) + "." + ext
	p := d.path(key)
	if _, err := os.Stat(p); err == nil {
		return key, nil // same bytes already stored
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".up-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return key, os.Rename(tmp.Name(), p)
}

func (d Disk) Serve(w http.ResponseWriter, r *http.Request, key string) {
	if !ValidKey(key) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(d.path(key))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	if filepath.Ext(key) == ".heic" {
		w.Header().Set("Content-Type", "image/heic")
	} else {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+key[:16]+`"`)
	http.ServeContent(w, r, "", time.Time{}, f)
}

func (d Disk) Delete(_ context.Context, key string) error {
	if !ValidKey(key) {
		return nil
	}
	err := os.Remove(d.path(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
