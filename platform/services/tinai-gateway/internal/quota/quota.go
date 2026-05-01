// Package quota manages per-tenant spend limits and usage recording.
package quota

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// DefaultMonthlyLimitPaise is ₹1,000 expressed in paise (100 paise = ₹1).
const DefaultMonthlyLimitPaise int64 = 100_000

// Manager handles quota checks and usage recording.
type Manager struct {
	db *sql.DB // may be nil (no-op / allow-all mode)
}

// ModelUsage is per-model aggregated usage for the current month.
type ModelUsage struct {
	Model        string `json:"model"`
	Requests     int    `json:"requests"`
	InputTokens  int    `json:"input_tokens"`
	OutputTokens int    `json:"output_tokens"`
	CostPaise    int64  `json:"cost_paise"`
	CacheHits    int    `json:"cache_hits"`
}

// DailySpend is a per-day, per-model cost entry.
type DailySpend struct {
	Date      string `json:"date"`       // YYYY-MM-DD
	Model     string `json:"model"`
	CostPaise int64  `json:"cost_paise"`
}

// UsageStats is returned by GetUsageStats. Field names match the dashboard interface.
type UsageStats struct {
	MonthTotalPaise  int64        `json:"month_total_paise"`
	QuotaPaise       int64        `json:"quota_paise"`
	CacheSavedPaise  int64        `json:"cache_saved_paise"`
	CacheHitRate     float64      `json:"cache_hit_rate"`
	Models           []ModelUsage `json:"models"`
	Daily            []DailySpend `json:"daily"`
	PreferredModel   string       `json:"preferred_model,omitempty"`
}

// New returns a Manager. Pass nil db to run without persistence (all quota checks pass).
func New(db *sql.DB) *Manager {
	return &Manager{db: db}
}

