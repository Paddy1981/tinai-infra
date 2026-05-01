package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tinai/tinai-gateway/internal/api"
	"github.com/tinai/tinai-gateway/internal/billing"
	"github.com/tinai/tinai-gateway/internal/cache"
	"github.com/tinai/tinai-gateway/internal/embeddings"
	"github.com/tinai/tinai-gateway/internal/middleware"
	"github.com/tinai/tinai-gateway/internal/models"
	"github.com/tinai/tinai-gateway/internal/quota"
)

func main() {
	// Fail fast if the JWT signing secret is absent — running without it would
	// leave all authenticated endpoints unprotected (audit finding TINAI-H1).
	if os.Getenv("JWT_SECRET") == "" {
		log.Fatal("FATAL: JWT_SECRET environment variable is not set — refusing to start")
	}

	port := getEnv("PORT", "3005")
	dbURL := getEnv("DATABASE_URL", "")

	var db *sql.DB
	var err error
	if dbURL != "" {
		db, err = sql.Open("postgres", dbURL)
		if err != nil {
			log.Fatalf("failed to open database: %v", err)
		}
		db.SetMaxOpenConns(25)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(5 * time.Minute)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err = db.PingContext(ctx); err != nil {
			log.Printf("WARNING: database ping failed: %v — running without persistence", err)
			db = nil
		} else {
			log.Println("database connected")
		}
	} else {
		log.Println("WARNING: DATABASE_URL not set — quota and cache will be in-memory stubs")
	}

	embClient := embeddings.New()
	if embClient.IsFallback() {
		log.Println("embeddings: SARVAM_API_KEY not set — using deterministic hash fallback")
	} else {
		log.Println("embeddings: Sarvam AI embeddings active")
	}

	semanticCache := cache.New(db, embClient.Embed)
	quotaManager := quota.New(db)

	h := api.NewHandler(api.Config{
		Cache:          semanticCache,
		Quota:          quotaManager,
		AnthropicKey:   getEnv("ANTHROPIC_API_KEY", ""),
		GeminiKey:      getEnv("GEMINI_API_KEY", ""),
		OllamaBaseURL:  getEnv("OLLAMA_BASE_URL", "http://ollama.tinai-system.svc.cluster.local:11434"),
		SarvamKey:      getEnv("SARVAM_API_KEY", ""),
		KrutrimKey:     getEnv("KRUTRIM_API_KEY", ""),
	})

	mux := http.NewServeMux()

	// Public routes — no JWT required.
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /sovereign/models", h.SovereignModels)

	// Razorpay payment webhook — no JWT; identity verified via HMAC-SHA256 signature.
	mux.Handle("POST /webhook/razorpay", billing.NewHandler(db))

	// Authenticated routes — JWT middleware validates the Bearer token and
	// overwrites X-Tenant-ID with the validated tenant_id claim.
	mux.Handle("POST /v1/chat", middleware.RequireJWT(http.HandlerFunc(h.Chat)))
	mux.Handle("GET /v1/models", middleware.RequireJWT(http.HandlerFunc(handleModels)))
	mux.Handle("GET /v1/usage", middleware.RequireJWT(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleUsage(w, r, quotaManager)
	})))

	// Sovereign (Indian AI) endpoints — authenticated.
	mux.Handle("POST /sovereign/v1/chat/completions", middleware.RequireJWT(http.HandlerFunc(h.SovereignChat)))

	addr := fmt.Sprintf(":%s", port)
	log.Printf("Tinai AI Gateway listening on %s", addr)

	srv := &http.Server{
		Addr:         addr,
		Handler:      corsMiddleware(maxBytesMiddleware(mux)),
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "ok",
		"service":   "tinai-gateway",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	type modelEntry struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
		Object   string `json:"object"`
	}
	var list []modelEntry
	for _, m := range models.Registry {
		if m.Available {
			list = append(list, modelEntry{
				ID:       m.ID,
				Provider: m.Provider,
				Object:   "model",
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data":   list,
	})
}

func handleUsage(w http.ResponseWriter, r *http.Request, qm *quota.Manager) {
	tenantID := r.Header.Get("X-Tenant-ID")
	if tenantID == "" {
		http.Error(w, `{"error":"X-Tenant-ID header required"}`, http.StatusBadRequest)
		return
	}

	stats, err := qm.GetUsageStats(r.Context(), tenantID)
	if err != nil {
		log.Printf("usage stats error for tenant %s: %v", tenantID, err)
		http.Error(w, `{"error":"failed to fetch usage"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// maxBytesMiddleware caps every request body at 1 MiB to prevent DoS via
// unbounded body reads. It is applied before CORS so all POST routes are
// protected, including /v1/chat and /sovereign/v1/chat/completions.
func maxBytesMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware sets CORS headers and handles OPTIONS preflight before any
// auth middleware runs, so browser preflight requests are never rejected.
func corsMiddleware(next http.Handler) http.Handler {
	rawOrigins := getEnv("CORS_ALLOWED_ORIGINS", "https://app.tinai.cloud,https://tinai.cloud")
	allowed := map[string]bool{}
	for _, o := range strings.Split(rawOrigins, ",") {
		allowed[strings.TrimSpace(o)] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tenant-ID")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
