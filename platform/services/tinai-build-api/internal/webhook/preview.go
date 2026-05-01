package webhook

import (
	"context"
	"fmt"
	"log"
	"strings"

	"tinai.cloud/build-api/internal/builder"
	"tinai.cloud/build-api/internal/config"
)

// PREvent represents a Forgejo pull_request webhook payload.
// Forgejo uses the same wire format as Gitea for pull request events.
type PREvent struct {
	Action string `json:"action"` // "opened", "synchronize", "reopened", "closed"
	Number int    `json:"number"`
	PullRequest struct {
		ID   int `json:"id"`
		Head struct {
			SHA string `json:"sha"`
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	} `json:"pull_request"`
	Repository struct {
		FullName string   `json:"full_name"`
		CloneURL string   `json:"clone_url"`
		Topics   []string `json:"topics"`
	} `json:"repository"`
}

// PreviewNamespace returns the Kubernetes namespace name for a PR preview environment.
// Format: preview-{sanitized-app}-pr{N}
func PreviewNamespace(appName string, prNumber int) string {
	return fmt.Sprintf("preview-%s-pr%d", sanitizePreviewName(appName), prNumber)
}

// PreviewAppName returns the Kubernetes resource name (Deployment/Service/Ingress) for a PR preview.
// Format: {sanitized-app}-pr{N}
func PreviewAppName(appName string, prNumber int) string {
	return fmt.Sprintf("%s-pr%d", sanitizePreviewName(appName), prNumber)
}

// HandlePREvent processes a pull_request webhook event received from Forgejo.
// It is safe to call concurrently; each invocation runs independently.
//
//   - opened / synchronize / reopened → trigger a preview build+deploy
//   - closed (merged or abandoned)    → clean up the preview environment
func HandlePREvent(ctx context.Context, b *builder.Builder, cfg config.Config, event PREvent) {
	appName := sanitizePreviewName(event.Repository.FullName)
	previewNS := PreviewNamespace(appName, event.Number)
	previewName := PreviewAppName(appName, event.Number)

	switch event.Action {
	case "opened", "synchronize", "reopened":
		commit := event.PullRequest.Head.SHA
		if len(commit) < 8 {
			log.Printf("PR #%d: invalid commit SHA %q — skipping preview build", event.Number, commit)
			return
		}
		log.Printf("PR #%d %s: triggering preview deploy (ns=%s app=%s commit=%s)",
			event.Number, event.Action, previewNS, previewName, commit[:8])

		cloneURL := event.Repository.CloneURL
		if err := b.TriggerPreviewBuild(ctx, event.Repository.FullName, cloneURL, commit, previewNS, previewName, event.Number); err != nil {
			log.Printf("PR #%d: preview build trigger failed: %v", event.Number, err)
		}

	case "closed":
		log.Printf("PR #%d closed: cleaning up preview environment (ns=%s)", event.Number, previewNS)
		if err := b.CleanupPreview(ctx, previewNS, previewName); err != nil {
			log.Printf("PR #%d: cleanup failed: %v", event.Number, err)
		}

	default:
		// edited, labeled, etc. — nothing to do
		log.Printf("PR #%d: ignoring action %q", event.Number, event.Action)
	}
}

// sanitizePreviewName produces a DNS-safe, lowercase name no longer than 40 characters.
// Slashes (org/repo) are replaced with dashes.
func sanitizePreviewName(name string) string {
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.ToLower(name)
	if len(name) > 40 {
		name = name[:40]
	}
	return name
}
