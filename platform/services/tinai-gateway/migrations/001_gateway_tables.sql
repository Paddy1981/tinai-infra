-- Tinai AI Gateway — initial schema
-- Run once against your Postgres database before starting the gateway.

-- -----------------------------------------------------------------------
-- Usage log: one row per request (cache hits included with 0 tokens)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_usage (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     VARCHAR(63) NOT NULL,
    model_id      VARCHAR(63) NOT NULL,
    input_tokens  INT         NOT NULL DEFAULT 0,
    output_tokens INT         NOT NULL DEFAULT 0,
    cost_paise    BIGINT      NOT NULL DEFAULT 0,
    cache_hit     BOOLEAN     NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Efficient monthly spend roll-up per tenant.
CREATE INDEX IF NOT EXISTS idx_gateway_usage_tenant_month
    ON gateway_usage (tenant_id, date_trunc('month', created_at));

-- -----------------------------------------------------------------------
-- Response cache: exact-match on SHA-256 of request messages
-- TODO: add a vector(1536) column "embedding" + pgvector index for
--       semantic similarity lookups once an embedding model is available.
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_cache (
    cache_key   VARCHAR(64) PRIMARY KEY,  -- SHA-256 hex (64 chars)
    response    JSONB       NOT NULL,
    model_id    VARCHAR(63) NOT NULL,
    hit_count   INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_cache_expires
    ON gateway_cache (expires_at);

-- -----------------------------------------------------------------------
-- Per-tenant configuration: spend limits and model preferences
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_quotas (
    tenant_id           VARCHAR(63) PRIMARY KEY,
    monthly_limit_paise BIGINT      NOT NULL DEFAULT 100000,  -- ₹1,000
    preferred_model     VARCHAR(63),
    fallback_model      VARCHAR(63) NOT NULL DEFAULT 'llama3:8b',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------
-- Seed: example tenant for local development
-- -----------------------------------------------------------------------
INSERT INTO gateway_quotas (tenant_id, monthly_limit_paise, preferred_model, fallback_model)
VALUES ('dev-tenant', 100000, 'claude-haiku-4-5', 'llama3:8b')
ON CONFLICT (tenant_id) DO NOTHING;
