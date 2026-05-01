package notifier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// Notifier sends callback events to tinai-api.
type Notifier struct {
	apiURL string
	apiKey string
	client *http.Client
	logger *zap.Logger
}

// New creates a new Notifier.
// apiURL is the tinai-api base URL, e.g. "http://tinai-api-svc.tinai-system.svc.cluster.local:3001"
// apiKey is the FORGE_API_KEY shared secret.
func New(apiURL, apiKey string, logger *zap.Logger) *Notifier {
	return &Notifier{
		apiURL: apiURL,
		apiKey: apiKey,
		client: &http.Client{Timeout: 10 * time.Second},
		logger: logger,
	}
}

// BuildCompletePayload is the payload sent when a build finishes.
type BuildCompletePayload struct {
	BuildID         string `json:"build_id"`
	Product         string `json:"product"`
	Version         string `json:"version"`
	Status          string `json:"status"`          // "success" | "failed"
	Image           string `json:"image"`
	CTSPassed       bool   `json:"cts_passed"`
	DurationSeconds int64  `json:"duration_seconds"`
	ErrorMessage    string `json:"error_message,omitempty"`
}

// RolloutCompletePayload is the payload sent when a rollout finishes.
type RolloutCompletePayload struct {
	RolloutID       string `json:"rollout_id"`
	Product         string `json:"product"`
	FromVersion     string `json:"from_version"`
	ToVersion       string `json:"to_version"`
	Status          string `json:"status"`           // "completed" | "rolled_back" | "failed"
	TenantsUpdated  int    `json:"tenants_updated"`
	TenantsFailed   int    `json:"tenants_failed"`
	DurationSeconds int64  `json:"duration_seconds"`
}

// NotifyBuildComplete sends build completion event to tinai-api.
// This is fire-and-forget from the caller's perspective — errors are logged but not returned.
func (n *Notifier) NotifyBuildComplete(payload BuildCompletePayload) {
	go func() {
		if err := n.post("/api/v1/forge/callbacks/build-complete", payload); err != nil {
			n.logger.Warn("failed to notify tinai-api of build completion",
				zap.String("build_id", payload.BuildID),
				zap.Error(err))
		} else {
			n.logger.Info("notified tinai-api: build complete",
				zap.String("build_id", payload.BuildID),
				zap.String("status", payload.Status))
		}
	}()
}

// NotifyRolloutComplete sends rollout completion event to tinai-api.
// This is fire-and-forget from the caller's perspective — errors are logged but not returned.
func (n *Notifier) NotifyRolloutComplete(payload RolloutCompletePayload) {
	go func() {
		if err := n.post("/api/v1/forge/callbacks/rollout-complete", payload); err != nil {
			n.logger.Warn("failed to notify tinai-api of rollout completion",
				zap.String("rollout_id", payload.RolloutID),
				zap.Error(err))
		} else {
			n.logger.Info("notified tinai-api: rollout complete",
				zap.String("rollout_id", payload.RolloutID),
				zap.String("status", payload.Status))
		}
	}()
}

// post sends a JSON POST request to tinai-api.
func (n *Notifier) post(path string, payload interface{}) error {
	if n.apiURL == "" {
		// tinai-api URL not configured — skip silently (forge may run standalone)
		return nil
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.apiURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forge-API-Key", n.apiKey)

	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("tinai-api returned %d for %s", resp.StatusCode, path)
	}
	return nil
}
