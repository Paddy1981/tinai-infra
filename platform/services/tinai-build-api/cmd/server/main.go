package main

import (
	"context"
	"log"
	"net/http"

	"tinai.cloud/build-api/internal/api"
	"tinai.cloud/build-api/internal/builder"
	"tinai.cloud/build-api/internal/config"
	"tinai.cloud/build-api/internal/webhook"
)

func main() {
	cfg := config.Load()

	if cfg.WebhookSecret == "" {
		log.Fatal("WEBHOOK_SECRET must be set; refusing to start without a configured webhook secret")
	}

	b, err := builder.New(cfg)
	if err != nil {
		log.Fatalf("builder init: %v", err)
	}

	// Recover any deploys that were missed while this pod was down (HIGH-BUILD-1).
	go b.ReconcileStaleBuilds(context.Background())

	// Register the PR preview webhook alongside the push webhook.
	prHandler := webhook.NewPRHandler(cfg, b)

	mux := http.NewServeMux()
	mux.Handle("/webhook/pr", prHandler)
	mux.Handle("/webhook", webhook.New(cfg, b))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	api.New(b.Deployer()).WithBuilder(b).Register(mux)

	log.Printf("tinai build-api listening on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, mux); err != nil {
		log.Fatal(err)
	}
}
