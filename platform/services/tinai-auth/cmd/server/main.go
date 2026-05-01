package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"tinai.cloud/auth/internal/auth"
	"tinai.cloud/auth/internal/config"
	"tinai.cloud/auth/internal/email"
	"tinai.cloud/auth/internal/handlers"
	"tinai.cloud/auth/internal/oidc"
	"tinai.cloud/auth/internal/ratelimit"
	wahandler "tinai.cloud/auth/internal/webauthn"
)

var (
	loginAttempts = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_auth_login_attempts_total",
		Help: "Total login attempts by method and status",
	}, []string{"method", "status"}) // method: password/magic_link/sms_otp, status: success/failure

	activeTokens = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "tinai_auth_active_tokens_total",
		Help: "Estimated active JWT count (from DB user count)",
	})
)

func main() {
	cfg := config.Load()

	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}

	// Ensure the users table exists. In a production service this would be
	// handled by a migration tool (e.g. golang-migrate), but for a single-table
	// microservice the inline DDL keeps the deployment self-contained.
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS users (
		id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
		email           TEXT        UNIQUE,
		password_hash   TEXT,
		mobile          VARCHAR(15) UNIQUE,
		mobile_verified BOOLEAN     NOT NULL DEFAULT false,
		role            VARCHAR(20) NOT NULL DEFAULT 'tenant',
		tenant_id       VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
		region          VARCHAR(5)  NOT NULL DEFAULT 'IN',
		magic_token     TEXT,
		magic_expires   TIMESTAMPTZ,
		last_login      TIMESTAMPTZ,
		created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		log.Fatalf("create users table: %v", err)
	}

	// Periodically refresh the activeTokens gauge from the user count.
	go func() {
		tick := time.NewTicker(60 * time.Second)
		defer tick.Stop()
		for range tick.C {
			var count float64
			if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err == nil {
				activeTokens.Set(count)
			}
		}
	}()

	// Rate limiters:
	//   authLimiter  — 5 requests/minute (burst=5) for sensitive auth endpoints
	//   globalLimiter — 60 requests/minute (burst=60) for all other endpoints
	authLimiter   := ratelimit.New(5.0/60.0, 5)
	globalLimiter := ratelimit.New(1.0, 60)
	go authLimiter.Cleanup()
	go globalLimiter.Cleanup()

	// Auth-sensitive paths that get the stricter rate limit.
	authPaths := map[string]bool{
		"/api/v1/auth/login":          true,
		"/api/v1/auth/register":       true,
		"/api/v1/auth/magic-link":     true,
		"/api/v1/auth/sms-otp":        true,
		"/api/v1/auth/verify-sms":     true,
		"/api/v1/auth/sso/":           true, // SSO redirect + callback prefix
		"/api/v1/auth/passkey/":       true, // WebAuthn / passkeys (all 4 routes)
	}

	mux := http.NewServeMux()

	// Initialize Redis for rate limiting and queuing
	var rdb *redis.Client
	if cfg.RedisURL != "" {
		opts, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			log.Printf("warn: invalid REDIS_URL: %v", err)
		} else {
			rdb = redis.NewClient(opts)
			if err := rdb.Ping(context.Background()).Err(); err != nil {
				log.Printf("warn: redis ping failed: %v", err)
				rdb = nil
			} else {
				log.Printf("connected to redis for queuing and rate limiting")
			}
		}
	}

	onLogin := func(method, status string) {
		loginAttempts.WithLabelValues(method, status).Inc()
	}

	// Initialize mailer for magic link / OTP delivery
	mailer := email.NewMailer(
		cfg.SMTPHost,
		cfg.SMTPPort,
		cfg.SMTPUser,
		cfg.SMTPPass,
		cfg.SMTPFromName,
		cfg.SMTPFromAddr,
		rdb,
	)

	// Start background mailer worker
	go mailer.StartWorker(context.Background())

	authHandler := auth.NewHandler(db, cfg, mailer)
	authHandler.OnLogin = onLogin
	authHandler.Register(mux)

	// OIDC / SSO — providers are loaded from env; unconfigured providers are
	// silently skipped so the service starts cleanly with no SSO vars set.
	oidcCfg := oidc.LoadFromEnv()
	oidcHandler := handlers.NewOIDCHandler(oidcCfg, db, cfg, onLogin)
	oidcHandler.Register(mux)

	// WebAuthn / passkeys — WEBAUTHN_RPID and WEBAUTHN_ORIGINS are read from
	// the environment; the handler starts cleanly even if those vars are unset
	// (defaults to tinai.cloud).
	passkeyHandler, err := wahandler.NewHandler(db, cfg, onLogin)
	if err != nil {
		log.Fatalf("passkey handler init: %v", err)
	}
	passkeyHandler.Register(mux)

	mux.Handle("GET /metrics", promhttp.Handler())

	// Tiered rate-limiting wrapper: auth endpoints use authLimiter, all others
	// use globalLimiter.
	// authPaths contains both exact paths and a trailing-slash prefix for SSO
	// ("/api/v1/auth/sso/"), so we check both exact match and prefix match.
	rateLimitedMux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		isSensitive := authPaths[path]
		if !isSensitive {
			// Prefix check for SSO paths (/api/v1/auth/sso/{provider}/...).
			for p := range authPaths {
				if len(p) > 0 && p[len(p)-1] == '/' && strings.HasPrefix(path, p) {
					isSensitive = true
					break
				}
			}
		}
		if isSensitive {
			authLimiter.Middleware(mux).ServeHTTP(w, r)
		} else {
			globalLimiter.Middleware(mux).ServeHTTP(w, r)
		}
	})

	allowedOrigins := strings.Split(getEnv("ALLOWED_ORIGINS", "https://dashboard.tinai.cloud"), ",")

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: corsMiddleware(allowedOrigins, maxBytesMiddleware(rateLimitedMux)),
	}

	// Graceful shutdown on SIGTERM/SIGINT
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("tinai-auth: shutting down...")
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutCancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("tinai-auth listening on :%s (dev=%v)", cfg.Port, cfg.DevMode)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	log.Printf("tinai-auth: shutdown complete")
}

// getEnv returns the value of the named environment variable, or fallback if unset.
func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// maxBytesMiddleware caps every request body at 1 MiB to prevent DoS via
// unbounded body reads. It must be applied before any handler that calls
// json.NewDecoder or io.ReadAll on r.Body.
func maxBytesMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware adds strict CORS headers based on ALLOWED_ORIGINS and handles
// pre-flight OPTIONS requests before passing the request on to the main mux.
func corsMiddleware(allowedOrigins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		for _, allowed := range allowedOrigins {
			if origin == strings.TrimSpace(allowed) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				break
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
