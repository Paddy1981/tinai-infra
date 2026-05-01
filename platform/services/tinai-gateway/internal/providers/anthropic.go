// Package providers contains per-provider chat completion implementations.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/tinai/tinai-gateway/internal/models"
)

// AnthropicProvider calls the Anthropic Messages API.
type AnthropicProvider struct {
	apiKey     string
	httpClient *http.Client
}

// NewAnthropicProvider returns a ready-to-use AnthropicProvider.
func NewAnthropicProvider(apiKey string) *AnthropicProvider {
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	return &AnthropicProvider{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// ---- Anthropic wire types ----

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Stream    bool               `json:"stream,omitempty"`
}

type anthropicMessage struct {
	Role    string `json:"role"` // "user" | "assistant"
	Content string `json:"content"`
}

type anthropicResponse struct {
	ID           string             `json:"id"`
	Type         string             `json:"type"`
	Role         string             `json:"role"`
	Content      []anthropicContent `json:"content"`
	Model        string             `json:"model"`
	StopReason   string             `json:"stop_reason"`
	Usage        anthropicUsage     `json:"usage"`
}

type anthropicContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type anthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Chat sends a chat completion request to Anthropic and returns an OpenAI-compatible Response.
// If stream is true the raw SSE body is proxied directly to w; pass nil for w when stream is false.
func (p *AnthropicProvider) Chat(ctx context.Context, model string, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	// Separate system message from conversation turns.
	var systemPrompt string
	var anthropicMsgs []anthropicMessage
	for _, m := range msgs {
		if m.Role == "system" {
			systemPrompt = m.Content
			continue
		}
		anthropicMsgs = append(anthropicMsgs, anthropicMessage{
			Role:    m.Role,
			Content: m.Content,
		})
	}

	reqBody := anthropicRequest{
		Model:     model,
		MaxTokens: maxTokens,
		System:    systemPrompt,
		Messages:  anthropicMsgs,
		Stream:    stream,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("anthropic: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("anthropic: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("anthropic: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("anthropic: status %d: %s", resp.StatusCode, string(body))
	}

	// Streaming: proxy SSE lines to w and return nil response.
	if stream && w != nil {
		return nil, proxySSE(resp.Body, w)
	}

	// Non-streaming: parse and normalise.
	var ar anthropicResponse
	if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
		return nil, fmt.Errorf("anthropic: decode response: %w", err)
	}

	text := ""
	for _, c := range ar.Content {
		if c.Type == "text" {
			text += c.Text
		}
	}

	return &models.Response{
		ID:     ar.ID,
		Object: "chat.completion",
		Model:  ar.Model,
		Choices: []models.Choice{
			{
				Index: 0,
				Message: models.Message{
					Role:    "assistant",
					Content: text,
				},
				FinishReason: mapAnthropicStopReason(ar.StopReason),
			},
		},
		Usage: models.Usage{
			PromptTokens:     ar.Usage.InputTokens,
			CompletionTokens: ar.Usage.OutputTokens,
			TotalTokens:      ar.Usage.InputTokens + ar.Usage.OutputTokens,
		},
	}, nil
}

func mapAnthropicStopReason(r string) string {
	switch r {
	case "end_turn":
		return "stop"
	case "max_tokens":
		return "length"
	default:
		return r
	}
}

// proxySSE copies server-sent events from src to dst until EOF.
func proxySSE(src io.Reader, dst io.Writer) error {
	scanner := bufio.NewScanner(src)
	for scanner.Scan() {
		line := scanner.Text()
		if _, err := fmt.Fprintln(dst, line); err != nil {
			return err
		}
		// Flush if dst supports it.
		if f, ok := dst.(http.Flusher); ok {
			f.Flush()
		}
		// Anthropic sends "data: [DONE]" to end the stream.
		if strings.Contains(line, "[DONE]") {
			break
		}
	}
	return scanner.Err()
}
