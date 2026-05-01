package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tinai/tinai-functions/internal/api"
	"github.com/tinai/tinai-functions/internal/db"
	"github.com/tinai/tinai-functions/internal/runner"
	"github.com/tinai/tinai-functions/internal/store"

	_ "github.com/lib/pq"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

var (
	functionInvocations = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_function_invocations_total",
		Help: "Total function invocations by tenant and status",
	}, []string{"tenant", "status"}) // status: success, error, timeout

	functionDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "tinai_function_duration_seconds",
		Help:    "Function invocation duration",
		Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30},
	}, []string{"tenant"})

	deployedFunctions = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tinai_functions_deployed_total",
		Help: "Total deployed functions per tenant",
	}, []string{"tenant"})
)

func main() {
	// ── Environment ────────────────────────────────────────────────
	dbURL := mustEnv("DATABASE_URL")
	minioEndpoint := mustEnv("MINIO_ENDPOINT")
	minioAccess := mustEnv("MINIO_ACCESS_KEY")
	minioSecret := mustEnv("MINIO_SECRET_KEY")
	kubeconfig := os.Getenv("KUBECONFIG") // optional; falls back to in-cluster

	// ── PostgreSQL ─────────────────────────────────────────────────
	sqlDB, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(10)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		log.Fatalf("db ping: %v", err)
	}

	fnDB := db.New(sqlDB)
	if err := fnDB.Migrate(context.Background()); err != nil {
		log.Fatalf("db migrate: %v", err)
	}

	// ── MinIO ──────────────────────────────────────────────────────
	useSSL := !strings.HasPrefix(minioEndpoint, "localhost") &&
		!strings.HasPrefix(minioEndpoint, "127.")
	mc, err := minio.New(minioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(minioAccess, minioSecret, ""),
		Secure: useSSL,
	})
	if err != nil {
		log.Fatalf("minio init: %v", err)
	}
	fnStore := store.New(mc)

	// ── Kubernetes ─────────────────────────────────────────────────
	restCfg, k8sErr := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if k8sErr != nil {
		log.Printf("warn: k8s config failed (%v) — invoke route will error", k8sErr)
	}

	var fnRunner api.FunctionRunner
	if os.Getenv("KNATIVE_ENABLED") == "true" {
		// Knative mode: use dynamic client + KnativeRunner.
		if k8sErr != nil {
			log.Fatalf("KNATIVE_ENABLED=true but k8s config unavailable: %v", k8sErr)
		}
		dynClient, err := dynamic.NewForConfig(restCfg)
		if err != nil {
			log.Fatalf("dynamic k8s client: %v", err)
		}
		fnRunner = runner.NewKnative(dynClient)
		log.Printf("tinai-functions: using Knative runner (domain=%s)", os.Getenv("KNATIVE_DOMAIN"))
	} else {
		// Default mode: Job-based runner.
		var jobK8s *kubernetes.Clientset
		if k8sErr == nil {
			jobK8s, err = kubernetes.NewForConfig(restCfg)
			if err != nil {
				log.Printf("warn: k8s client init failed (%v) — invoke route will error", err)
			}
		}
		fnRunner = runner.New(jobK8s)
	}

	// ── HTTP mux ───────────────────────────────────────────────────
	h := api.NewHandler(&dbAdapter{inner: fnDB}, fnStore, fnRunner)

	// Wire Prometheus callbacks into the handler.
	h.OnInvoke = func(tenant, status string, durationSecs float64) {
		functionInvocations.WithLabelValues(tenant, status).Inc()
		functionDuration.WithLabelValues(tenant).Observe(durationSecs)
	}
	h.OnDeploy = func(tenant string, delta float64) {
		deployedFunctions.WithLabelValues(tenant).Add(delta)
	}

	mux := http.NewServeMux()

	// Function management
	mux.HandleFunc("POST /api/v1/functions", h.DeployFunction)
	mux.HandleFunc("GET /api/v1/functions", h.ListFunctions)

	// Named function routes — manual prefix dispatch to capture :name
	mux.HandleFunc("/api/v1/functions/", func(w http.ResponseWriter, r *http.Request) {
		// path: /api/v1/functions/{name}  or  /api/v1/functions/{name}/invoke
		tail := strings.TrimPrefix(r.URL.Path, "/api/v1/functions/")
		parts := strings.SplitN(tail, "/", 2)
		name := parts[0]
		if name == "" {
			http.NotFound(w, r)
			return
		}
		if len(parts) == 2 && parts[1] == "invoke" && r.Method == http.MethodPost {
			h.InvokeFunction(w, r, name)
			return
		}
		if len(parts) == 1 && r.Method == http.MethodGet {
			h.GetFunction(w, r, name)
			return
		}
		if len(parts) == 1 && r.Method == http.MethodDelete {
			h.DeleteFunction(w, r, name)
			return
		}
		http.NotFound(w, r)
	})

	// Fail fast if the JWT signing secret is absent — running without it would
	// leave all authenticated endpoints unprotected.
	if os.Getenv("JWT_SECRET") == "" {
		log.Fatal("FATAL: JWT_SECRET environment variable is not set — refusing to start")
	}

	// Public mux: health + metrics bypass JWT; all other paths require auth.
	publicMux := http.NewServeMux()
	publicMux.Handle("GET /metrics", promhttp.Handler())
	publicMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	})
	publicMux.Handle("/", api.JWTMiddleware(mux))

	addr := ":3004"
	srv := &http.Server{Addr: addr, Handler: publicMux}

	// Graceful shutdown on SIGTERM/SIGINT
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("tinai-functions: shutting down...")
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutCancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("tinai-functions listening on %s", addr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
	log.Printf("tinai-functions: shutdown complete")
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required env var %s is not set", key)
	}
	return v
}
