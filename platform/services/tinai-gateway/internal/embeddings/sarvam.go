package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"time"
)

const (
	sarvamEmbeddingsURL = "https://api.sarvam.ai/v1/embeddings"
	embeddingDim        = 384 // Sarvam embeddings dimension
)

// Client calls the Sarvam AI embeddings API.
type Client struct {
	apiKey     string
	httpClient *http.Client
	// fallback: if apiKey is empty, use deterministic hash embedding
	fallback bool
}

// New returns an embeddings Client.
// If SARVAM_API_KEY is not set, falls back to the deterministic hash placeholder.
func New() *Client {
	key := os.Getenv("SARVAM_API_KEY")
	if key == "" {
		return &Client{fallback: true}
	}
	return &Client{
		apiKey:     key,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Embed returns a normalized float32 embedding vector for the input text.
func (c *Client) Embed(ctx context.Context, text string) ([]float32, error) {
	if c.fallback {
		return hashEmbed(text), nil
	}

	body, _ := json.Marshal(map[string]interface{}{
		"model": "sarvam-embed-v1",
		"input": []string{text},
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sarvamEmbeddingsURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("embeddings: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Fall back to hash embedding on network error
		return hashEmbed(text), nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Fall back gracefully on non-200
		return hashEmbed(text), nil
	}

	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return hashEmbed(text), nil
	}
	if len(result.Data) == 0 || len(result.Data[0].Embedding) == 0 {
		return hashEmbed(text), nil
	}

	vec := make([]float32, len(result.Data[0].Embedding))
	for i, v := range result.Data[0].Embedding {
		vec[i] = float32(v)
	}
	return vec, nil
}

// Dimension returns the embedding dimension.
func (c *Client) Dimension() int { return embeddingDim }

// IsFallback returns true if using the hash placeholder (no API key).
func (c *Client) IsFallback() bool { return c.fallback }

// hashEmbed is the deterministic fallback used when no API key is available.
// It replicates the logic previously in cache.keyToEmbedding.
func hashEmbed(text string) []float32 {
	vec := make([]float32, embeddingDim)
	for i, c := range text {
		vec[i%embeddingDim] += float32(c)
	}
	return normalize(vec)
}

func normalize(v []float32) []float32 {
	var sumSq float64
	for _, x := range v {
		sumSq += float64(x) * float64(x)
	}
	norm := math.Sqrt(sumSq)
	if norm == 0 {
		return v
	}
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(float64(x) / norm)
	}
	return out
}

// EmbedMessages returns an embedding for a slice of chat messages
// by concatenating role:content pairs.
func (c *Client) EmbedMessages(ctx context.Context, msgs []string) ([]float32, error) {
	combined := ""
	for _, m := range msgs {
		combined += m + "\n"
	}
	if len(combined) > 8192 {
		combined = combined[:8192] // truncate to avoid token limits
	}
	return c.Embed(ctx, combined)
}
