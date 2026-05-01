package rollout

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// RolloutMetrics tracks metrics during a rollout
type RolloutMetrics struct {
	ErrorRate   float64
	LatencyP99  time.Duration
	CrashCount  int
	SuccessCount int
}

// Monitor queries Prometheus for rollout metrics
type Monitor struct {
	prometheusURL string
	logger        *zap.Logger
	client        *http.Client
}

// NewMonitor creates a new rollout monitor
func NewMonitor(prometheusURL string, logger *zap.Logger) *Monitor {
	return &Monitor{
		prometheusURL: prometheusURL,
		logger:        logger,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// GetMetrics queries Prometheus for error rates and latency during a rollout
func (m *Monitor) GetMetrics(product, namespace string) (*RolloutMetrics, error) {
	metrics := &RolloutMetrics{}

	// Query error rate
	errorRate, err := m.queryErrorRate(product, namespace)
	if err != nil {
		m.logger.Error("failed to query error rate", zap.Error(err))
		errorRate = 0
	}
	metrics.ErrorRate = errorRate

	// Query P99 latency
	latency, err := m.queryLatencyP99(product, namespace)
	if err != nil {
		m.logger.Error("failed to query latency", zap.Error(err))
		latency = 0
	}
	metrics.LatencyP99 = time.Duration(latency) * time.Millisecond

	// Query crash count
	crashes, err := m.queryCrashCount(product, namespace)
	if err != nil {
		m.logger.Error("failed to query crash count", zap.Error(err))
		crashes = 0
	}
	metrics.CrashCount = crashes

	return metrics, nil
}

// ShouldAutoRollback returns true if metrics indicate a rollback is needed
func (m *Monitor) ShouldAutoRollback(metrics *RolloutMetrics, threshold float64) bool {
	if metrics == nil {
		return false
	}

	// Rollback if error rate exceeds threshold
	if metrics.ErrorRate > threshold {
		m.logger.Warn("auto-rollback triggered: error rate threshold exceeded",
			zap.Float64("error_rate", metrics.ErrorRate),
			zap.Float64("threshold", threshold),
		)
		return true
	}

	// Rollback if we have excessive crashes
	if metrics.CrashCount > 5 {
		m.logger.Warn("auto-rollback triggered: excessive crashes",
			zap.Int("crash_count", metrics.CrashCount),
		)
		return true
	}

	// Rollback if latency spike
	if metrics.LatencyP99 > 10*time.Second {
		m.logger.Warn("auto-rollback triggered: latency spike",
			zap.Duration("latency_p99", metrics.LatencyP99),
		)
		return true
	}

	return false
}

// queryErrorRate queries the error rate from Prometheus
func (m *Monitor) queryErrorRate(product, namespace string) (float64, error) {
	query := fmt.Sprintf(
		`rate(http_requests_total{job="%s",namespace="%s",status=~"5.."}[5m])`,
		product,
		namespace,
	)

	return m.executeQuery(query)
}

// queryLatencyP99 queries the P99 latency from Prometheus
func (m *Monitor) queryLatencyP99(product, namespace string) (float64, error) {
	query := fmt.Sprintf(
		`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="%s",namespace="%s"}[5m]))`,
		product,
		namespace,
	)

	return m.executeQuery(query)
}

// queryCrashCount queries the number of container restarts
func (m *Monitor) queryCrashCount(product, namespace string) (int, error) {
	query := fmt.Sprintf(
		`increase(kube_pod_container_status_restarts_total{namespace="%s",pod=~"%s.*"}[5m])`,
		namespace,
		product,
	)

	result, err := m.executeQuery(query)
	if err != nil {
		return 0, err
	}

	return int(result), nil
}

// executeQuery executes a PromQL query
func (m *Monitor) executeQuery(query string) (float64, error) {
	url := fmt.Sprintf("%s/api/v1/query", m.prometheusURL)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to create request: %w", err)
	}

	q := req.URL.Query()
	q.Add("query", query)
	req.URL.RawQuery = q.Encode()

	resp, err := m.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("failed to execute query: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("prometheus returned %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var prometheusResp struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Value []interface{} `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&prometheusResp); err != nil {
		return 0, fmt.Errorf("failed to parse response: %w", err)
	}

	if prometheusResp.Status != "success" {
		return 0, fmt.Errorf("prometheus error: %s", prometheusResp.Status)
	}

	if len(prometheusResp.Data.Result) == 0 {
		return 0, nil
	}

	// Extract value from first result
	if len(prometheusResp.Data.Result[0].Value) < 2 {
		return 0, fmt.Errorf("unexpected prometheus response format")
	}

	valueStr, ok := prometheusResp.Data.Result[0].Value[1].(string)
	if !ok {
		return 0, fmt.Errorf("failed to parse value as string")
	}

	var value float64
	_, err = fmt.Sscanf(valueStr, "%f", &value)
	if err != nil {
		return 0, fmt.Errorf("failed to parse value as float: %w", err)
	}

	return value, nil
}

// GetTenantErrors retrieves errors for a specific tenant during rollout
func (m *Monitor) GetTenantErrors(tenantID string, since time.Time) ([]string, error) {
	// Query logs for tenant errors
	// This is a simplified version; in production, would query actual logs

	query := fmt.Sprintf(
		`count(increase(container_last_seen{tenant_id="%s"}[5m])) > 0`,
		tenantID,
	)

	result, err := m.executeQuery(query)
	if err != nil {
		return nil, err
	}

	if result > 0 {
		return []string{"pod restarts detected"}, nil
	}

	return []string{}, nil
}
