// Package providers contains per-provider chat completion implementations.
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/tinai/tinai-gateway/internal/models"
)

// KrutrimProvider calls the Krutrim Cloud chat completions API (OpenAI-compatible).
type KrutrimProvider struct {
	apiKey     string
	httpClient *http.Client
}

// NewKrutrimProvider returns a ready-to-use KrutrimProvider.
// If apiKey is empty it reads KRUTRIM_API_KEY from the environment.
func NewKrutrimProvider(apiKey string) *KrutrimProvider {
	if apiKey == "" {
		apiKey = os.Getenv("KRUTRIM_API_KEY")
	}
	return &KrutrimProvider{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// Chat sends a chat completion request to Krutrim Cloud and returns an OpenAI-compatible Response.
// If stream is true the raw SSE body is proxied directly to w; pass nil for w when stream is false.
func (p *KrutrimProvider) Chat(ctx context.Context, model string, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	if p.apiKey == "" {
		return nil, fmt.Errorf("krutrim: KRUTRIM_API_KEY not configured")
	}
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	oaiMsgs := make([]openAIMessage, 0, len(msgs))
	for _, m := range msgs {
		oaiMsgs = append(oaiMsgs, openAIMessage{Role: m.Role, Content: m.Content})
	}

	reqBody := openAIChatRequest{
		Model:     model,
		Messages:  oaiMsgs,
		MaxTokens: maxTokens,
		Stream:    stream,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("krutrim: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://cloud.olakrutrim.com/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("krutrim: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("krutrim: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("krutrim: status %d: %s", resp.StatusCode, string(body))
	}

	// Streaming: proxy SSE lines to w and return nil response.
	if stream && w != nil {
		return nil, proxySSE(resp.Body, w)
	}

	// Non-streaming: parse and normalise.
	var or openAIChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&or); err != nil {
		return nil, fmt.Errorf("krutrim: decode response: %w", err)
	}

	text := ""
	finishReason := "stop"
	if len(or.Choices) > 0 {
		text = or.Choices[0].Message.Content
		finishReason = or.Choices[0].FinishReason
	}

	id := or.ID
	if id == "" {
		id = fmt.Sprintf("krutrim-%d", time.Now().UnixNano())
	}

	return &models.Response{
		ID:     id,
		Object: "chat.completion",
		Model:  or.Model,
		Choices: []models.Choice{
			{
				Index: 0,
				Message: models.Message{
					Role:    "assistant",
					Content: text,
				},
				FinishReason: finishReason,
			},
		},
		Usage: models.Usage{
			PromptTokens:     or.Usage.PromptTokens,
			CompletionTokens: or.Usage.CompletionTokens,
			TotalTokens:      or.Usage.TotalTokens,
		},
	}, nil
}
