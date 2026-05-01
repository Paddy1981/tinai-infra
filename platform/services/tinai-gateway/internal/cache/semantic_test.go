package cache

import (
	"context"
	"math"
	"testing"
	"time"
)

// hashEmbedWrapper calls hashEmbed (unexported) via the package-internal
// EmbedFunc signature so we can test it directly.
func hashEmbedWrapper(ctx context.Context, text string) ([]float32, error) {
	return hashEmbed(text), nil
}

func TestHashEmbedDimension(t *testing.T) {
	vec, err := hashEmbedWrapper(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(vec) != 384 {
		t.Errorf("expected dimension 384, got %d", len(vec))
	}
}

func TestHashEmbedNormalized(t *testing.T) {
	vec, err := hashEmbedWrapper(context.Background(), "normalize me please")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var sumSq float64
	for _, v := range vec {
		sumSq += float64(v) * float64(v)
	}
	norm := math.Sqrt(sumSq)
	if math.Abs(norm-1.0) > 1e-5 {
		t.Errorf("expected unit-length vector (L2 norm ≈ 1.0), got %f", norm)
	}
}

func TestSemanticCache_NilDB_NoOp(t *testing.T) {
	sc := New(nil, hashEmbedWrapper)

	// Get (Lookup) should return nil, nil — no panic
	result, err := sc.Lookup(context.Background(), "some-cache-key")
	if err != nil {
		t.Errorf("Lookup with nil db: unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("Lookup with nil db: expected nil result, got %+v", result)
	}

	// Store should return nil — no panic
	err = sc.Store(context.Background(), "some-cache-key", nil, DefaultTTL)
	if err != nil {
		t.Errorf("Store with nil db: unexpected error: %v", err)
	}
}

func TestSemanticCache_TTL(t *testing.T) {
	if DefaultTTL != 24*time.Hour {
		t.Errorf("DefaultTTL = %v, want %v", DefaultTTL, 24*time.Hour)
	}
}