// CheckQuota returns whether tenantID is within their monthly spend limit.
// If the database is unavailable it allows the request to proceed.
func (m *Manager) CheckQuota(ctx context.Context, tenantID string) (allowed bool, remainingPaise int64, err error) {
	if m.db == nil {
		return true, DefaultMonthlyLimitPaise, nil
	}

	// Fetch tenant's configured limit (or default).
	var limit int64
	err = m.db.QueryRowContext(ctx, `
		SELECT COALESCE(monthly_limit_paise, $1)
		FROM   gateway_quotas
		WHERE  tenant_id = $2
	`, DefaultMonthlyLimitPaise, tenantID).Scan(&limit)
	if err == sql.ErrNoRows {
		limit = DefaultMonthlyLimitPaise
		err = nil
	}
	if err != nil {
		return true, DefaultMonthlyLimitPaise, fmt.Errorf("quota: fetch limit: %w", err)
	}

	// Sum spend this calendar month.
	var used int64
	err = m.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(cost_paise), 0)
		FROM   gateway_usage
		WHERE  tenant_id = $1
		  AND  date_trunc('month', created_at) = date_trunc('month', NOW())
	`, tenantID).Scan(&used)
	if err != nil {
		return true, 0, fmt.Errorf("quota: sum usage: %w", err)
	}

	remaining := limit - used
	return remaining > 0, remaining, nil
}

// RecordUsage inserts a usage row for tenantID. Intended to be called in a goroutine.
func (m *Manager) RecordUsage(ctx context.Context, tenantID, modelID string, inputTokens, outputTokens int, costPaise int64, cacheHit bool) error {
	if m.db == nil {
		return nil
	}
	_, err := m.db.ExecContext(ctx, `
		INSERT INTO gateway_usage
		  (tenant_id, model_id, input_tokens, output_tokens, cost_paise, cache_hit, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
	`, tenantID, modelID, inputTokens, outputTokens, costPaise, cacheHit)
	if err != nil {
		return fmt.Errorf("quota: record usage: %w", err)
	}
	return nil
}

// PreferredModel returns the stored preferred and fallback model IDs for tenantID.
func (m *Manager) PreferredModel(ctx context.Context, tenantID string) (preferred, fallback string, err error) {
	if m.db == nil {
		return "", "llama3:8b", nil
	}
	err = m.db.QueryRowContext(ctx, `
		SELECT COALESCE(preferred_model, ''), COALESCE(fallback_model, 'llama3:8b')
		FROM   gateway_quotas
		WHERE  tenant_id = $1
	`, tenantID).Scan(&preferred, &fallback)
	if err == sql.ErrNoRows {
		return "", "llama3:8b", nil
	}
	return preferred, fallback, err
}

// GetUsageStats returns aggregated usage for tenantID this calendar month.
func (m *Manager) GetUsageStats(ctx context.Context, tenantID string) (*UsageStats, error) {
	stats := &UsageStats{
		QuotaPaise: DefaultMonthlyLimitPaise,
		Models:     []ModelUsage{},
		Daily:      []DailySpend{},
	}

	if m.db == nil {
		return stats, nil
	}

	// Fetch quota and preferred model.
	var preferredModel sql.NullString
	_ = m.db.QueryRowContext(ctx, `
		SELECT COALESCE(monthly_limit_paise, $1), preferred_model
		FROM   gateway_quotas
		WHERE  tenant_id = $2
	`, DefaultMonthlyLimitPaise, tenantID).Scan(&stats.QuotaPaise, &preferredModel)
	if preferredModel.Valid {
		stats.PreferredModel = preferredModel.String
	}

	// Month totals.
	var totalRequests, totalCacheHits int
	row := m.db.QueryRowContext(ctx, `
		SELECT
		  COALESCE(SUM(cost_paise), 0),
		  COUNT(*),
		  COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)
		FROM   gateway_usage
		WHERE  tenant_id = $1
		  AND  created_at >= date_trunc('month', NOW())
	`, tenantID)
	if err := row.Scan(&stats.MonthTotalPaise, &totalRequests, &totalCacheHits); err != nil {
		return nil, fmt.Errorf("usage stats totals: %w", err)
	}
	if totalRequests > 0 {
		stats.CacheHitRate = float64(totalCacheHits) / float64(totalRequests)
	}
	// Estimate cache savings: avg cost per non-cache request × cache hits.
	nonCacheRequests := totalRequests - totalCacheHits
	if nonCacheRequests > 0 {
		avgCostPaise := stats.MonthTotalPaise / int64(nonCacheRequests)
		stats.CacheSavedPaise = avgCostPaise * int64(totalCacheHits)
	}

	// Per-model breakdown.
	modelRows, err := m.db.QueryContext(ctx, `
		SELECT
		  model_id,
		  COUNT(*)                                              AS requests,
		  COALESCE(SUM(input_tokens), 0)                       AS input_tokens,
		  COALESCE(SUM(output_tokens), 0)                      AS output_tokens,
		  COALESCE(SUM(cost_paise), 0)                         AS cost_paise,
		  COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0) AS cache_hits
		FROM   gateway_usage
		WHERE  tenant_id = $1
		  AND  created_at >= date_trunc('month', NOW())
		GROUP  BY model_id
		ORDER  BY cost_paise DESC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("usage stats models: %w", err)
	}
	defer modelRows.Close()
	for modelRows.Next() {
		var mu ModelUsage
		if err := modelRows.Scan(&mu.Model, &mu.Requests, &mu.InputTokens, &mu.OutputTokens, &mu.CostPaise, &mu.CacheHits); err != nil {
			return nil, fmt.Errorf("usage stats model scan: %w", err)
		}
		stats.Models = append(stats.Models, mu)
	}

	// Daily spend (last 30 days).
	dailyRows, err := m.db.QueryContext(ctx, `
		SELECT
		  TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
		  model_id,
		  COALESCE(SUM(cost_paise), 0)                         AS cost_paise
		FROM   gateway_usage
		WHERE  tenant_id = $1
		  AND  created_at >= NOW() - INTERVAL '30 days'
		GROUP  BY date, model_id
		ORDER  BY date DESC, cost_paise DESC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("usage stats daily: %w", err)
	}
	defer dailyRows.Close()
	for dailyRows.Next() {
		var ds DailySpend
		if err := dailyRows.Scan(&ds.Date, &ds.Model, &ds.CostPaise); err != nil {
			return nil, fmt.Errorf("usage stats daily scan: %w", err)
		}
		stats.Daily = append(stats.Daily, ds)
	}

	return stats, nil
}

// nowMonth is a helper for test injection; production code uses NOW() in SQL.
func nowMonth() time.Time {
	t := time.Now().UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}
