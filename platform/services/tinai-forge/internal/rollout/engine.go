package rollout

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"

	"go.uber.org/zap"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// StrategyAuto and StrategyBigBang constants for rollout strategies
const (
	StrategyAuto Strategy = "auto"
)

// Engine handles Kubernetes deployment patching during rollouts
type Engine struct {
	db        *sql.DB
	k8sClient *kubernetes.Clientset
	logger    *zap.Logger
}

// TenantVersion represents a tenant's version state for a product
type TenantVersion struct {
	TenantID       string
	Namespace      string
	ProductID      string
	CurrentVersion string
	Status         string
}

// RolloutRequest defines the parameters for starting a rollout
type RolloutRequest struct {
	ProductID  string
	ToVersion  string
	Image      string   // full image URL e.g. registry.e2enetworks.net/tinai/forgejo:v1.22.7-tinai
	Strategy   Strategy
	RolloutID  string
}

// NewEngine creates a rollout engine with an in-cluster k8s client.
// Falls back to kubeconfig if not running in a cluster.
// Returns a non-nil engine even if k8s client setup fails (for local dev mode).
func NewEngine(db *sql.DB, logger *zap.Logger) (*Engine, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		// Fallback: use default kubeconfig (useful for local dev/testing)
		loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
		configOverrides := &clientcmd.ConfigOverrides{}
		config, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			loadingRules, configOverrides).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("build k8s config: %w", err)
		}
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create k8s client: %w", err)
	}

	return &Engine{
		db:        db,
		k8sClient: clientset,
		logger:    logger,
	}, nil
}

// StartRollout begins a rollout in a goroutine and returns immediately.
// The actual patching happens asynchronously.
func (e *Engine) StartRollout(ctx context.Context, req RolloutRequest) error {
	// Load tenants that need updating
	tenants, err := e.loadTenantsForProduct(req.ProductID)
	if err != nil {
		return fmt.Errorf("load tenants: %w", err)
	}

	if len(tenants) == 0 {
		e.logger.Warn("no tenants found for product rollout",
			zap.String("product", req.ProductID))
		return nil
	}

	// Auto-select strategy if needed
	if req.Strategy == StrategyAuto || req.Strategy == "" {
		req.Strategy = SelectStrategy(len(tenants))
	}

	// Update rollout status to in_progress
	_, err = e.db.Exec(
		`UPDATE forge_rollouts SET status = 'in_progress', strategy = $1 WHERE id = $2`,
		string(req.Strategy), req.RolloutID,
	)
	if err != nil {
		e.logger.Warn("failed to update rollout status", zap.Error(err))
	}

	e.logger.Info("starting rollout",
		zap.String("rollout_id", req.RolloutID),
		zap.String("product", req.ProductID),
		zap.String("version", req.ToVersion),
		zap.String("strategy", string(req.Strategy)),
		zap.Int("total_tenants", len(tenants)),
	)

	// Execute rollout in background
	go e.executeRollout(req, tenants)

	return nil
}

func (e *Engine) executeRollout(req RolloutRequest, tenants []TenantVersion) {
	ctx := context.Background()
	startTime := time.Now()
	failed := 0
	updated := 0

	switch req.Strategy {
	case StrategyBigBang:
		updated, failed = e.executeBigBang(ctx, req, tenants)
	case StrategyRolling:
		updated, failed = e.executeRolling(ctx, req, tenants)
	case StrategyCanary:
		updated, failed = e.executeCanary(ctx, req, tenants)
	default:
		updated, failed = e.executeBigBang(ctx, req, tenants)
	}

	duration := int64(time.Since(startTime).Seconds())
	status := "completed"
	if failed > 0 && updated == 0 {
		status = "failed"
	} else if failed > 0 {
		status = "partially_completed"
	}

	// Update rollout final status
	_, err := e.db.Exec(
		`UPDATE forge_rollouts
		 SET status = $1, completed_at = NOW(),
		     completed_tenants = $2, failed_tenants = $3, duration_seconds = $4
		 WHERE id = $5`,
		status, updated, failed, duration, req.RolloutID,
	)
	if err != nil {
		e.logger.Error("failed to update rollout completion status", zap.Error(err))
	}

	e.logger.Info("rollout complete",
		zap.String("rollout_id", req.RolloutID),
		zap.String("status", status),
		zap.Int("updated", updated),
		zap.Int("failed", failed),
		zap.Int64("duration_s", duration),
	)
}

