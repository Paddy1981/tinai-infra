package models

// Model represents a registered AI model the gateway can route to.
type Model struct {
	ID                    string // e.g. "claude-sonnet-4-6", "gemini-pro", "llama3:8b"
	Provider              string // "anthropic", "google", "ollama", "sarvam", "krutrim"
	Sovereign             bool   // true = Indian sovereign model; /sovereign routes restrict to these
	InputPricePaisePer1K  int64  // price in Indian paise per 1K input tokens
	OutputPricePaisePer1K int64  // price in Indian paise per 1K output tokens
	MaxContextTokens      int
	Available             bool
}

// Message is the OpenAI-compatible chat message format used throughout the gateway.
type Message struct {
	Role    string `json:"role"`    // "system", "user", "assistant"
	Content string `json:"content"`
}

// Response is the normalised OpenAI-compatible response returned by every provider.
type Response struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

// Choice holds a single completion candidate.
type Choice struct {
	Index        int     `json:"index"`
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"`
}

// Usage carries token consumption figures.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Registry is the canonical list of models the gateway supports.
var Registry = []Model{
	{
		ID:                    "claude-sonnet-4-6",
		Provider:              "anthropic",
		InputPricePaisePer1K:  250,
		OutputPricePaisePer1K: 1250,
		MaxContextTokens:      200000,
		Available:             true,
	},
	{
		ID:                    "claude-haiku-4-5",
		Provider:              "anthropic",
		InputPricePaisePer1K:  20,
		OutputPricePaisePer1K: 100,
		MaxContextTokens:      200000,
		Available:             true,
	},
	{
		ID:                    "gemini-2.0-flash",
		Provider:              "google",
		InputPricePaisePer1K:  5,
		OutputPricePaisePer1K: 15,
		MaxContextTokens:      1000000,
		Available:             true,
	},
	{
		ID:                    "gemini-1.5-pro",
		Provider:              "google",
		InputPricePaisePer1K:  30,
		OutputPricePaisePer1K: 120,
		MaxContextTokens:      2000000,
		Available:             true,
	},
	{
		ID:                    "llama3:8b",
		Provider:              "ollama",
		InputPricePaisePer1K:  0,
		OutputPricePaisePer1K: 0,
		MaxContextTokens:      8192,
		Available:             true,
	},
	{
		ID:                    "llama3:70b",
		Provider:              "ollama",
		InputPricePaisePer1K:  0,
		OutputPricePaisePer1K: 0,
		MaxContextTokens:      8192,
		Available:             true,
	},
	{
		ID:                    "sarvam-vikram-105b",
		Provider:              "sarvam",
		Sovereign:             true,
		InputPricePaisePer1K:  180,
		OutputPricePaisePer1K: 900,
		MaxContextTokens:      128000,
		Available:             true,
	},
	{
		ID:                    "sarvam-vikram-8b",
		Provider:              "sarvam",
		Sovereign:             true,
		InputPricePaisePer1K:  15,
		OutputPricePaisePer1K: 75,
		MaxContextTokens:      32000,
		Available:             true,
	},
	{
		ID:                    "krutrim-pro",
		Provider:              "krutrim",
		Sovereign:             true,
		InputPricePaisePer1K:  120,
		OutputPricePaisePer1K: 600,
		MaxContextTokens:      128000,
		Available:             true,
	},
	{
		ID:                    "krutrim-2",
		Provider:              "krutrim",
		Sovereign:             true,
		InputPricePaisePer1K:  200,
		OutputPricePaisePer1K: 1000,
		MaxContextTokens:      200000,
		Available:             true,
	},
}

// Lookup returns the Model with the given ID and true, or a zero Model and false.
func Lookup(id string) (Model, bool) {
	for _, m := range Registry {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

// SovereignModels returns the subset of Registry entries where Sovereign is true.
func SovereignModels() []Model {
	var out []Model
	for _, m := range Registry {
		if m.Sovereign {
			out = append(out, m)
		}
	}
	return out
}

// ComputeCostPaise calculates the total spend in paise for a request.
func (m Model) ComputeCostPaise(inputTokens, outputTokens int) int64 {
	inputCost := int64(inputTokens) * m.InputPricePaisePer1K / 1000
	outputCost := int64(outputTokens) * m.OutputPricePaisePer1K / 1000
	return inputCost + outputCost
}
