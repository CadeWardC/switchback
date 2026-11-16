// Package ratelimit is an in-memory token bucket per key ("ip:1.2.3.4", "user:…"), enough for one server.
package ratelimit

import (
	"sync"
	"time"
)

type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	now     func() time.Time
	lastGC  time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func New() *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, now: time.Now}
}

// Allow takes one token from key's bucket, which holds burst tokens and refills at burst per period.
func (l *Limiter) Allow(key string, burst int, period time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastGC) > 10*time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.last) > 24*time.Hour {
				delete(l.buckets, k)
			}
		}
		l.lastGC = now
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(burst), last: now}
		l.buckets[key] = b
	}
	rate := float64(burst) / period.Seconds()
	b.tokens += now.Sub(b.last).Seconds() * rate
	if b.tokens > float64(burst) {
		b.tokens = float64(burst)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