// executeBigBang updates all tenants concurrently.
func (e *Engine) executeBigBang(ctx context.Context, req RolloutRequest, tenants []TenantVersion) (int, int) {
	type result struct {
		tenantID string
		err      error
	}
	results := make(chan result, len(tenants))

	for _, t := range tenants {
		t := t
		go func() {
			err := e.patchTenantDeployment(ctx, t.Namespace, req.ProductID, req.Image)
			results <- result{tenantID: t.TenantID, err: err}
		}()
	}

	updated, failed := 0, 0
	for range tenants {
		r := <-results
		if r.err != nil {
			e.logger.Error("bigbang patch failed",
				zap.String("tenant", r.tenantID), zap.Error(r.err))
			e.updateTenantStatus(r.tenantID, req.ProductID, "failed")
			failed++
		} else {
			e.updateTenantStatus(r.tenantID, req.ProductID, "updated")
			updated++
		}
	}
	return updated, failed
}

// executeRolling updates tenants in ~10% batches.
func (e *Engine) executeRolling(ctx context.Context, req RolloutRequest, tenants []TenantVersion) (int, int) {
	batchSize := int(math.Ceil(float64(len(tenants)) * 0.1))
	if batchSize < 1 {
		batchSize = 1
	}

	updated, failed := 0, 0
	for i := 0; i < len(tenants); i += batchSize {
		end := i + batchSize
		if end > len(tenants) {
			end = len(tenants)
		}
		batch := tenants[i:end]

		e.logger.Info("rolling batch",
			zap.Int("batch_start", i),
			zap.Int("batch_size", len(batch)),
			zap.Int("total", len(tenants)))

		u, f := e.executeBigBang(ctx, req, batch)
		updated += u
		failed += f

		// Pause between batches to allow monitoring to catch errors
		if end < len(tenants) {
			time.Sleep(15 * time.Second)
		}
	}
	return updated, failed
}

// executeCanary updates 1% → 10% → 100%.
func (e *Engine) executeCanary(ctx context.Context, req RolloutRequest, tenants []TenantVersion) (int, int) {
	waves := []float64{0.01, 0.10, 1.0}
	delays := []time.Duration{2 * time.Minute, 5 * time.Minute, 0}

	updated, failed := 0, 0
	alreadyUpdated := 0

	for waveIdx, fraction := range waves {
		targetCount := int(math.Ceil(float64(len(tenants)) * fraction))
		if targetCount <= alreadyUpdated {
			continue
		}
		batch := tenants[alreadyUpdated:targetCount]

		e.logger.Info("canary wave",
			zap.Int("wave", waveIdx+1),
			zap.Float64("fraction", fraction),
			zap.Int("batch_size", len(batch)))

		u, f := e.executeBigBang(ctx, req, batch)
		updated += u
		failed += f
		alreadyUpdated = targetCount

		if failed > 0 {
			e.logger.Warn("canary wave had failures, stopping", zap.Int("failed", failed))
			break
		}

		if delays[waveIdx] > 0 {
			time.Sleep(delays[waveIdx])
		}
	}
	return updated, failed
}

