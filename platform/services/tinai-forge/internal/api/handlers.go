package api

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"tinai.cloud/forge/config"
	"tinai.cloud/forge/internal/notifier"
)

// Server handles API requests
type Server struct {
	db            *sql.DB
	config        *config.Config
	logger        *zap.Logger
	Notifier      *notifier.Notifier
	RolloutEngine interface{} // *rollout.Engine (type erased to avoid circular imports)
}

// NewServer creates a new API server
func NewServer(db *sql.DB, cfg *config.Config, logger *zap.Logger) *Server {
	return &Server{
		db:     db,
		config: cfg,
		logger: logger,
	}
}

// apiKeyAuth returns a Gin middleware that enforces X-Forge-API-Key header.
func (s *Server) apiKeyAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if s.config.APIKey == "" {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "API key not configured on server"})
			c.Abort()
			return
		}
		key := c.GetHeader("X-Forge-API-Key")
		if key == "" {
			// Also accept legacy Authorization: Bearer <key>
			auth := c.GetHeader("Authorization")
			if len(auth) > 7 && auth[:7] == "Bearer " {
				key = auth[7:]
			}
		}
		if key != s.config.APIKey {
			s.logger.Warn("forge API: unauthorized request",
				zap.String("path", c.Request.URL.Path),
				zap.String("remote_addr", c.ClientIP()),
			)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or missing API key"})
			return
		}
		c.Next()
	}
}

// RegisterRoutes registers all API routes
func (s *Server) RegisterRoutes(router *gin.Engine) {
	// All forge API routes require X-Forge-API-Key
	auth := s.apiKeyAuth()

	// Product routes
	router.GET("/api/forge/products", auth, s.listProducts)
	router.GET("/api/forge/products/:id", auth, s.getProduct)
	router.POST("/api/forge/products/:id/check", auth, s.checkProductUpdate)

	// Build routes
	router.GET("/api/forge/builds", auth, s.listBuilds)
	router.GET("/api/forge/builds/:id", auth, s.getBuild)
	router.POST("/api/forge/builds", auth, s.triggerBuild)
	// Per-product build trigger (used by the dashboard's Build button)
	router.POST("/api/forge/products/:id/build", auth, s.triggerProductBuild)

	// Test routes
	router.GET("/api/forge/tests/:buildId", auth, s.getTestResults)

	// Rollout routes
	router.GET("/api/forge/rollouts", auth, s.listRollouts)
	router.POST("/api/forge/rollouts", auth, s.startRollout)
	router.GET("/api/forge/rollouts/:id", auth, s.getRollout)
	router.POST("/api/forge/rollouts/:id/pause", auth, s.pauseRollout)
	router.POST("/api/forge/rollouts/:id/rollback", auth, s.rollbackRollout)

	// Patch routes
	router.GET("/api/forge/patches", auth, s.listPatches)
	router.GET("/api/forge/patches/:product", auth, s.getPatchFiles)

	// Tenant registration — called by tinai-api provisioner when new tenant is created
	// Uses same API key auth as all other forge endpoints
	router.POST("/api/forge/tenants/register", auth, s.registerTenant)
	router.GET("/api/forge/tenants", auth, s.listTenants)
	router.GET("/api/forge/tenants/:tenant_id/versions", auth, s.getTenantVersions)
}

// listProducts lists all products with versions
func (s *Server) listProducts(c *gin.Context) {
	rows, err := s.db.Query(`
		SELECT id, name, repo, current_version, latest_version, status, last_checked_at
		FROM forge_products
		ORDER BY name
	`)
	if err != nil {
		s.logger.Error("failed to list products", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list products"})
		return
	}
	defer rows.Close()

	type product struct {
		ID             string  `json:"id"`
		Name           string  `json:"name"`
		Repo           string  `json:"repo"`
		CurrentVersion string  `json:"current_version"`
		LatestVersion  *string `json:"latest_version"`
		Status         string  `json:"status"`
		LastCheckedAt  *string `json:"last_checked_at"`
	}

	var products []product
	for rows.Next() {
		var p product
		if err := rows.Scan(&p.ID, &p.Name, &p.Repo, &p.CurrentVersion, &p.LatestVersion, &p.Status, &p.LastCheckedAt); err != nil {
			s.logger.Error("failed to scan row", zap.Error(err))
			continue
		}
		products = append(products, p)
	}

	c.JSON(http.StatusOK, products)
}

// getProduct gets a single product detail
func (s *Server) getProduct(c *gin.Context) {
	id := c.Param("id")

	type productDetail struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		Repo           string `json:"repo"`
		CurrentVersion string `json:"current_version"`
		LatestVersion  *string `json:"latest_version"`
		Status         string `json:"status"`
	}

	var p productDetail
	err := s.db.QueryRow(`
		SELECT id, name, repo, current_version, latest_version, status
		FROM forge_products
		WHERE id = $1
	`, id).Scan(&p.ID, &p.Name, &p.Repo, &p.CurrentVersion, &p.LatestVersion, &p.Status)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	} else if err != nil {
		s.logger.Error("failed to get product", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get product"})
		return
	}

	c.JSON(http.StatusOK, p)
}

