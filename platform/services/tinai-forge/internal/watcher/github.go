package watcher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"
)

// Release represents a GitHub release
type Release struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	PublishedAt time.Time `json:"published_at"`
	Body        string    `json:"body"`
	Prerelease  bool      `json:"prerelease"`
	Draft       bool      `json:"draft"`
}

// GitHubWatcher fetches releases from GitHub API
type GitHubWatcher struct {
	client *http.Client
	token  string
	logger *zap.Logger
}

// NewGitHubWatcher creates a new GitHub watcher
func NewGitHubWatcher(token string, logger *zap.Logger) *GitHubWatcher {
	return &GitHubWatcher{
		client: &http.Client{Timeout: 30 * time.Second},
		token:  token,
		logger: logger,
	}
}

// GetLatestRelease fetches the latest stable release for a GitHub repo
func (w *GitHubWatcher) GetLatestRelease(repo string) (*Release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases", repo)
	req, err := http.NewRequestWithContext(context.Background(), "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if w.token != "" {
		req.Header.Set("Authorization", fmt.Sprintf("token %s", w.token))
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := w.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github api returned %d: %s", resp.StatusCode, string(body))
	}

	var releases []Release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Filter: skip drafts, pre-releases, RCs, alphas, betas
	for _, rel := range releases {
		if rel.Draft {
			continue
		}
		if rel.Prerelease {
			// Skip RCs, alphas, betas
			tag := strings.ToLower(rel.TagName)
			if strings.Contains(tag, "rc") || strings.Contains(tag, "alpha") ||
				strings.Contains(tag, "beta") || strings.Contains(tag, "dev") {
				continue
			}
		}
		return &rel, nil
	}

	return nil, fmt.Errorf("no stable releases found for %s", repo)
}

// GetReleasesSince returns releases newer than currentVersion
func (w *GitHubWatcher) GetReleasesSince(repo, currentVersion string) ([]Release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases", repo)
	req, err := http.NewRequestWithContext(context.Background(), "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if w.token != "" {
		req.Header.Set("Authorization", fmt.Sprintf("token %s", w.token))
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := w.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github api returned %d: %s", resp.StatusCode, string(body))
	}

	var releases []Release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Filter releases: stable only, and newer than currentVersion
	var result []Release
	for _, rel := range releases {
		if rel.Draft {
			continue
		}
		if rel.Prerelease {
			tag := strings.ToLower(rel.TagName)
			if strings.Contains(tag, "rc") || strings.Contains(tag, "alpha") ||
				strings.Contains(tag, "beta") || strings.Contains(tag, "dev") {
				continue
			}
		}
		// Simple version comparison: include only if tag is lexicographically
		// greater than currentVersion (v-prefixed semver sorts correctly this way)
		if rel.TagName > currentVersion {
			result = append(result, rel)
		}
	}

	// Sort by published time descending (newest first)
	sort.Slice(result, func(i, j int) bool {
		return result[i].PublishedAt.After(result[j].PublishedAt)
	})

	return result, nil
}
