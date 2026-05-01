package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"tinai.cloud/build-api/internal/builder"
	"tinai.cloud/build-api/internal/config"
)

type PushEvent struct {
	Ref   string `json:"ref"`
	After string `json:"after"`
	Repository struct {
		FullName string   `json:"full_name"`
		CloneURL string   `json:"clone_url"`
		Topics   []string `json:"topics"`
	} `json:"repository"`
	HeadCommit struct {
		ID string `json:"id"`
	} `json:"head_commit"`
}

type Handler struct {
	cfg     config.Config
	builder *builder.Builder
}

func New(cfg config.Config, b *builder.Builder) *Handler {
	return &Handler{cfg: cfg, builder: b}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB — prevent DoS via huge bodies
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

	if r.Header.Get("X-Gitea-Event") != "push" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var push PushEvent
	if err := json.Unmarshal(body, &push); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}

	commit := push.After
	if commit == "" {
		commit = push.HeadCommit.ID
	}
	if len(commit) < 8 {
		http.Error(w, "invalid commit sha", http.StatusBadRequest)
		return
	}

	region := regionFromTopics(push.Repository.Topics)
	tenant := tenantFromRepo(push.Repository.FullName)
	log.Printf("build triggered: repo=%s commit=%s region=%s tenant=%s", push.Repository.FullName, commit[:8], region, tenant)

	if err := h.builder.TriggerBuild(r.Context(), push.Repository.FullName, push.Repository.CloneURL, commit, region, tenant); err != nil {
		log.Printf("build trigger failed: %v", err)
		http.Error(w, fmt.Sprintf("build trigger failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

// regionFromTopics extracts the deployment region from repository topics.
// Recognises "region-in"/"in", "region-qa"/"qa", "region-ae"/"ae".
// Defaults to "IN" (India) when no matching topic is found.
func regionFromTopics(topics []string) string {
	for _, t := range topics {
		switch strings.ToUpper(t) {
		case "REGION-IN", "IN":
			return "IN"
		case "REGION-QA", "QA":
			return "QA"
		case "REGION-AE", "AE":
			return "AE"
		}
	}
	return "IN"
}

// tenantFromRepo extracts the tenant ID from a repository full name (org/repo).
// For the "tinai-admin" org the tenant is returned as-is so the builder falls
// back to the shared staging namespace. For any other org the org name is the
// tenant ID.
func tenantFromRepo(repoFullName string) string {
	if idx := strings.Index(repoFullName, "/"); idx > 0 {
		return repoFullName[:idx]
	}
	return ""
}

func verifySignature(body []byte, sig, secret string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	// Gitea sends X-Gitea-Signature as a raw hex digest; X-Hub-Signature-256
	// uses the "sha256=<hex>" form. Accept both.
	sig = strings.TrimPrefix(sig, "sha256=")
	return hmac.Equal([]byte(sig), []byte(expected))
}