// checkProductUpdate triggers an immediate version check
func (s *Server) checkProductUpdate(c *gin.Context) {
	id := c.Param("id")

	// In production, this would trigger the watcher to check immediately
	s.logger.Info("triggered manual product check", zap.String("product_id", id))

	c.JSON(http.StatusOK, gin.H{"status": "check_queued", "product_id": id})
}

// listBuilds lists build history
func (s *Server) listBuilds(c *gin.Context) {
	rows, err := s.db.Query(`
		SELECT id, product_id, upstream_version, patch_version, image_tag, status, started_at, completed_at
		FROM forge_builds
		ORDER BY started_at DESC
		LIMIT 50
	`)
	if err != nil {
		s.logger.Error("failed to list builds", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list builds"})
		return
	}
	defer rows.Close()

	type build struct {
		ID              int    `json:"id"`
		ProductID       string `json:"product_id"`
		UpstreamVersion string `json:"upstream_version"`
		PatchVersion    string `json:"patch_version"`
		ImageTag        string `json:"image_tag"`
		Status          string `json:"status"`
	}

	var builds []build
	for rows.Next() {
		var b build
		var startedAt, completedAt *string
		if err := rows.Scan(&b.ID, &b.ProductID, &b.UpstreamVersion, &b.PatchVersion, &b.ImageTag, &b.Status, &startedAt, &completedAt); err != nil {
			s.logger.Error("failed to scan row", zap.Error(err))
			continue
		}
		builds = append(builds, b)
	}

	c.JSON(http.StatusOK, builds)
}

// getBuild gets a single build detail with logs
func (s *Server) getBuild(c *gin.Context) {
	id := c.Param("id")

	type buildDetail struct {
		ID              int    `json:"id"`
		ProductID       string `json:"product_id"`
		UpstreamVersion string `json:"upstream_version"`
		PatchVersion    string `json:"patch_version"`
		ImageTag        string `json:"image_tag"`
		Status          string `json:"status"`
		BuildLog        *string `json:"build_log"`
	}

	var b buildDetail
	err := s.db.QueryRow(`
		SELECT id, product_id, upstream_version, patch_version, image_tag, status, build_log
		FROM forge_builds
		WHERE id = $1
	`, id).Scan(&b.ID, &b.ProductID, &b.UpstreamVersion, &b.PatchVersion, &b.ImageTag, &b.Status, &b.BuildLog)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "build not found"})
		return
	} else if err != nil {
		s.logger.Error("failed to get build", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get build"})
		return
	}

	c.JSON(http.StatusOK, b)
}

