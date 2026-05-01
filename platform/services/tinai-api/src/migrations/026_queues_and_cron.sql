-- Migration 026: Job Queues + Cron Jobs
-- Vercel Queues (Beta) + Cron Jobs equivalent.
-- Persistent job queue with retry, dead-letter, and scheduled execution.

CREATE TABLE IF NOT EXISTS job_queues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  max_retries integer DEFAULT 3,
  retry_delay_seconds integer DEFAULT 60,
  timeout_seconds integer DEFAULT 300,
  concurrency integer DEFAULT 5,
  endpoint_url text NOT NULL,  -- HTTP endpoint to call when job is dequeued
  created_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_job_queues_tenant ON job_queues(tenant_id);

-- Individual jobs in the queue
CREATE TABLE IF NOT EXISTS jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id    uuid NOT NULL REFERENCES job_queues(id) ON DELETE CASCADE,
  tenant_id   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  priority    integer DEFAULT 0,  -- higher = more urgent
  attempts    integer DEFAULT 0,
  max_retries integer DEFAULT 3,
  scheduled_for timestamptz DEFAULT now(),  -- delayed jobs
  started_at  timestamptz,
  completed_at timestamptz,
  error       text,
  result      jsonb,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs(queue_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant       ON jobs(tenant_id, created_at DESC);

-- Cron Jobs (scheduled recurring tasks)
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  schedule    text NOT NULL,  -- cron expression: '0 */6 * * *'
  timezone    text DEFAULT 'UTC',
  endpoint_url text NOT NULL, -- URL to call on each trigger
  http_method text DEFAULT 'POST' CHECK (http_method IN ('GET', 'POST', 'PUT')),
  headers     jsonb DEFAULT '{}',
  body        jsonb,
  enabled     boolean DEFAULT true,
  last_run    timestamptz,
  next_run    timestamptz,
  last_status integer,  -- HTTP status of last execution
  created_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_tenant ON cron_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next   ON cron_jobs(next_run) WHERE enabled = true;

-- Cron execution log
CREATE TABLE IF NOT EXISTS cron_executions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cron_id     uuid NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status_code integer,
  duration_ms integer,
  response    text,
  error       text,
  triggered_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cron_executions ON cron_executions(cron_id, triggered_at DESC);
