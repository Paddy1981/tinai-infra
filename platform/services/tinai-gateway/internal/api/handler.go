// Package api contains the HTTP handler for the Tinai AI Gateway.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/tinai/tinai-gateway/internal/cache"
	"github.com/tinai/tinai-gateway/internal/models"
	"github.com/tinai/tinai-gateway/internal/providers"
	"github.com/tinai/tinai-gateway/internal/quota"
	"github.com/tinai/tinai-gateway/internal/router"
)

// ---- Prometheus metrics ----

var (
	metricRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_gateway_requests_total",
		Help: "Total chat completion requests.",
	}, []string{"model", "provider"})

	metricTokens = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_gateway_tokens_total",
		Help: "Total tokens consumed.",
	}, []string{"model", "type"}) // type: "input" | "output"

	metricCacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_gateway_cache_hits_total",
		Help: "Cache hit count.",
	}, []string{"model"})

	metricErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tinai_gateway_errors_total",
		Help: "Total errors by model.",
	}, []string{"model", "provider"})

	metricLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "tinai_gateway_request_duration_seconds",
		Help:    "Request latency distribution.",
		Buckets: prometheus.DefBuckets,
	}, []string{"model", "provider"})
)

// ---- Request / response types ----

// ChatRequest is the OpenAI-compatible incoming payload.
type ChatRequest struct {
	Model     string          `json:"model"`
	Messages  []models.Message `json:"messages"`
	Stream    bool            `json:"stream"`
	MaxTokens int             `json:"max_tokens"`
}

// ChatResponse extends models.Response with Tinai-specific metadata fields.
type ChatResponse struct {
	models.Response
	XTinaiCache      string `json:"x-tinai-cache"`        // "hit" | "miss"
	XTinaiCostPaise  int64  `json:"x-tinai-cost-paise"`
	XTinaiProvider   string `json:"x-tinai-provider"`
}

// Config holds dependencies injected into the Handler.
type Config struct {
	Cache         *cache.SemanticCache
	Quota         *quota.Manager
	AnthropicKey  string
	GeminiKey     string
	OllamaBaseURL string
	SarvamKey     string
	KrutrimKey    string
}

// Handler is the main HTTP handler.
type Handler struct {
	cfg         Config
	anthropic   *providers.AnthropicProvider
	google      *providers.GoogleProvider
	ollama      *providers.OllamaProvider
	sarvam      *providers.SarvamProvider
	krutrim     *providers.KrutrimProvider
}

// NewHandler wires up all providers and returns a Handler.
func NewHandler(cfg Config) *Handler {
	return &Handler{
		cfg:       cfg,
		anthropic: providers.NewAnthropicProvider(cfg.AnthropicKey),
		google:    providers.NewGoogleProvider(cfg.GeminiKey),
		ollama:    providers.NewOllamaProvider(cfg.OllamaBaseURL),
		sarvam:    providers.NewSarvamProvider(cfg.SarvamKey),
		krutrim:   providers.NewKrutrimProvider(cfg.KrutrimKey),
	}
}