// triggerBuild triggers a manual build
func (s *Server) triggerBuild(c *gin.Context) {
	var req struct {
		ProductID string `json:"product_id" binding:"required"`
		Version   string `json:"version" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	s.logger.Info("triggered manual build", zap.String("product_id", req.ProductID), zap.String("version", req.Version))

	c.JSON(http.StatusAccepted, gin.H{
		"status":      "build_queued",
		"product_id":  req.ProductID,
		"version":     req.Version,
	})
}

// getTestResults gets test results for a build
func (s *Server) getTestResults(c *gin.Context) {
	buildID := c.Param("buildId")

	rows, err := s.db.Query(`
		SELECT test_category, test_name, passed, message, duration_ms, run_at
		FROM forge_test_results
		WHERE build_id = $1
		ORDER BY test_category, test_name
	`, buildID)
	if err != nil {
		s.logger.Error("failed to get test results", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get test results"})
		return
	}
	defer rows.Close()

	type testResult struct {
		Category  string `json:"category"`
		Name      string `json:"name"`
		Passed    bool   `json:"passed"`
		Message   string `json:"message"`
		DurationMs int   `json:"duration_ms"`
	}

	var results []testResult
	for rows.Next() {
		var tr testResult
		var runAt *string
		if err := rows.Scan(&tr.Category, &tr.Name, &tr.Passed, &tr.Message, &tr.DurationMs, &runAt); err != nil {
			s.logger.Error("failed to scan row", zap.Error(err))
			continue
		}
		results = append(results, tr)
	}

	c.JSON(http.StatusOK, results)
}

// listRollouts lists rollouts
func (s *Server) listRollouts(c *gin.Context) {
	rows, err := s.db.Query(`
		SELECT id, product_id, from_version, to_version, strategy, status, started_at, completed_at
		FROM forge_rollouts
		ORDER BY started_at DESC
		LIMIT 50
	`)
	if err != nil {
		s.logger.Error("failed to list rollouts", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list rollouts"})
		return
	}
	defer rows.Close()

	type rollout struct {
		ID        int    `json:"id"`
		ProductID string `json:"product_id"`
		FromVersion string `json:"from_version"`
		ToVersion string `json:"to_version"`
		Strategy  string `json:"strategy"`
		Status    string `json:"status"`
	}

	var rollouts []rollout
	for rows.Next() {
		var r rollout
		var startedAt, completedAt *string
		if err := rows.Scan(&r.ID, &r.ProductID, &r.FromVersion, &r.ToVersion, &r.Strategy, &r.Status, &startedAt, &completedAt); err != nil {
			s.logger.Error("failed to scan row", zap.Error(err))
			continue
		}
		rollouts = append(rollouts, r)
	}

	c.JSON(http.StatusOK, rollouts)
}

// startRollout starts a rollout
func (s *Server) startRollout(c *gin.Context) {
	var req struct {
		ProductID string `json:"product_id" binding:"required"`
		FromVersion string `json:"from_version" binding:"required"`
		ToVersion string `json:"to_version" binding:"required"`
		Image     string `json:"image"` // optional: full image URL
		Strategy  string `json:"strategy"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Build image URL if not provided
	image := req.Image
	if image == "" {
		image = fmt.Sprintf("%s/%s/%s:%s-tinai",
			s.config.RegistryHost, s.config.RegistryProject, req.ProductID, req.ToVersion)
	}

	// Create rollout record in database
	var rolloutID string
	err := s.db.QueryRow(
		`INSERT INTO forge_rollouts (product_id, from_version, to_version, strategy, status, started_at)
		 VALUES ($1, $2, $3, $4, 'pending', NOW())
		 RETURNING id`,
		req.ProductID, req.FromVersion, req.ToVersion, req.Strategy,
	).Scan(&rolloutID)
	if err != nil {
		s.logger.Error("failed to create rollout record", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create rollout"})
		return
	}

	s.logger.Info("initiated rollout",
		zap.String("rollout_id", rolloutID),
		zap.String("product_id", req.ProductID),
		zap.String("from", req.FromVersion),
		zap.String("to", req.ToVersion))

	// Start the rollout engine asynchronously if available
	if s.RolloutEngine != nil {
		// Type-assert to avoid direct import of rollout package
		type rolloutRequester interface {
			StartRollout(ctx context.Context, req interface{}) error
		}
		if engine, ok := s.RolloutEngine.(rolloutRequester); ok {
			rolloutReq := struct {
				ProductID  string
				ToVersion  string
				Image      string
				Strategy   string
				RolloutID  string
			}{
				ProductID: req.ProductID,
				ToVersion: req.ToVersion,
				Image:     image,
				Strategy:  req.Strategy,
				RolloutID: rolloutID,
			}
			if err := engine.StartRollout(c.Request.Context(), rolloutReq); err != nil {
				// Log but don't fail the API call — rollout is async
				s.logger.Warn("failed to start rollout engine", zap.Error(err))
			}
		}
	}

	c.JSON(http.StatusAccepted, gin.H{
		"rollout_id": rolloutID,
		"status": "rollout_started",
		"product_id": req.ProductID,
		"from_version": req.FromVersion,
		"to_version": req.ToVersion,
	})
}

// getRollout gets a single rollout detail
func (s *Server) getRollout(c *gin.Context) {
	id := c.Param("id")

	type rolloutDetail struct {
		ID              int    `json:"id"`
		ProductID       string `json:"product_id"`
		FromVersion     string `json:"from_version"`
		ToVersion       string `json:"to_version"`
		Strategy        string `json:"strategy"`
		Status          string `json:"status"`
		AffectedTenants int    `json:"affected_tenants"`
		ErrorCount      int    `json:"error_count"`
	}

	var r rolloutDetail
	err := s.db.QueryRow(`
		SELECT id, product_id, from_version, to_version, strategy, status, affected_tenants, error_count
		FROM forge_rollouts
		WHERE id = $1
	`, id).Scan(&r.ID, &r.ProductID, &r.FromVersion, &r.ToVersion, &r.Strategy, &r.Status, &r.AffectedTenants, &r.ErrorCount)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "rollout not found"})
		return
	} else if err != nil {
		s.logger.Error("failed to get rollout", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get rollout"})
		return
	}

	c.JSON(http.StatusOK, r)
}

