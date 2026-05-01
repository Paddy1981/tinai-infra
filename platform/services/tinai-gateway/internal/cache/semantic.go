// Package cache provides a request-level semantic cache backed by Postgres.
//
// v2 implementation: uses pgvector cosine similarity for fuzzy cache hits
// (similar but not identical prompts). Falls back to SHA-256 exact-match
// when pgvector is unavailable (db is nil or extension not installed).
//
// Embeddings are generated via EmbedFunc, which is supplied by the caller
// (typically embeddings.Client.Embed from the embeddings package). This
// allows real Sarvam AI embeddings when SARVAM_API_KEY is set, or a
// deterministic hash fallback otherwise.
package cache

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/tinai/tinai-gateway/internal/models"
)

// EmbedFunc is a function that returns a normalised float32 embedding vector
// for the given text. Implementations must be safe for concurrent use.
type EmbedFunc func(ctx context.Context, text string) ([]float32, error)

// DefaultTTL is the default cache entry lifetime.
const DefaultTTL = 24 * time.Hour

const defaultSimilarityThreshold = 0.95

// CachedResponse is a stored response retrieved from the cache.
type CachedResponse struct {
	Response *models.Response
	ModelID  string
	HitCount int
}

// SemanticCache stores AI responses keyed by message embeddings for fuzzy
// matching. Falls back to SHA-256 exact match when pgvector is unavailable.
type SemanticCache struct {
	db                  *sql.DB  // may be nil (no-op mode)
	embedder            EmbedFunc
	similarityThreshold float64
	pgvectorAvailable   bool
}

// New returns a SemanticCache. Pass nil db for no-op mode.
// embedder is called to produce a vector for each cache key; pass
// embeddings.Client.Embed (or any EmbedFunc) from the embeddings package.
func New(db *sql.DB, embedder EmbedFunc) *SemanticCache {
	sc := &SemanticCache{
		db:                  db,
		embedder:            embedder,
		similarityThreshold: defaultSimilarityThreshold,
	}
	if db != nil {
		sc.pgvectorAvailable = sc.checkPgvector()
	}
	return sc
}

// checkPgvector returns true if the pgvector extension is installed and the
// embedding column is present. It also ensures the vector column and index
// exist if the extension is available.
func (sc *SemanticCache) checkPgvector() bool {
	var exists bool
	err := sc.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector')`,
	).Scan(&exists)
	if err != nil {
		log.Printf("cache: pgvector check failed: %v — falling back to exact match", err)
		return false
	}
	if !exists {
		log.Printf("cache: pgvector not installed — using SHA-256 exact match")
		return false
	}

	log.Printf("cache: pgvector available — semantic similarity enabled (threshold=%.2f)", sc.similarityThreshold)

	// Add the embedding column if it was not added by a migration yet.
	_, _ = sc.db.Exec(
		`ALTER TABLE gateway_cache ADD COLUMN IF NOT EXISTS embedding vector(384)`,
	)

	// IVFFlat index for fast approximate cosine search.
	_, _ = sc.db.Exec(`
		CREATE INDEX IF NOT EXISTS gateway_cache_embedding_idx
		ON gateway_cache USING ivfflat (embedding vector_cosine_ops)
		WITH (lists = 100)
	`)

	return true
}

// CacheText returns the canonical plaintext representation of a message list
// used both for SHA-256 hashing (CacheKey) and for generating embeddings.
// Keeping these in sync ensures the embedder always receives the same text
// that the exact-match key was derived from.
func CacheText(msgs []models.Message) string {
	var sb strings.Builder
	for _, m := range msgs {
		sb.WriteString(m.Role)
		sb.WriteByte(':')
		sb.WriteString(m.Content)
		sb.WriteByte('\n')
	}
	return sb.String()
}

// CacheKey computes a deterministic SHA-256 hex key from a list of messages.
//
// The key captures both roles and content so that semantically identical
// conversations with different system prompts get distinct entries.
func CacheKey(msgs []models.Message) string {
	sum := sha256.Sum256([]byte(CacheText(msgs)))
	return fmt.Sprintf("%x", sum)
}

// Lookup returns a cached response for cacheKey, or (nil, nil) on a miss.
// text is the original plaintext representation of the messages (from
// CacheText); it is passed to the embedder for semantic search. cacheKey is
// the SHA-256 hex string used for the fast exact-match path.
// When pgvector is available it first tries an exact-key match, then falls
// back to a nearest-neighbour cosine search limited by similarityThreshold.
func (sc *SemanticCache) Lookup(ctx context.Context, cacheKey, text string) (*CachedResponse, error) {
	if sc.db == nil {
		return nil, nil // no-op
	}
	if sc.pgvectorAvailable {
		return sc.lookupByEmbedding(ctx, cacheKey, text)
	}
	return sc.lookupExact(ctx, cacheKey)
}

// lookupExact performs a plain SHA-256 key match (the original MVP path).
func (sc *SemanticCache) lookupExact(ctx context.Context, cacheKey string) (*CachedResponse, error) {
	var rawJSON []byte
	var modelID string
	var hitCount int

	err := sc.db.QueryRowContext(ctx, `
		SELECT response, model_id, hit_count
		FROM   gateway_cache
		WHERE  cache_key = $1
		  AND  expires_at > NOW()
	`, cacheKey).Scan(&rawJSON, &modelID, &hitCount)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cache exact lookup: %w", err)
	}

	go func() {
		_, _ = sc.db.ExecContext(context.Background(),
			`UPDATE gateway_cache SET hit_count = hit_count + 1 WHERE cache_key = $1`,
			cacheKey)
	}()

	return unmarshalResponse(rawJSON, modelID, hitCount)
}