// Chat handles POST /v1/chat.
//
//  1. Extract X-Tenant-ID (required)
//  2. Check quota — if exceeded, force model to llama3:8b
//  3. Check cache (SHA-256 of messages)
//  4. If cache miss: route to provider, get response
//  5. Record usage (async goroutine)
//  6. Store in cache (async goroutine)
//  7. Return OpenAI-format response with x-tinai-* extension fields
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	tenantID := r.Header.Get("X-Tenant-ID")
	if tenantID == "" {
		jsonError(w, "X-Tenant-ID header is required", http.StatusBadRequest)
		return
	}

	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}
	if len(req.Messages) == 0 {
		jsonError(w, "messages array must not be empty", http.StatusBadRequest)
		return
	}

	// Route — takes quota into account.
	decision := router.Route(r.Context(), req.Model, tenantID, h.cfg.Quota)
	selectedModel := decision.Model

	// Cache lookup.
	cacheText := cache.CacheText(req.Messages)
	cacheKey := cache.CacheKey(req.Messages)
	cached, err := h.cfg.Cache.Lookup(r.Context(), cacheKey, cacheText)
	if err != nil {
		log.Printf("cache lookup error: %v", err) // non-fatal
	}

	if cached != nil {
		// Cache hit.
		metricCacheHits.WithLabelValues(cached.ModelID).Inc()
		metricRequests.WithLabelValues(cached.ModelID, selectedModel.Provider).Inc()

		// Record cache-hit usage row (0 tokens consumed).
		go func() {
			if err := h.cfg.Quota.RecordUsage(context.Background(), tenantID, cached.ModelID, 0, 0, 0, true); err != nil {
				log.Printf("billing record failed (cache hit): %v", err)
			}
		}()

		resp := ChatResponse{
			Response:        *cached.Response,
			XTinaiCache:     "hit",
			XTinaiCostPaise: 0,
			XTinaiProvider:  selectedModel.Provider,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Streaming path.
	if req.Stream {
		h.streamChat(w, r, tenantID, req, selectedModel, cacheKey)
		return
	}

	// Non-streaming: call provider.
	providerResp, err := h.callProvider(r.Context(), selectedModel, req.Messages, req.MaxTokens, false, nil)
	if err != nil {
		metricErrors.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()
		log.Printf("provider error [%s]: %v", selectedModel.ID, err)
		jsonError(w, fmt.Sprintf("provider error: %v", err), http.StatusBadGateway)
		return
	}

	duration := time.Since(start).Seconds()
	metricRequests.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()
	metricLatency.WithLabelValues(selectedModel.ID, selectedModel.Provider).Observe(duration)
	metricTokens.WithLabelValues(selectedModel.ID, "input").Add(float64(providerResp.Usage.PromptTokens))
	metricTokens.WithLabelValues(selectedModel.ID, "output").Add(float64(providerResp.Usage.CompletionTokens))

	costPaise := selectedModel.ComputeCostPaise(providerResp.Usage.PromptTokens, providerResp.Usage.CompletionTokens)

	// Record usage asynchronously.
	go func() {
		if err := h.cfg.Quota.RecordUsage(
			context.Background(), tenantID, selectedModel.ID,
			providerResp.Usage.PromptTokens, providerResp.Usage.CompletionTokens,
			costPaise, false,
		); err != nil {
			log.Printf("billing record failed: %v", err)
		}
	}()

	// Cache the response asynchronously.
	go func() {
		_ = h.cfg.Cache.Store(context.Background(), cacheKey, cacheText, providerResp, cache.DefaultTTL)
	}()

	resp := ChatResponse{
		Response:        *providerResp,
		XTinaiCache:     "miss",
		XTinaiCostPaise: costPaise,
		XTinaiProvider:  selectedModel.Provider,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// streamChat handles streaming requests, proxying SSE from the provider to the client.
// It wraps the ResponseWriter with sseUsageWriter to capture token counts from the stream.
func (h *Handler) streamChat(w http.ResponseWriter, r *http.Request, tenantID string, req ChatRequest, selectedModel models.Model, cacheKey string) {
	uw := newSSEUsageWriter(w)
	uw.Header().Set("Content-Type", "text/event-stream")
	uw.Header().Set("Cache-Control", "no-cache")
	uw.Header().Set("X-Accel-Buffering", "no")
	uw.Header().Set("X-Tinai-Provider", selectedModel.Provider)
	uw.Header().Set("X-Tinai-Cache", "miss")

	if _, err := h.callProvider(r.Context(), selectedModel, req.Messages, req.MaxTokens, true, uw); err != nil {
		metricErrors.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()
		log.Printf("stream provider error [%s]: %v", selectedModel.ID, err)
		fmt.Fprintf(uw, "data: {\"error\":\"%v\"}\n\n", err)
	}
	metricRequests.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()

	inputTokens := uw.In
	outputTokens := uw.Out
	costPaise := selectedModel.ComputeCostPaise(inputTokens, outputTokens)

	if inputTokens > 0 || outputTokens > 0 {
		metricTokens.WithLabelValues(selectedModel.ID, "input").Add(float64(inputTokens))
		metricTokens.WithLabelValues(selectedModel.ID, "output").Add(float64(outputTokens))
	}

	go func() {
		if err := h.cfg.Quota.RecordUsage(context.Background(), tenantID, selectedModel.ID, inputTokens, outputTokens, costPaise, false); err != nil {
			log.Printf("billing record failed (stream): %v", err)
		}
	}()
}

// sseUsageWriter wraps http.ResponseWriter and parses SSE data lines to extract
// token usage from both Anthropic and OpenAI-compatible streaming formats.
type sseUsageWriter struct {
	w   http.ResponseWriter
	buf []byte
	In  int // input/prompt tokens
	Out int // output/completion tokens
}

func newSSEUsageWriter(w http.ResponseWriter) *sseUsageWriter {
	return &sseUsageWriter{w: w}
}

func (s *sseUsageWriter) Header() http.Header       { return s.w.Header() }
func (s *sseUsageWriter) WriteHeader(code int)       { s.w.WriteHeader(code) }
func (s *sseUsageWriter) Flush() {
	if f, ok := s.w.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *sseUsageWriter) Write(p []byte) (int, error) {
	n, err := s.w.Write(p)
	s.buf = append(s.buf, p...)
	for {
		idx := bytes.IndexByte(s.buf, '\n')
		if idx < 0 {
			break
		}
		line := strings.TrimRight(string(s.buf[:idx]), "\r")
		s.buf = s.buf[idx+1:]
		s.parseLine(line)
	}
	return n, err
}

func (s *sseUsageWriter) parseLine(line string) {
	if !strings.HasPrefix(line, "data: ") {
		return
	}
	data := line[6:]
	if data == "[DONE]" {
		return
	}

	// OpenAI-compatible: final chunk carries {"usage":{"prompt_tokens":N,"completion_tokens":M}}.
	var oai struct {
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal([]byte(data), &oai) == nil && oai.Usage != nil && oai.Usage.PromptTokens > 0 {
		s.In = oai.Usage.PromptTokens
		s.Out = oai.Usage.CompletionTokens
		return
	}

	// Anthropic message_start: {"type":"message_start","message":{"usage":{"input_tokens":N}}}.
	var aStart struct {
		Type    string `json:"type"`
		Message *struct {
			Usage *struct {
				InputTokens int `json:"input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(data), &aStart) == nil {
		if aStart.Type == "message_start" && aStart.Message != nil && aStart.Message.Usage != nil {
			s.In = aStart.Message.Usage.InputTokens
			return
		}
		// Anthropic message_delta: {"type":"message_delta","usage":{"output_tokens":N}}.
		if aStart.Type == "message_delta" {
			var aDelta struct {
				Usage *struct {
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(data), &aDelta) == nil && aDelta.Usage != nil {
				s.Out = aDelta.Usage.OutputTokens
			}
		}
	}
}

// callProvider dispatches to the correct provider based on selectedModel.
func (h *Handler) callProvider(ctx context.Context, m models.Model, msgs []models.Message, maxTokens int, stream bool, w io.Writer) (*models.Response, error) {
	switch m.Provider {
	case "anthropic":
		return h.anthropic.Chat(ctx, m.ID, msgs, maxTokens, stream, w)
	case "google":
		return h.google.Chat(ctx, m.ID, msgs, maxTokens, stream, w)
	case "ollama":
		return h.ollama.Chat(ctx, m.ID, msgs, maxTokens, stream, w)
	case "sarvam":
		return h.sarvam.Chat(ctx, m.ID, msgs, maxTokens, stream, w)
	case "krutrim":
		return h.krutrim.Chat(ctx, m.ID, msgs, maxTokens, stream, w)
	default:
		return nil, fmt.Errorf("unknown provider: %s", m.Provider)
	}
}

// SovereignChat handles POST /sovereign/v1/chat/completions.
// It behaves identically to Chat but routes exclusively through Indian sovereign models
// and adds X-Tinai-Sovereign: true to every response.
func (h *Handler) SovereignChat(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	tenantID := r.Header.Get("X-Tenant-ID")
	if tenantID == "" {
		jsonError(w, "X-Tenant-ID header is required", http.StatusBadRequest)
		return
	}

	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}
	if len(req.Messages) == 0 {
		jsonError(w, "messages array must not be empty", http.StatusBadRequest)
		return
	}

	// Sovereign routing — restricts to Indian models only.
	decision := router.RouteSovereign(r.Context(), req.Model, tenantID, h.cfg.Quota)
	selectedModel := decision.Model

	// Cache lookup.
	cacheText := cache.CacheText(req.Messages)
	cacheKey := cache.CacheKey(req.Messages)
	cached, err := h.cfg.Cache.Lookup(r.Context(), cacheKey, cacheText)
	if err != nil {
		log.Printf("sovereign cache lookup error: %v", err)
	}

	if cached != nil {
		metricCacheHits.WithLabelValues(cached.ModelID).Inc()
		metricRequests.WithLabelValues(cached.ModelID, selectedModel.Provider).Inc()

		go func() {
			if err := h.cfg.Quota.RecordUsage(context.Background(), tenantID, cached.ModelID, 0, 0, 0, true); err != nil {
				log.Printf("billing record failed (sovereign cache hit): %v", err)
			}
		}()

		w.Header().Set("X-Tinai-Sovereign", "true")
		w.Header().Set("X-Tinai-Provider", selectedModel.Provider)
		resp := ChatResponse{
			Response:        *cached.Response,
			XTinaiCache:     "hit",
			XTinaiCostPaise: 0,
			XTinaiProvider:  selectedModel.Provider,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Streaming path.
	if req.Stream {
		w.Header().Set("X-Tinai-Sovereign", "true")
		w.Header().Set("X-Tinai-Provider", selectedModel.Provider)
		h.streamChat(w, r, tenantID, req, selectedModel, cacheKey)
		return
	}

	// Non-streaming: call provider.
	providerResp, err := h.callProvider(r.Context(), selectedModel, req.Messages, req.MaxTokens, false, nil)
	if err != nil {
		metricErrors.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()
		log.Printf("sovereign provider error [%s]: %v", selectedModel.ID, err)
		jsonError(w, fmt.Sprintf("provider error: %v", err), http.StatusBadGateway)
		return
	}

	duration := time.Since(start).Seconds()
	metricRequests.WithLabelValues(selectedModel.ID, selectedModel.Provider).Inc()
	metricLatency.WithLabelValues(selectedModel.ID, selectedModel.Provider).Observe(duration)
	metricTokens.WithLabelValues(selectedModel.ID, "input").Add(float64(providerResp.Usage.PromptTokens))
	metricTokens.WithLabelValues(selectedModel.ID, "output").Add(float64(providerResp.Usage.CompletionTokens))

	costPaise := selectedModel.ComputeCostPaise(providerResp.Usage.PromptTokens, providerResp.Usage.CompletionTokens)

	go func() {
		if err := h.cfg.Quota.RecordUsage(
			context.Background(), tenantID, selectedModel.ID,
			providerResp.Usage.PromptTokens, providerResp.Usage.CompletionTokens,
			costPaise, false,
		); err != nil {
			log.Printf("billing record failed (sovereign): %v", err)
		}
	}()

	go func() {
		_ = h.cfg.Cache.Store(context.Background(), cacheKey, cacheText, providerResp, cache.DefaultTTL)
	}()

	w.Header().Set("X-Tinai-Sovereign", "true")
	w.Header().Set("X-Tinai-Provider", selectedModel.Provider)
	resp := ChatResponse{
		Response:        *providerResp,
		XTinaiCache:     "miss",
		XTinaiCostPaise: costPaise,
		XTinaiProvider:  selectedModel.Provider,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// SovereignModels handles GET /sovereign/models.
// It returns only the sovereign models from the registry.
func (h *Handler) SovereignModels(w http.ResponseWriter, r *http.Request) {
	type modelEntry struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
		Object   string `json:"object"`
	}
	sovereign := models.SovereignModels()
	list := make([]modelEntry, 0, len(sovereign))
	for _, m := range sovereign {
		if m.Available {
			list = append(list, modelEntry{
				ID:       m.ID,
				Provider: m.Provider,
				Object:   "model",
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"object":    "list",
		"sovereign": true,
		"data":      list,
	})
}

// jsonError writes a JSON error payload with the given status code.
func jsonError(w http.ResponseWriter, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
