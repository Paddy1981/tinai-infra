package watcher

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"go.uber.org/zap"

	"tinai.cloud/forge/config"
)

// ProductConfig defines a product to watch
type ProductConfig struct {
	Name           string
	Repo           string
	CurrentVersion string
	WatchMethod    string
}

// DefaultProducts are the upstream tools we track
var DefaultProducts = []ProductConfig{
	{Name: "forgejo", Repo: "forgejo/forgejo", CurrentVersion: "v1.22.6", WatchMethod: "github_releases"},
	{Name: "woodpecker", Repo: "woodpecker-ci/woodpecker", CurrentVersion: "v2.7.3", WatchMethod: "github_releases"},
	{Name: "grafana", Repo: "grafana/grafana", CurrentVersion: "v11.3.0", WatchMethod: "github_releases"},
	{Name: "prometheus", Repo: "prometheus/prometheus", CurrentVersion: "v2.55.0", WatchMethod: "github_releases"},
	{Name: "loki", Repo: "grafana/loki", CurrentVersion: "v3.3.0", WatchMethod: "github_releases"},
	{Name: "minio", Repo: "minio/minio", CurrentVersion: "RELEASE.2024-01-01", WatchMethod: "github_releases"},
	{Name: "cloudnativepg", Repo: "cloudnative-pg/cloudnative-pg", CurrentVersion: "v1.25.0", WatchMethod: "github_releases"},
	{Name: "cert-manager", Repo: "cert-manager/cert-manager", CurrentVersion: "v1.16.0", WatchMethod: "github_releases"},
	{Name: "keda", Repo: "kedacore/keda", CurrentVersion: "v2.16.0", WatchMethod: "github_releases"},
	{Name: "knative", Repo: "knative/serving", CurrentVersion: "v1.16.0", WatchMethod: "github_releases"},
	{Name: "ingress-nginx", Repo: "kubernetes/ingress-nginx", CurrentVersion: "v1.12.0", WatchMethod: "github_releases"},
}

// Scheduler checks for upstream updates
type Scheduler struct {
	watcher  *GitHubWatcher
	products []ProductConfig
	db       *sql.DB
	logger   *zap.Logger
	cfg      *config.Config
	cron     *cron.Cron
}

// NewScheduler creates a new scheduler
func NewScheduler(watcher *GitHubWatcher, db *sql.DB, logger *zap.Logger, cfg *config.Config) *Scheduler {
	return &Scheduler{
		watcher:  watcher,
		products: DefaultProducts,
		db:       db,
		logger:   logger,
		cfg:      cfg,
		cron:     cron.New(),
	}
}

// Start begins the scheduled watcher
func (s *Scheduler) Start(interval time.Duration) error {
	// Run immediately on startup
	s.checkAllProducts()

	// Schedule periodic checks
	spec := fmt.Sprintf("@every %dh", int(interval.Hours()))
	_, err := s.cron.AddFunc(spec, func() {
		s.checkAllProducts()
	})
	if err != nil {
		return fmt.Errorf("failed to add cron job: %w", err)
	}

	s.cron.Start()
	s.logger.Info("scheduler started", zap.Duration("interval", interval))
	return nil
}

// checkAllProducts checks all tracked products for updates
func (s *Scheduler) checkAllProducts() {
	s.logger.Info("checking upstream versions for all products")

	for _, product := range s.products {
		if err := s.CheckProduct(product); err != nil {
			s.logger.Error("failed to check product", zap.String("product", product.Name), zap.Error(err))
		}
	}
}

// CheckProduct checks a single product for updates
func (s *Scheduler) CheckProduct(product ProductConfig) error {
	s.logger.Debug("checking product", zap.String("product", product.Name))

	// Fetch latest release
	latestRelease, err := s.watcher.GetLatestRelease(product.Repo)
	if err != nil {
		return fmt.Errorf("failed to get latest release for %s: %w", product.Name, err)
	}

	currentVersion := product.CurrentVersion

	// Check if there's an update
	if latestRelease.TagName == currentVersion {
		s.logger.Debug("product up to date", zap.String("product", product.Name), zap.String("version", currentVersion))
		// Update last_checked_at
		_, _ = s.db.Exec(
			"UPDATE forge_products SET last_checked_at = NOW() WHERE id = $1",
			product.Name,
		)
		return nil
	}

	upgradeType := s.ClassifyUpgrade(currentVersion, latestRelease.TagName)
	s.logger.Info("update available",
		zap.String("product", product.Name),
		zap.String("from", currentVersion),
		zap.String("to", latestRelease.TagName),
		zap.String("type", upgradeType),
	)

	// Check if we should auto-build
	shouldBuild := false
	switch upgradeType {
	case "patch":
		shouldBuild = s.cfg.AutoBuildPatch
	case "minor":
		shouldBuild = s.cfg.AutoBuildMinor
	case "major":
		// Major updates always require manual approval
		shouldBuild = false
	}

	// Update database
	_, err = s.db.Exec(
		`INSERT INTO forge_products (id, name, repo, current_version, latest_version, status, last_checked_at)
		 VALUES ($1, $2, $3, $4, $5, $6, NOW())
		 ON CONFLICT (id) DO UPDATE SET
		   latest_version = EXCLUDED.latest_version,
		   status = EXCLUDED.status,
		   last_checked_at = NOW()`,
		product.Name,
		product.Name,
		product.Repo,
		currentVersion,
		latestRelease.TagName,
		"update_available",
	)
	if err != nil {
		return fmt.Errorf("failed to update database: %w", err)
	}

	// Trigger auto-build if enabled
	if shouldBuild {
		s.logger.Info("triggering auto-build", zap.String("product", product.Name), zap.String("version", latestRelease.TagName))
		// In production, this would queue a build job
		// For now, just log the intent
	}

	return nil
}

// ClassifyUpgrade determines the type of upgrade (patch, minor, major)
func (s *Scheduler) ClassifyUpgrade(from, to string) string {
	// Simple heuristic: extract version numbers and compare
	// In production, use a proper semver parser

	fromParts := parseVersion(from)
	toParts := parseVersion(to)

	if len(fromParts) < 3 || len(toParts) < 3 {
		return "unknown"
	}

	if toParts[0] != fromParts[0] {
		return "major"
	}
	if toParts[1] != fromParts[1] {
		return "minor"
	}
	return "patch"
}

// parseVersion extracts numeric parts from a version string
func parseVersion(version string) []int {
	// Remove 'v' prefix
	version = strings.TrimPrefix(version, "v")

	// Split on dots and dashes
	parts := strings.FieldsFunc(version, func(r rune) bool {
		return r == '.' || r == '-'
	})

	var result []int
	for i := 0; i < len(parts) && i < 3; i++ {
		var num int
		fmt.Sscanf(parts[i], "%d", &num)
		result = append(result, num)
	}

	return result
}

// Stop gracefully stops the scheduler
func (s *Scheduler) Stop() {
	s.cron.Stop()
	s.logger.Info("scheduler stopped")
}
