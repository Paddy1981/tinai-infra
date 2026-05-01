-- Tinai AI Gateway — migration 002: pgvector semantic cache
-- Run after 001_gateway_tables.sql.
-- Requires Postgres 15+ with the pgvector extension available on the server.

-- -----------------------------------------------------------------------
-- 1. Enable the pgvector extension (requires superuser the first time).
--    Safe to run repeatedly — IF NOT EXISTS is idempotent.
-- -----------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------
-- 2. Add the embedding column to the existing cache table.
--    vector(384) matches embeddingDim in cache/semantic.go.
--    IF NOT EXISTS means the migration is re-runnable without errors.
-- -----------------------------------------------------------------------
ALTER TABLE gateway_cache ADD COLUMN IF NOT EXISTS embedding vector(384);

-- -----------------------------------------------------------------------
-- 3. Create an IVFFlat index for fast approximate cosine-similarity search.
--
--    lists = 100 is a good starting point for tables up to ~1 M rows.
--    Increase lists (e.g. 200–500) if the table grows significantly.
--
--    NOTE: IVFFlat requires the table to have some rows before the index
--    can be built meaningfully. If the table is empty, the index still
--    creates successfully and will be rebuilt automatically over time.
-- -----------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS gateway_cache_embedding_idx
  ON gateway_cache USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
