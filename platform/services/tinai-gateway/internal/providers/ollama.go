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

// OllamaProvider calls a local Ollama instance.
// Ollama's /api/chat endpoint already accepts OpenAI-compatible messages format.
type OllamaProvider struct {
	baseURL    string
	httpClient *http.Client
}

// NewOllamaProvider returns a ready-to-use OllamaProvider.
func NewOllamaProvider(baseURL string) *OllamaProvider {
	if baseURL == "" {
		baseURL = os.Getenv("OLLAMA_BASE_URL")
	}
	if baseURL == "" {
		baseURL = "http://ollama.tinai-system.svc.cluster.local:11434"
	}
	return &OllamaProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 300 * time.Second, // local inference can be slow
		},
	}
}

// ---- Ollama wire types (/api/chat) ----

type ollamaRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Stream   bool            `json:"stream"`
	Options  *ollamaOptions  `json:"options,omitempty"`
}

type ollamaMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ollamaOptions struct {
	NumPredict int `json:"num_predict,omitempty"`
}

// Non-streaming response from Ollama.
type ollamaResponse struct {
	Model              string        `json:"model"`
	CreatedAt          time.Time     `json:"created_at"`
	Message            ollamaMessage `json:"message"`
	DoneReason         string        `json:"done_reason"`
	Done               bool          `json:"done"`
	PromptEvalCount    int           `json:"prompt_eval_count"`
	EvalCount          int           `json:"eval_count"`
}

// Streaming chunk from Ollama.
type ollamaStreamChunk struct {
	Model     string        `json:"model"`
	Message   ollamaMessage `json:"message"`
	Done      bool          `json:"done"`
	DoneReason string       `json:"done_reason"`
	PromptEvalCount int     `json:"prompt_eval_count"`
	EvalCount       int     `json:"eval_count"`
}

// Chat sends messages to the local Ollama instance.
func (p *OllamaProvider) Chat(ctx context.Context, model string, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	var ollamaMsgs []ollamaMessage
	for _, m := range msgs {
		ollamaMsgs = append(ollamaMsgs, ollamaMessage{
			Role:    m.Role,
			Content: m.Content,
		})
	}

	reqBody := ollamaRequest{
		Model:    model,
		Messages: ollamaMsgs,
		Stream:   stream,
		Options:  &ollamaOptions{NumPredict: maxTokens},
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("ollama: marshal request: %w", err)
	}

	endpoint := p.baseURL + "/api/chat"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("ollama: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama: status %d: %s", resp.StatusCode, string(body))
	}

	// Streaming: proxy NDJSON chunks to w converted to SSE format.
	if stream && w != nil {
		return nil, ollamaStreamProxy(resp.Body, w, model)
	}

	// Non-streaming: Ollama returns a single JSON object when stream=false.
	var or_ ollamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&or_); err != nil {
		return nil, fmt.Errorf("ollama: decode response: %w", err)
	}

	finishReason := "stop"
	if or_.DoneReason == "length" {
		finishReason = "length"
	}

	return &models.Response{
		ID:     fmt.Sprintf("ollama-%d", time.Now().UnixNano()),
		Object: "chat.completion",
		Model:  or_.Model,
		Choices: []models.Choice{
			{
				Index: 0,
				Message: models.Message{
					Role:    or_.Message.Role,
					Content: or_.Message.Content,
				},
				FinishReason: finishReason,
			},
		},
		Usage: models.Usage{
			PromptTokens:     or_.PromptEvalCount,
			CompletionTokens: or_.EvalCount,
			TotalTokens:      or_.PromptEvalCount + or_.EvalCount,
		},
	}, nil
}

// ollamaStreamProxy reads Ollama NDJSON and forwards it as SSE lines to dst.
func ollamaStreamProxy(src io.Reader, dst io.Writer, model string) error {
	scanner := bufio.NewScanner(src)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var chunk ollamaStreamChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			continue
		}

		// Emit OpenAI-style SSE delta.
		delta := map[string]any{
			"id":     fmt.Sprintf("ollama-%d", time.Now().UnixNano()),
			"object": "chat.completion.chunk",
			"model":  model,
			"choices": []map[string]any{
				{
					"index": 0,
					"delta": map[string]string{"content": chunk.Message.Content},
					"finish_reason": func() any {
						if chunk.Done {
							return "stop"
						}
						return nil
					}(),
				},
			},
		}
		encoded, _ := json.Marshal(delta)
		fmt.Fprintf(dst, "data: %s\n\n", encoded)
		if f, ok := dst.(http.Flusher); ok {
			f.Flush()
		}
		if chunk.Done {
			fmt.Fprintln(dst, "data: [DONE]")
			break
		}
	}
	return scanner.Err()
}
