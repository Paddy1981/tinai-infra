-- 028_seed_billing_data.sql
-- Seeds billing data so the dashboard has something to display.
-- Safe to re-run: uses ON CONFLICT DO NOTHING where possible.
-- Apply with: psql $DATABASE_URL -f src/migrations/028_seed_billing_data.sql

-- Ensure the 'laruneng' tenant has at least one app (needed for JOINs in billing routes)
INSERT INTO apps (name, owner, repo_full_name)
VALUES ('laruneng-web', 'laruneng', 'laruneng/web')
ON CONFLICT (name) DO NOTHING;

INSERT INTO apps (name, owner, repo_full_name)
VALUES ('laruneng-api', 'laruneng', 'laruneng/api')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed cpu_seconds_log — the active billing routes read from this table.
-- Insert hourly windows for the past 7 days to populate graphs.
-- ---------------------------------------------------------------------------
INSERT INTO cpu_seconds_log (app_name, namespace, cpu_seconds, memory_byte_secs, window_start, window_end)
SELECT
  app_name,
  'tinai-apps',
  -- ~0.25 CPU cores sustained = 900 cpu-seconds per hour
  (random() * 600 + 600)::NUMERIC(12,6),
  -- ~256 MB average = 256*1024*1024*3600 byte-seconds per hour
  (256 * 1024 * 1024 * 3600 * (0.5 + random()))::BIGINT,
  hour_start,
  hour_start + INTERVAL '1 hour'
FROM (
  SELECT
    generate_series(
      date_trunc('month', CURRENT_DATE),
      NOW() - INTERVAL '1 hour',
      INTERVAL '1 hour'
    ) AS hour_start
) hours
CROSS JOIN (
  VALUES ('laruneng-web'), ('laruneng-api')
) AS apps(app_name);

-- ---------------------------------------------------------------------------
-- Seed usage_snapshots — the /billing/usage/current route reads from this.
-- Insert a snapshot every 5 minutes for the last 24 hours.
-- ---------------------------------------------------------------------------
INSERT INTO usage_snapshots (app_name, namespace, cpu_cores, memory_bytes, snapshot_at)
SELECT
  app_name,
  'tinai-apps',
  -- 0.1 to 0.5 CPU cores
  (random() * 0.4 + 0.1)::NUMERIC(10,6),
  -- 128 MB to 512 MB
  (128 * 1024 * 1024 + random() * 384 * 1024 * 1024)::BIGINT,
  snap_time
FROM (
  SELECT
    generate_series(
      NOW() - INTERVAL '24 hours',
      NOW() - INTERVAL '5 minutes',
      INTERVAL '5 minutes'
    ) AS snap_time
) snaps
CROSS JOIN (
  VALUES ('laruneng-web'), ('laruneng-api')
) AS apps(app_name);

-- ---------------------------------------------------------------------------
-- Seed cost_daily — for the 020_usage_analytics cost_daily table.
-- ---------------------------------------------------------------------------
INSERT INTO cost_daily (tenant_id, day, compute_inr, storage_inr, bandwidth_inr, ai_inr)
SELECT
  'laruneng',
  d::date,
  -- compute: ~50-120 INR/day
  (50 + random() * 70)::NUMERIC(12,2),
  -- storage: ~5-15 INR/day
  (5 + random() * 10)::NUMERIC(12,2),
  -- bandwidth: ~2-8 INR/day
  (2 + random() * 6)::NUMERIC(12,2),
  -- AI: ~0-20 INR/day
  (random() * 20)::NUMERIC(12,2)
FROM generate_series(
  date_trunc('month', CURRENT_DATE),
  CURRENT_DATE,
  INTERVAL '1 day'
) AS d
ON CONFLICT (tenant_id, day) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed an invoice for the current month.
-- The billing API's POST /billing/invoices/generate can regenerate this from
-- live usage_snapshots data, but we seed a draft so the dashboard shows it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_month DATE := date_trunc('month', CURRENT_DATE)::DATE;
  v_subtotal BIGINT;
  v_gst BIGINT;
  v_total BIGINT;
  v_invoice_id UUID;