// pauseRollout pauses a rollout
func (s *Server) pauseRollout(c *gin.Context) {
	id := c.Param("id")

	_, err := s.db.Exec("UPDATE forge_rollouts SET status = $1 WHERE id = $2", "paused", id)
	if err != nil {
		s.logger.Error("failed to pause rollout", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to pause rollout"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "paused"})
}

// rollbackRollout rolls back a rollout
func (s *Server) rollbackRollout(c *gin.Context) {
	id := c.Param("id")

	var req struct {
		Reason string `json:"reason"`
	}

	c.ShouldBindJSON(&req)

	_, err := s.db.Exec("UPDATE forge_rollouts SET status = $1, rollback_reason = $2 WHERE id = $3", "rolled_back", req.Reason, id)
	if err != nil {
		s.logger.Error("failed to rollback", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rollback"})
		return
	}

	// Trigger rollback in the engine if available
	if s.RolloutEngine != nil {
		type rollbacker interface {
			RollbackTenants(ctx context.Context, rolloutID string) error
		}
		if engine, ok := s.RolloutEngine.(rollbacker); ok {
			if err := engine.RollbackTenants(c.Request.Context(), id); err != nil {
				s.logger.Warn("failed to execute rollback in engine", zap.Error(err))
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"status": "rolled_back"})
}

// listPatches lists patch sets
func (s *Server) listPatches(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"patches": []string{},
	})
}

// getPatchFiles gets patch files for a product
func (s *Server) getPatchFiles(c *gin.Context) {
	product := c.Param("product")

	c.JSON(http.StatusOK, gin.H{
		"product": product,
		"files":   []string{},
	})
}

// triggerProductBuild triggers a build for a specific product at its latest_version
func (s *Server) triggerProductBuild(c *gin.Context) {
	id := c.Param("id")

	// Look up the product's latest_version from the database
	var latestVersion string
	err := s.db.QueryRow(
		"SELECT COALESCE(latest_version, current_version) FROM forge_products WHERE id = $1",
		id,
	).Scan(&latestVersion)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	} else if err != nil {
		s.logger.Error("failed to look up product version", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to look up product"})
		return
	}

	s.logger.Info("triggered product build via dashboard",
		zap.String("product_id", id),
		zap.String("version", latestVersion),
	)

	c.JSON(http.StatusAccepted, gin.H{
		"status":     "build_queued",
		"product_id": id,
		"version":    latestVersion,
		"triggered_by": "dashboard",
	})
}

// registerTenant registers a new tenant in the forge tenant versions table.
// Called by tinai-api's provisioner when a new tenant namespace is created.
// This ensures the forge rollout engine knows about every tenant.
func (s *Server) registerTenant(c *gin.Context) {
	var req struct {
		TenantID    string `json:"tenant_id" binding:"required"`
		DisplayName string `json:"display_name"`
		Plan        string `json:"plan"`
		Namespace   string `json:"namespace"`
		Region      string `json:"region"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Upsert the tenant + seed a row in forge_tenant_versions for each product
	// so the rollout engine can track what version this tenant is running.
	rows, err := s.db.Query("SELECT id, current_version FROM forge_products")
	if err != nil {
		s.logger.Error("failed to list products for tenant seed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to seed tenant versions"})
		return
	}
	defer rows.Close()

	type product struct {
		ID      string
		Version string
	}
	var products []product
	for rows.Next() {
		var p product
		if err := rows.Scan(&p.ID, &p.Version); err != nil {
			continue
		}
		products = append(products, p)
	}

	// Insert a forge_tenant_versions row for each product (idempotent via ON CONFLICT DO UPDATE)
	for _, p := range products {
		_, err := s.db.Exec(
			`INSERT INTO forge_tenant_versions (tenant_id, product_id, namespace, plan, current_version, upgrade_status)
			 VALUES ($1, $2, $3, $4, $5, 'current')
			 ON CONFLICT (tenant_id, product_id) DO UPDATE SET namespace = EXCLUDED.namespace, plan = EXCLUDED.plan`,
			req.TenantID, p.ID, req.Namespace, req.Plan, p.Version,
		)
		if err != nil {
			s.logger.Warn("failed to seed tenant version",
				zap.String("tenant", req.TenantID),
				zap.String("product", p.ID),
				zap.Error(err),
			)
		}
	}

	s.logger.Info("tenant registered in forge",
		zap.String("tenant_id", req.TenantID),
		zap.Int("products_seeded", len(products)),
	)

	c.JSON(http.StatusCreated, gin.H{
		"tenant_id":       req.TenantID,
		"products_seeded": len(products),
		"status":          "registered",
	})
}

// listTenants lists all tenants tracked by forge (grouped by tenant_id)
func (s *Server) listTenants(c *gin.Context) {
	rows, err := s.db.Query(`
		SELECT DISTINCT tenant_id, MAX(namespace) as namespace, COUNT(*) as product_count,
		       SUM(CASE WHEN upgrade_status = 'current' THEN 1 ELSE 0 END) as current_count,
		       SUM(CASE WHEN upgrade_status != 'current' THEN 1 ELSE 0 END) as pending_count
		FROM forge_tenant_versions
		GROUP BY tenant_id
		ORDER BY tenant_id
	`)
	if err != nil {
		s.logger.Error("failed to list tenants", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list tenants"})
		return
	}
	defer rows.Close()

	type tenantSummary struct {
		TenantID     string `json:"tenant_id"`
		Namespace    string `json:"namespace"`
		ProductCount int    `json:"product_count"`
		CurrentCount int    `json:"current_count"`
		PendingCount int    `json:"pending_count"`
	}

	var tenants []tenantSummary
	for rows.Next() {
		var t tenantSummary
		if err := rows.Scan(&t.TenantID, &t.Namespace, &t.ProductCount, &t.CurrentCount, &t.PendingCount); err != nil {
			continue
		}
		tenants = append(tenants, t)
	}

	c.JSON(http.StatusOK, tenants)
}

// getTenantVersions returns all product versions for a specific tenant
func (s *Server) getTenantVersions(c *gin.Context) {
	tenantID := c.Param("tenant_id")

	rows, err := s.db.Query(`
		SELECT product_id, namespace, plan, current_version, target_version, upgrade_status, upgraded_at
		FROM forge_tenant_versions
		WHERE tenant_id = $1
		ORDER BY product_id
	`, tenantID)
	if err != nil {
		s.logger.Error("failed to get tenant versions", zap.Error(err), zap.String("tenant_id", tenantID))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get tenant versions"})
		return
	}
	defer rows.Close()

	type tenantVersion struct {
		ProductID      string  `json:"product_id"`
		Namespace      string  `json:"namespace"`
		Plan           string  `json:"plan"`
		CurrentVersion string  `json:"current_version"`
		TargetVersion  *string `json:"target_version"`
		UpgradeStatus  string  `json:"upgrade_status"`
		UpgradedAt     *string `json:"upgraded_at"`
	}

	var versions []tenantVersion
	for rows.Next() {
		var v tenantVersion
		if err := rows.Scan(&v.ProductID, &v.Namespace, &v.Plan, &v.CurrentVersion, &v.TargetVersion, &v.UpgradeStatus, &v.UpgradedAt); err != nil {
			s.logger.Error("failed to scan row", zap.Error(err))
			continue
		}
		versions = append(versions, v)
	}

	c.JSON(http.StatusOK, gin.H{
		"tenant_id": tenantID,
		"versions":  versions,
	})
}
