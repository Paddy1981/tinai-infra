package webhook

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"

	"tinai.cloud/build-api/internal/builder"
	"tinai.cloud/build-api/internal/config"
)

// PRHandler handles pull_request webhook events delivered by Forgejo.
// Register it on a dedicated path so it does not interfere with the push
// webhook (Handler.ServeHTTP) which lives on the same mux.
type PRHandler struct {
	cfg     config.Config
	builder *builder.Builder
}

// NewPRHandler constructs a PRHandler ready to be mounted on an HTTP mux.
func NewPRHandler(cfg config.Config, b *builder.Builder) *PRHandler {
	return &PRHandler{cfg: cfg, builder: b}
}

// ServeHTTP implements http.Handler.
// It validates the X-Gitea-Event header, decodes the payload, and dispatches
// the event to HandlePREvent in a goroutine so the webhook returns 202 quickly.
func (h *PRHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	// HMAC signature verification is mandatory; reject if secret is unconfigured or
	// the provided signature does not match.
	if h.cfg.WebhookSecret == "" {
		http.Error(w, "webhook secret not configured", http.StatusInternalServerError)
		return
	}
	sig := r.Header.Get("X-Gitea-Signature")
	if !verifySignature(body, sig, h.cfg.WebhookSecret) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	// Only handle pull_request events; silently accept everything else so Forgejo
	// does not consider the delivery a failure when other event types are sent.
	if r.Header.Get("X-Gitea-Event") != "pull_request" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var event PREvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}

	log.Printf("PR event received: action=%s pr=#%d repo=%s", event.Action, event.Number, event.Repository.FullName)

	// Dispatch asynchronously; caller gets 202 Accepted immediately.
	go HandlePREvent(context.Background(), h.builder, h.cfg, event)

	w.WriteHeader(http.StatusAccepted)
}