// patchTenantDeployment updates the image of the named deployment in the tenant namespace.
// Uses JSON merge patch to update only the image field.
func (e *Engine) patchTenantDeployment(ctx context.Context, namespace, deploymentName, image string) error {
	// JSON merge patch to update the first container image
	patchData := fmt.Sprintf(`{"spec":{"template":{"spec":{"containers":[{"name":"%s","image":"%s"}]}}}}`,
		deploymentName, image)

	_, err := e.k8sClient.AppsV1().Deployments(namespace).Patch(
		ctx,
		deploymentName,
		types.MergePatchType,
		[]byte(patchData),
		metav1.PatchOptions{},
	)
	if err != nil {
		return fmt.Errorf("patch deployment %s/%s: %w", namespace, deploymentName, err)
	}

	e.logger.Info("patched tenant deployment",
		zap.String("namespace", namespace),
		zap.String("deployment", deploymentName),
		zap.String("image", image),
	)
	return nil
}

// RollbackTenants reverts all tenants in a rollout to the previous image.
func (e *Engine) RollbackTenants(ctx context.Context, rolloutID string) error {
	// Load rollout details
	var productID, fromVersion string
	err := e.db.QueryRow(
		`SELECT product_id, from_version FROM forge_rollouts WHERE id = $1`,
		rolloutID,
	).Scan(&productID, &fromVersion)
	if err != nil {
		return fmt.Errorf("load rollout: %w", err)
	}

	// Build previous image tag
	prevImage := fmt.Sprintf("registry.e2enetworks.net/tinai/%s:%s-tinai", productID, fromVersion)

	// Load tenants that were updated in this rollout
	rows, err := e.db.Query(
		`SELECT tenant_id, namespace FROM forge_tenant_versions
		 WHERE product_id = $1 AND status = 'updated'`,
		productID,
	)
	if err != nil {
		return fmt.Errorf("load updated tenants: %w", err)
	}
	defer rows.Close()

	var tenants []TenantVersion
	for rows.Next() {
		var t TenantVersion
		if err := rows.Scan(&t.TenantID, &t.Namespace); err != nil {
			continue
		}
		t.ProductID = productID
		tenants = append(tenants, t)
	}

	e.logger.Info("rolling back tenants",
		zap.String("rollout_id", rolloutID),
		zap.String("to_image", prevImage),
		zap.Int("tenants", len(tenants)))

	for _, t := range tenants {
		if err := e.patchTenantDeployment(ctx, t.Namespace, productID, prevImage); err != nil {
			e.logger.Error("rollback patch failed",
				zap.String("tenant", t.TenantID), zap.Error(err))
			continue
		}
		e.updateTenantStatus(t.TenantID, productID, "rolled_back")
	}

	// Update rollout status
	_, _ = e.db.Exec(
		`UPDATE forge_rollouts SET status = 'rolled_back', completed_at = NOW() WHERE id = $1`,
		rolloutID,
	)

	return nil
}

func (e *Engine) loadTenantsForProduct(productID string) ([]TenantVersion, error) {
	rows, err := e.db.Query(
		`SELECT tenant_id, namespace, current_version, status
		 FROM forge_tenant_versions
		 WHERE product_id = $1 AND namespace != ''
		 ORDER BY tenant_id`,
		productID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tenants []TenantVersion
	for rows.Next() {
		var t TenantVersion
		if err := rows.Scan(&t.TenantID, &t.Namespace, &t.CurrentVersion, &t.Status); err != nil {
			return nil, err
		}
		t.ProductID = productID
		tenants = append(tenants, t)
	}
	return tenants, rows.Err()
}

func (e *Engine) updateTenantStatus(tenantID, productID, status string) {
	_, err := e.db.Exec(
		`UPDATE forge_tenant_versions SET status = $1, updated_at = NOW()
		 WHERE tenant_id = $2 AND product_id = $3`,
		status, tenantID, productID,
	)
	if err != nil {
		e.logger.Error("failed to update tenant version status",
			zap.String("tenant", tenantID),
			zap.String("product", productID),
			zap.Error(err))
	}
}

// GetRolloutProgress returns completion counts for a rollout.
func (e *Engine) GetRolloutProgress(rolloutID string) (total, completed, failed int, err error) {
	err = e.db.QueryRow(
		`SELECT total_tenants, completed_tenants, failed_tenants
		 FROM forge_rollouts WHERE id = $1`,
		rolloutID,
	).Scan(&total, &completed, &failed)
	return
}
