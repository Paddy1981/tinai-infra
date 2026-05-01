package embeddings

import (
	"context"
	"math"
	"os"
	"testing"
)

func TestFallbackEmbed(t *testing.T) {
	// Ensure no API key so New() returns a fallback client.
	os.Unsetenv("SARVAM_API_KEY")

	c := New()
	if !c.IsFallback() {
		t.Skip("SARVAM_API_KEY is set in environment; skipping fallback test")
	}

	vec, err := c.Embed(context.Background(), "test embedding input")
	if err != nil {
		t.Fatalf("Embed returned unexpected error: %v", err)
	}
	if len(vec) != 384 {
		t.Errorf("expected vector length 384, got %d", len(vec))
	}

	// Verify the returned vector is unit-length.
	var sumSq float64
	for _, v := range vec {
		sumSq += float64(v) * float64(v)
	}
	norm := math.Sqrt(sumSq)
	if math.Abs(norm-1.0) > 1e-5 {
		t.Errorf("expected unit-length vector, got norm=%f", norm)
	}
}

func TestEmbedMessages(t *testing.T) {
	os.Unsetenv("SARVAM_API_KEY")

	c := New()
	if !c.IsFallback() {
		t.Skip("SARVAM_API_KEY is set in environment; skipping fallback test")
	}

	msgs := []string{
		"user: hello",
		"assistant: hi there",
		"user: how are you",
	}
	vec, err := c.EmbedMessages(context.Background(), msgs)
	if err != nil {
		t.Fatalf("EmbedMessages returned unexpected error: %v", err)
	}
	if len(vec) != 384 {
		t.Errorf("expected vector length 384, got %d", len(vec))
	}
}