// lookupByEmbedding tries exact match first, then cosine-similarity search.
// text is the original plaintext passed to the embedder (not the SHA-256 key).
func (sc *SemanticCache) lookupByEmbedding(ctx context.Context, cacheKey, text string) (*CachedResponse, error) {
	// Fast path: exact key match avoids the vector scan entirely.
	if entry, err := sc.lookupExact(ctx, cacheKey); entry != nil || err != nil {
		return entry, err
	}

	// Slow path: find the nearest stored embedding by cosine distance.
	// Embed the original message text, not the SHA-256 hash string.
	queryVec, err := sc.embedder(ctx, text)
	if err != nil {
		return nil, fmt.Errorf("cache vector lookup: embed: %w", err)
	}

	var rawJSON []byte
	var modelID string
	var hitCount int
	var similarity float64

	// Use a parameterized query to avoid SQL injection from the vector literal.
	// pgvector supports casting a text parameter to vector with $N::vector.
	// 1 - cosine_distance = cosine_similarity; pgvector operator <=> is cosine distance.
	err = sc.db.QueryRowContext(ctx, `
		SELECT response, model_id, hit_count,
		       1 - (embedding <=> $1::vector) AS similarity
		FROM   gateway_cache
		WHERE  expires_at > NOW()
		  AND  embedding IS NOT NULL
		  AND  1 - (embedding <=> $1::vector) >= $2
		ORDER BY embedding <=> $1::vector
		LIMIT 1
	`, float32SliceToSQL(queryVec), sc.similarityThreshold).
		Scan(&rawJSON, &modelID, &hitCount, &similarity)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cache vector lookup: %w", err)
	}

	log.Printf("cache: semantic hit (similarity=%.4f)", similarity)

	vecParam := float32SliceToSQL(queryVec)
	go func() {
		// Increment hit_count on the matched row identified by a new exact lookup
		// of the same key; we don't have its PK here, so we bump all rows that
		// would match the same vector at this similarity — in practice just one.
		_, _ = sc.db.ExecContext(context.Background(), `
			UPDATE gateway_cache
			SET    hit_count = hit_count + 1
			WHERE  expires_at > NOW()
			  AND  embedding IS NOT NULL
			  AND  1 - (embedding <=> $1::vector) >= $2
		`, vecParam, sc.similarityThreshold)
	}()

	return unmarshalResponse(rawJSON, modelID, hitCount)
}

// Store persists response in the cache with the given TTL.
// text is the original plaintext representation of the messages (from
// CacheText); it is embedded when pgvector is available. cacheKey is the
// SHA-256 hex string used as the unique key column.
func (sc *SemanticCache) Store(ctx context.Context, cacheKey, text string, response *models.Response, ttl time.Duration) error {
	if sc.db == nil || response == nil {
		return nil
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}

	rawJSON, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("cache marshal: %w", err)
	}
	expiresAt := time.Now().Add(ttl)

	if sc.pgvectorAvailable {
		// Embed the original message text, not the SHA-256 hash string.
		vec, embErr := sc.embedder(ctx, text)
		if embErr != nil {
			return fmt.Errorf("cache store: embed: %w", embErr)
		}
		// Use a parameterized query; pgvector casts the text parameter to vector.
		_, err = sc.db.ExecContext(ctx, `
			INSERT INTO gateway_cache (cache_key, embedding, response, model_id, hit_count, created_at, expires_at)
			VALUES ($1, $5::vector, $2, $3, 0, NOW(), $4)
			ON CONFLICT (cache_key) DO UPDATE
			  SET response   = EXCLUDED.response,
			      model_id   = EXCLUDED.model_id,
			      expires_at = EXCLUDED.expires_at,
			      embedding  = EXCLUDED.embedding,
			      hit_count  = 0
		`, cacheKey, rawJSON, response.Model, expiresAt, float32SliceToSQL(vec))
	} else {
		_, err = sc.db.ExecContext(ctx, `
			INSERT INTO gateway_cache (cache_key, response, model_id, hit_count, created_at, expires_at)
			VALUES ($1, $2, $3, 0, NOW(), $4)
			ON CONFLICT (cache_key) DO UPDATE
			  SET response   = EXCLUDED.response,
			      model_id   = EXCLUDED.model_id,
			      expires_at = EXCLUDED.expires_at
		`, cacheKey, rawJSON, response.Model, expiresAt)
	}
	if err != nil {
		return fmt.Errorf("cache store: %w", err)
	}
	return nil
}

// Purge removes expired entries. Intended to be called on a schedule.
func (sc *SemanticCache) Purge(ctx context.Context) (int64, error) {
	if sc.db == nil {
		return 0, nil
	}
	res, err := sc.db.ExecContext(ctx, `DELETE FROM gateway_cache WHERE expires_at <= NOW()`)
	if err != nil {
		return 0, fmt.Errorf("cache purge: %w", err)
	}
	return res.RowsAffected()
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

// float32SliceToSQL formats a float32 slice as a pgvector literal, e.g. '[0.1,0.2,0.3]'.
func float32SliceToSQL(v []float32) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = fmt.Sprintf("%g", x)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func unmarshalResponse(rawJSON []byte, modelID string, hitCount int) (*CachedResponse, error) {
	var resp models.Response
	if err := json.Unmarshal(rawJSON, &resp); err != nil {
		return nil, fmt.Errorf("cache unmarshal: %w", err)
	}
	return &CachedResponse{
		Response: &resp,
		ModelID:  modelID,
		HitCount: hitCount,
	}, nil
}
