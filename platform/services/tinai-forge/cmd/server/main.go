package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"go.uber.org/zap"

	"tinai.cloud/forge/config"
	"tinai.cloud/forge/internal/api"
	"tinai.cloud/forge/internal/db"
	"tinai.cloud/forge/internal/notifier"
	"tinai.cloud/forge/internal/rollout"
	"tinai.cloud/forge/internal/watcher"
)

func main() {
	// Initialize logger
	logger, err := zap.NewProduction()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		logger.Fatal("failed to load config", zap.Error(err))
	}

	// Validate configuration
	if err := cfg.Validate(); err != nil {
		logger.Fatal("invalid configuration", zap.Error(err))
	}

	// Connect to database
	database, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("failed to connect to database", zap.Error(err))
	}
	defer database.Close()

	// Initialize database schema
	if err := db.InitSchema(database); err != nil {
		logger.Fatal("failed to initialize database schema", zap.Error(err))
	}

	// Apply any pending migrations
	if err := db.RunMigrations(database, logger); err != nil {
		logger.Fatal("failed to run migrations", zap.Error(err))
	}

	// Test database connection
	if err := database.Ping(); err != nil {
		logger.Fatal("failed to ping database", zap.Error(err))
	}

	logger.Info("connected to database")

	// Initialize GitHub watcher
	githubWatcher := watcher.NewGitHubWatcher(cfg.GitHubToken, logger)

	// Initialize scheduler
	scheduler := watcher.NewScheduler(githubWatcher, database, logger, cfg)

	// Start background scheduler (6 hours)
	go func() {
		if err := scheduler.Start(time.Duration(cfg.CheckIntervalHours) * time.Hour); err != nil {
			logger.Error("scheduler error", zap.Error(err))
		}
	}()

	logger.Info("started upstream watcher", zap.Int("interval_hours", cfg.CheckIntervalHours))

	// Initialize rollout engine (non-fatal if k8s is unavailable)
	var rolloutEngine *rollout.Engine
	rolloutEngine, err = rollout.NewEngine(database, logger)
	if err != nil {
		logger.Warn("rollout engine init failed (k8s not available)", zap.Error(err))
		// Non-fatal: forge can run without k8s access (dev mode)
	}

	// Setup HTTP API
	gin.SetMode(gin.ReleaseMode)
	router := gin.Default()

	// Initialize notifier for callbacks to tinai-api
	notify := notifier.New(cfg.TinAIAPIURL, cfg.TinAIAPIKey, logger)

	// API handlers
	apiServer := api.NewServer(database, cfg, logger)
	apiServer.Notifier = notify
	apiServer.RolloutEngine = rolloutEngine
	apiServer.RegisterRoutes(router)

	// Health check endpoint
	// /healthz — consistent with tinai-api and tinai-build-api
	router.GET("/healthz", func(c *gin.Context) {
		if err := database.Ping(); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unhealthy", "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "healthy"})
	})
	// Keep /health as alias so old probes still work during rollout
	router.GET("/health", func(c *gin.Context) {
		if err := database.Ping(); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unhealthy", "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "healthy"})
	})

	// Start HTTP server
	httpServer := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.APIPort),
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("starting HTTP API server", zap.Int("port", cfg.APIPort))
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("HTTP server error", zap.Error(err))
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigChan
	logger.Info("received signal, shutting down", zap.String("signal", sig.String()))

	// Context with timeout for graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}

	logger.Info("server shutdown complete")
}
