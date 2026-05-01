package providers

import (
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

// GoogleProvider calls the Google Gemini generateContent API.
type GoogleProvider struct {
	apiKey     string
	httpClient *http.Client
}

// NewGoogleProvider returns a ready-to-use GoogleProvider.
func NewGoogleProvider(apiKey string) *GoogleProvider {
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}
	return &GoogleProvider{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// ---- Gemini wire types ----

type geminiRequest struct {
	Contents         []geminiContent         `json:"contents"`
	GenerationConfig *geminiGenerationConfig  `json:"generationConfig,omitempty"`
	SystemInstruction *geminiContent          `json:"systemInstruction,omitempty"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"` // "user" | "model"
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text string `json:"text"`
}

type geminiGenerationConfig struct {
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

type geminiResponse struct {
	Candidates    []geminiCandidate    `json:"candidates"`
	UsageMetadata geminiUsageMetadata  `json:"usageMetadata"`
	ModelVersion  string               `json:"modelVersion"`
}

type geminiCandidate struct {
	Content       geminiContent `json:"content"`
	FinishReason  string        `json:"finishReason"`
	Index         int           `json:"index"`
}

type geminiUsageMetadata struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
	TotalTokenCount      int `json:"totalTokenCount"`
}

// Chat sends messages to Gemini and returns an OpenAI-compatible Response.
// Streaming is not yet supported for Gemini in this implementation.
func (p *GoogleProvider) Chat(ctx context.Context, model string, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	if maxTokens <= 0 {
		maxTokens = 1024
	}

	// Map OpenAI messages to Gemini contents, separating system prompt.
	var systemInstruction *geminiContent
	var contents []geminiContent
	for _, m := range msgs {
		if m.Role == "system" {
			systemInstruction = &geminiContent{
				Parts: []geminiPart{{Text: m.Content}},
			}
			continue
		}
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		contents = append(contents, geminiContent{
			Role:  role,
			Parts: []geminiPart{{Text: m.Content}},
		})
	}

	reqBody := geminiRequest{
		Contents: contents,
		GenerationConfig: &geminiGenerationConfig{
			MaxOutputTokens: maxTokens,
		},
		SystemInstruction: systemInstruction,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("google: marshal request: %w", err)
	}

	endpoint := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s",
		model, p.apiKey,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("google: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("google: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("google: status %d: %s", resp.StatusCode, string(body))
	}

	var gr geminiResponse
	if err := json.NewDecoder(resp.Body).Decode(&gr); err != nil {
		return nil, fmt.Errorf("google: decode response: %w", err)
	}

	if len(gr.Candidates) == 0 {
		return nil, fmt.Errorf("google: no candidates in response")
	}

	// Extract text from first candidate.
	text := ""
	for _, part := range gr.Candidates[0].Content.Parts {
		text += part.Text
	}

	return &models.Response{
		ID:     fmt.Sprintf("gemini-%d", time.Now().UnixNano()),
		Object: "chat.completion",
		Model:  model,
		Choices: []models.Choice{
			{
				Index: 0,
				Message: models.Message{
					Role:    "assistant",
					Content: text,
				},
				FinishReason: mapGeminiFinishReason(gr.Candidates[0].FinishReason),
			},
		},
		Usage: models.Usage{
			PromptTokens:     gr.UsageMetadata.PromptTokenCount,
			CompletionTokens: gr.UsageMetadata.CandidatesTokenCount,
			TotalTokens:      gr.UsageMetadata.TotalTokenCount,
		},
	}, nil
}

func mapGeminiFinishReason(r string) string {
	switch r {
	case "STOP":
		return "stop"
	case "MAX_TOKENS":
		return "length"
	case "SAFETY":
		return "content_filter"
	default:
		return strings.ToLower(r)
	}
}
