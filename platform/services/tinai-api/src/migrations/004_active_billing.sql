-- 004_active_billing.sql
-- Sub-minute CPU/memory billing log and summary view.
-- Apply with: psql $DATABASE_URL -f src/migrations/004_active_billing.sql

CREATE TABLE IF NOT EXISTS cpu_seconds_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_name         VARCHAR(63) NOT NULL,
    namespace        VARCHAR(63) NOT NULL,
    cpu_seconds      NUMERIC(12,6) NOT NULL DEFAULT 0,
    memory_byte_secs BIGINT NOT NULL DEFAULT 0,
    window_start     TIMESTAMPTZ NOT NULL,
    window_end       TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cpu_seconds_app_time
    ON cpu_seconds_log (app_name, window_start);

-- Pricing
-- CPU:    ₹0.0014 per CPU-second  = ₹5.04/CPU-hour  (stored as 0.14 paise/CPU-second)
-- Memory: ₹0.000007 per GB-second = ₹0.025/GB-hour  (stored as 0.007 paise/GB-second)
CREATE OR REPLACE VIEW active_billing_summary AS
SELECT
    app_name,
    date_trunc('hour', window_start)                               AS hour,
    SUM(cpu_seconds)                                               AS total_cpu_seconds,
    ROUND(SUM(cpu_seconds) * 0.14)::BIGINT                        AS cpu_cost_paise,
    SUM(memory_byte_secs) / (1024 * 1024 * 1024)                  AS total_gb_seconds,
    ROUND(SUM(memory_byte_secs) / (1024 * 1024 * 1024) * 0.007)::BIGINT AS memory_cost_paise
FROM cpu_seconds_log
GROUP BY app_name, date_trunc('hour', window_start);
