package ratelimit

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

type bucket struct {
	tokens   float64
	lastSeen time.Time
	mu       sync.Mutex
}

// Limiter is an in-memory token-bucket rate limiter keyed by an arbitrary
// string (IP address, email, etc.). It is safe for concurrent use.
type Limiter struct {
	buckets map[string]*bucket
	mu      sync.RWMutex
	rate    float64       // tokens replenished per second
	burst   float64       // maximum token capacity
	ttl     time.Duration // how long an idle bucket is kept before cleanup
}

// New creates a Limiter. rate = tokens/sec, burst = max burst size.
// Idle buckets are expired after 5 minutes.
func New(rate, burst float64) *Limiter {
	return &Limiter{
		buckets: make(map[string]*bucket),
		rate:    rate,
		burst:   burst,
		ttl:     5 * time.Minute,
	}
}

// Allow checks if the key (IP or email) can proceed.
// Returns true if allowed, false if rate-limited.
func (l *Limiter) Allow(key string) bool {
	l.mu.RLock()
	b, ok := l.buckets[key]
	l.mu.RUnlock()

	if !ok {
		l.mu.Lock()
		// Double-check after acquiring write lock.
		b, ok = l.buckets[key]
		if !ok {
			b = &bucket{tokens: l.burst, lastSeen: time.Now()}
			l.buckets[key] = b
		}
		l.mu.Unlock()
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastSeen).Seconds()
	b.lastSeen = now

	// Refill tokens based on elapsed time.
	b.tokens += elapsed * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Cleanup removes buckets that have been idle longer than the TTL.
// Intended to be called in a goroutine on a regular interval.
func (l *Limiter) Cleanup() {
	for {
		time.Sleep(l.ttl)
		now := time.Now()

		l.mu.Lock()
		for key, b := range l.buckets {
			b.mu.Lock()
			idle := now.Sub(b.lastSeen)
			b.mu.Unlock()
			if idle > l.ttl {
				delete(l.buckets, key)
			}
		}
		l.mu.Unlock()
	}
}

// Middleware wraps an http.Handler, rate-limiting by the client's RemoteAddr.
// Returns HTTP 429 with a Retry-After header when a request is denied.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := extractIP(r.RemoteAddr)
		if !l.Allow(ip) {
			retryAfter := int(l.burst/l.rate) + 1
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"rate limit exceeded"}`)) //nolint:errcheck
			return
		}
		next.ServeHTTP(w, r)
	})
}

// extractIP strips the port from a "host:port" RemoteAddr string.
func extractIP(remoteAddr string) string {
	for i := len(remoteAddr) - 1; i >= 0; i-- {
		if remoteAddr[i] == ':' {
			return remoteAddr[:i]
		}
	}
	return remoteAddr
}
