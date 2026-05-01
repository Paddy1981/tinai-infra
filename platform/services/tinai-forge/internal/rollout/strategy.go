package rollout

import (
	"database/sql"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Strategy defines the rollout strategy
type Strategy string

const (
	StrategyBigBang Strategy = "bigbang"
	StrategyRolling Strategy = "rolling"
	StrategyCanary  Strategy = "canary"
	StrategyChoice  Strategy = "choice"
)

// RolloutPlan defines how to roll out an update
type RolloutPlan struct {
	Product          string
	FromVersion      string
	ToVersion        string
	Strategy         Strategy
	TenantCount      int
	BatchSize        int
	CanaryStages     []int
	StageDuration    time.Duration
}

// RolloutStatus tracks the current status of a rollout
type RolloutStatus struct {
	RolloutID       int
	Product         string
	FromVersion     string
	ToVersion       string
	Strategy        Strategy
	Status          string // pending, in_progress, completed, paused, rolled_back
	StartedAt       time.Time
	CompletedAt     *time.Time
	AffectedTenants int
	ErrorCount      int
	SuccessCount    int
	RollbackReason  string
}

// SelectStrategy chooses an appropriate rollout strategy based on tenant count
func SelectStrategy(tenantCount int) Strategy {
	switch {
	case tenantCount < 10:
		return StrategyBigBang
	case tenantCount < 100:
		return StrategyRolling
	default:
		return StrategyCanary
	}
}

// RolloutEngine manages rollouts
type RolloutEngine struct {
	db     *sql.DB
	logger *zap.Logger
}

// NewRolloutEngine creates a new rollout engine
func NewRolloutEngine(db *sql.DB, logger *zap.Logger) *RolloutEngine {
	return &RolloutEngine{
		db:     db,
		logger: logger,
	}
}

// Start initiates a rollout
func (re *RolloutEngine) Start(plan RolloutPlan) (int, error) {
	// Validate plan
	if plan.Product == "" || plan.FromVersion == "" || plan.ToVersion == "" {
		return 0, fmt.Errorf("invalid rollout plan: missing required fields")
	}

	// Get tenant count if not specified
	tenantCount := plan.TenantCount
	if tenantCount == 0 {
		var count int
		err := re.db.QueryRow(
			"SELECT COUNT(DISTINCT tenant_id) FROM forge_tenant_versions WHERE product_id = $1",
			plan.Product,
		).Scan(&count)
		if err != nil && err != sql.ErrNoRows {
			return 0, fmt.Errorf("failed to get tenant count: %w", err)
		}
		tenantCount = count
	}

	// Select strategy if not specified
	strategy := plan.Strategy
	if strategy == "" {
		strategy = SelectStrategy(tenantCount)
	}

	// Set default batch size for rolling
	batchSize := plan.BatchSize
	if batchSize == 0 && strategy == StrategyRolling {
		batchSize = (tenantCount / 5) + 1 // Roughly 5 batches
	}

	// Create rollout record
	var rolloutID int
	err := re.db.QueryRow(
		`INSERT INTO forge_rollouts (product_id, from_version, to_version, strategy, status, started_at, affected_tenants)
		 VALUES ($1, $2, $3, $4, $5, NOW(), $6)
		 RETURNING id`,
		plan.Product,
		plan.FromVersion,
		plan.ToVersion,
		string(strategy),
		"pending",
		tenantCount,
	).Scan(&rolloutID)

	if err != nil {
		return 0, fmt.Errorf("failed to create rollout record: %w", err)
	}

	re.logger.Info("created rollout",
		zap.Int("rollout_id", rolloutID),
		zap.String("product", plan.Product),
		zap.String("from_version", plan.FromVersion),
		zap.String("to_version", plan.ToVersion),
		zap.String("strategy", string(strategy)),
		zap.Int("tenant_count", tenantCount),
	)

	// Update rollout status to in_progress
	_, err = re.db.Exec(
		"UPDATE forge_rollouts SET status = $1 WHERE id = $2",
		"in_progress",
		rolloutID,
	)

	if err != nil {
		re.logger.Error("failed to update rollout status", zap.Error(err))
	}

	return rolloutID, nil
}

// GetStatus retrieves the status of a rollout
func (re *RolloutEngine) GetStatus(rolloutID int) (*RolloutStatus, error) {
	status := &RolloutStatus{}

	err := re.db.QueryRow(
		`SELECT id, product_id, from_version, to_version, strategy, status, started_at, completed_at, affected_tenants, error_count, rollback_reason
		 FROM forge_rollouts
		 WHERE id = $1`,
		rolloutID,
	).Scan(
		&status.RolloutID,
		&status.Product,
		&status.FromVersion,
		&status.ToVersion,
		&status.Strategy,
		&status.Status,
		&status.StartedAt,
		&status.CompletedAt,
		&status.AffectedTenants,
		&status.ErrorCount,
		&status.RollbackReason,
	)

	if err != nil {
		return nil, fmt.Errorf("failed to get rollout status: %w", err)
	}

	// Calculate success count
	status.SuccessCount = status.AffectedTenants - status.ErrorCount

	return status, nil
}

// Pause pauses a rollout
func (re *RolloutEngine) Pause(rolloutID int) error {
	result, err := re.db.Exec(
		"UPDATE forge_rollouts SET status = $1 WHERE id = $2 AND status = $3",
		"paused",
		rolloutID,
		"in_progress",
	)

	if err != nil {
		return fmt.Errorf("failed to pause rollout: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}

	if rows == 0 {
		return fmt.Errorf("rollout not found or not in progress")
	}

	re.logger.Info("paused rollout", zap.Int("rollout_id", rolloutID))
	return nil
}

// Rollback rolls back a rollout
func (re *RolloutEngine) Rollback(rolloutID int, reason string) error {
	now := time.Now()

	result, err := re.db.Exec(
		`UPDATE forge_rollouts
		 SET status = $1, completed_at = $2, rollback_reason = $3
		 WHERE id = $4 AND status IN ($5, $6)`,
		"rolled_back",
		now,
		reason,
		rolloutID,
		"in_progress",
		"paused",
	)

	if err != nil {
		return fmt.Errorf("failed to rollback: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}

	if rows == 0 {
		return fmt.Errorf("rollout not found or not in progress/paused")
	}

	// Revert tenant versions
	_, err = re.db.Exec(
		`UPDATE forge_tenant_versions
		 SET current_version = (
		   SELECT from_version FROM forge_rollouts WHERE id = $1
		 ),
		     upgrade_status = $2
		 WHERE product_id = (
		   SELECT product_id FROM forge_rollouts WHERE id = $1
		 ) AND upgrade_status = $3`,
		rolloutID,
		"current",
		"in_progress",
	)

	if err != nil {
		re.logger.Error("failed to revert tenant versions", zap.Error(err))
	}

	re.logger.Info("rolled back rollout", zap.Int("rollout_id", rolloutID), zap.String("reason", reason))
	return nil
}

// Complete marks a rollout as complete
func (re *RolloutEngine) Complete(rolloutID int) error {
	now := time.Now()

	_, err := re.db.Exec(
		"UPDATE forge_rollouts SET status = $1, completed_at = $2 WHERE id = $3",
		"completed",
		now,
		rolloutID,
	)

	if err != nil {
		return fmt.Errorf("failed to complete rollout: %w", err)
	}

	re.logger.Info("completed rollout", zap.Int("rollout_id", rolloutID))
	return nil
}
