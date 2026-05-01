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

// SarvamProvider calls the Sarvam AI chat completions API (OpenAI-compatible).
type SarvamProvider struct {
	apiKey     string
	httpClient *http.Client
}

// NewSarvamProvider returns a ready-to-use SarvamProvider.
// If apiKey is empty it reads SARVAM_API_KEY from the environment.
func NewSarvamProvider(apiKey string) *SarvamProvider {
	if apiKey == "" {
		apiKey = os.Getenv("SARVAM_API_KEY")
	}
	return &SarvamProvider{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// ---- OpenAI-compatible wire types (reused for Sarvam and Krutrim) ----

type openAIChatRequest struct {
	Model     string          `json:"model"`
	Messages  []openAIMessage `json:"messages"`
	MaxTokens int             `json:"max_tokens,omitempty"`
	Stream    bool            `json:"stream,omitempty"`
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIChatResponse struct {
	ID      string          `json:"id"`
	Object  string          `json:"object"`
	Model   string          `json:"model"`
	Choices []openAIChoice  `json:"choices"`
	Usage   openAIUsage     `json:"usage"`
}

type openAIChoice struct {
	Index        int           `json:"index"`
	Message      openAIMessage `json:"message"`
	FinishReason string        `json:"finish_reason"`
}

type openAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Chat sends a chat completion request to Sarvam AI and returns an OpenAI-compatible Response.
// If stream is true the raw SSE body is proxied directly to w; pass nil for w when stream is false.
func (p *SarvamProvider) Chat(ctx context.Context, model string, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	if p.apiKey == "" {
		return nil, fmt.Errorf("sarvam: SARVAM_API_KEY not configured")
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
		return nil, fmt.Errorf("sarvam: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.sarvam.ai/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("sarvam: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sarvam: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sarvam: status %d: %s", resp.StatusCode, string(body))
	}

	// Streaming: proxy SSE lines to w and return nil response.
	if stream && w != nil {
		return nil, proxySSE(resp.Body, w)
	}

	// Non-streaming: parse and normalise.
	var or openAIChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&or); err != nil {
		return nil, fmt.Errorf("sarvam: decode response: %w", err)
	}

	text := ""
	finishReason := "stop"
	if len(or.Choices) > 0 {
		text = or.Choices[0].Message.Content
		finishReason = or.Choices[0].FinishReason
	}

	id := or.ID
	if id == "" {
		id = fmt.Sprintf("sarvam-%d", time.Now().UnixNano())
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