BEGIN
  -- Calculate totals from seeded cpu_seconds_log data
  SELECT
    COALESCE(
      ROUND(SUM(cpu_seconds) * 0.14)::BIGINT
        + ROUND(SUM(memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT,
      0
    )
  INTO v_subtotal
  FROM cpu_seconds_log c
  JOIN apps a ON a.name = c.app_name
  WHERE c.window_start >= v_month
    AND a.owner = 'laruneng';

  v_gst   := ROUND(v_subtotal * 0.18);
  v_total := v_subtotal + v_gst;

  -- Upsert the invoice
  INSERT INTO invoices (tenant, month, subtotal_paise, gst_paise, total_paise, status)
  VALUES ('laruneng', v_month, v_subtotal, v_gst, v_total, 'draft')
  ON CONFLICT (tenant, month) DO UPDATE
    SET subtotal_paise = EXCLUDED.subtotal_paise,
        gst_paise      = EXCLUDED.gst_paise,
        total_paise    = EXCLUDED.total_paise
  RETURNING id INTO v_invoice_id;

  -- Clear previous line items (if re-running)
  DELETE FROM invoice_line_items WHERE invoice_id = v_invoice_id;

  -- Insert line items per app
  INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_paise, amount_paise)
  SELECT
    v_invoice_id,
    app_name || ' — CPU (' || ROUND(SUM(cpu_seconds) / 3600.0, 4) || ' core-hrs)',
    ROUND(SUM(cpu_seconds) / 3600.0, 4),
    504,  -- ₹5.04/core-hour = 504 paise
    ROUND(SUM(cpu_seconds) * 0.14)::BIGINT
  FROM cpu_seconds_log c
  JOIN apps a ON a.name = c.app_name
  WHERE c.window_start >= v_month
    AND a.owner = 'laruneng'
  GROUP BY c.app_name;

  INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_paise, amount_paise)
  SELECT
    v_invoice_id,
    app_name || ' — Memory (' || ROUND(SUM(memory_byte_secs) / (1024.0 * 1024 * 1024 * 3600), 4) || ' GB-hrs)',
    ROUND(SUM(memory_byte_secs) / (1024.0 * 1024 * 1024 * 3600), 4),
    25,   -- ₹0.25/GB-hour = 25 paise
    ROUND(SUM(memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT
  FROM cpu_seconds_log c
  JOIN apps a ON a.name = c.app_name
  WHERE c.window_start >= v_month
    AND a.owner = 'laruneng'
  GROUP BY c.app_name;

  RAISE NOTICE 'Invoice % created: subtotal=% paise, gst=% paise, total=% paise',
    v_invoice_id, v_subtotal, v_gst, v_total;
END $$;

-- ---------------------------------------------------------------------------
-- Verify: quick counts
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cpu_count BIGINT;
  v_snap_count BIGINT;
  v_cost_count BIGINT;
  v_inv_count BIGINT;
  v_li_count BIGINT;
BEGIN
  SELECT count(*) INTO v_cpu_count FROM cpu_seconds_log WHERE app_name LIKE 'laruneng-%';
  SELECT count(*) INTO v_snap_count FROM usage_snapshots WHERE app_name LIKE 'laruneng-%';
  SELECT count(*) INTO v_cost_count FROM cost_daily WHERE tenant_id = 'laruneng';
  SELECT count(*) INTO v_inv_count FROM invoices WHERE tenant = 'laruneng';
  SELECT count(*) INTO v_li_count FROM invoice_line_items li JOIN invoices i ON li.invoice_id = i.id WHERE i.tenant = 'laruneng';

  RAISE NOTICE 'Seed verification:';
  RAISE NOTICE '  cpu_seconds_log rows:  %', v_cpu_count;
  RAISE NOTICE '  usage_snapshots rows:  %', v_snap_count;
  RAISE NOTICE '  cost_daily rows:       %', v_cost_count;
  RAISE NOTICE '  invoices:              %', v_inv_count;
  RAISE NOTICE '  invoice_line_items:    %', v_li_count;
END $$;
