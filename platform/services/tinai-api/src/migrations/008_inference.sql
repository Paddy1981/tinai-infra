-- Inference endpoints — per-tenant AI proxy configurations
CREATE TABLE inference_endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('anthropic','sarvam','krutrim','gemini','openai')),
  model           TEXT NOT NULL,   -- e.g. "claude-sonnet-4-6", "sarvam-2b", "gemini-2.0-flash"
  -- Rate limiting
  rpm_limit       INT  NOT NULL DEFAULT 60,   -- requests per minute
  tpm_limit       INT  NOT NULL DEFAULT 100000, -- tokens per minute
  -- Budget
  monthly_budget_paise BIGINT NOT NULL DEFAULT 0,  -- 0 = unlimited; INR paise
  -- Status
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

-- Usage per endpoint per day (written by tinai-gateway billing writer)
CREATE TABLE inference_usage (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  endpoint_id     UUID NOT NULL REFERENCES inference_endpoints(id) ON DELETE CASCADE,
  day             DATE NOT NULL DEFAULT CURRENT_DATE,
  request_count   BIGINT NOT NULL DEFAULT 0,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  cost_paise      BIGINT NOT NULL DEFAULT 0,
  UNIQUE(endpoint_id, day)
);

-- Model catalog (seed data)
CREATE TABLE inference_models (
  id        SERIAL PRIMARY KEY,
  provider  TEXT NOT NULL,
  model_id  TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  context_window INT NOT NULL DEFAULT 8192,
  input_price_per_1m_paise  INT NOT NULL DEFAULT 0,  -- INR paise per 1M tokens
  output_price_per_1m_paise INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO inference_models (provider, model_id, name, context_window, input_price_per_1m_paise, output_price_per_1m_paise) VALUES
  ('anthropic', 'claude-opus-4-6',    'Claude Opus 4.6',     200000, 1250, 6250),
  ('anthropic', 'claude-sonnet-4-6',  'Claude Sonnet 4.6',   200000,  250, 1250),
  ('anthropic', 'claude-haiku-4-5',   'Claude Haiku 4.5',    200000,   63,  313),
  ('sarvam',    'sarvam-2b',          'Sarvam 2B',             4096,   10,   10),
  ('sarvam',    'sarvam-m',           'Sarvam M',              8192,   25,   25),
  ('krutrim',   'krutrim-pro',        'Krutrim Pro',           8192,   50,  100),
  ('gemini',    'gemini-2.0-flash',   'Gemini 2.0 Flash',   1000000,   10,   40),
  ('gemini',    'gemini-2.5-pro',     'Gemini 2.5 Pro',      200000,  156,  625),
  ('openai',    'gpt-4o',            'GPT-4o',               128000,  417, 1250),
  ('openai',    'gpt-4o-mini',       'GPT-4o mini',          128000,   10,   40);

CREATE INDEX ON inference_endpoints(tenant_id);
CREATE INDEX ON inference_usage(tenant_id, day);
CREATE INDEX ON inference_usage(endpoint_id, day);
