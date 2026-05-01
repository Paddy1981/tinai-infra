package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Metric callback types — defined here so callers do not need to import
// the prometheus package to wire them up.
type (
	// InvokeCallback is called after each function invocation with the
	// tenant ID, outcome status ("success", "error", or "timeout"), and
	// elapsed wall-clock seconds.
	InvokeCallback func(tenant, status string, durationSecs float64)

	// DeployCallback is called after a successful deploy (+1) or delete (-1)
	// so the caller can maintain a per-tenant deployed-functions gauge.
	DeployCallback func(tenant string, delta float64)
)

var validFunctionName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// --- Dependency interfaces (allow testing without real implementations) ---

// FunctionRecord is the minimal shape returned by ListFunctions.
// It mirrors db.Function so the api package does not import internal/db.
type FunctionRecord struct {
	ID        string    `json:"id"`
	Tenant    string    `json:"tenant"`
	Name      string    `json:"name"`
	Runtime   string    `json:"runtime"`
	SizeBytes int       `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// FunctionStore abstracts MinIO code storage.
type FunctionStore interface {
	PutFunction(ctx context.Context, tenant, name, code string) error
	GetFunction(ctx context.Context, tenant, name string) (string, error)
	DeleteFunction(ctx context.Context, tenant, name string) error
}

// FunctionDB abstracts PostgreSQL function records.
type FunctionDB interface {
	UpsertFunction(ctx context.Context, tenant, name, runtime string, sizeBytes int) error
	GetFunction(ctx context.Context, tenant, name string) (FunctionRecord, error)
	ListFunctions(ctx context.Context, tenant string) ([]FunctionRecord, error)
	DeleteFunction(ctx context.Context, tenant, name string) error
}

// FunctionRunner abstracts K8s Job execution.
type FunctionRunner interface {
	InvokeFunction(ctx context.Context, tenant, name, code, payload string) (string, error)
}

// --- Handler ---

// Handler holds dependencies for all HTTP route handlers.
type Handler struct {
	db    FunctionDB
	store FunctionStore
	run   FunctionRunner
	// Optional metric callbacks; nil-safe.
	OnInvoke InvokeCallback
	OnDeploy DeployCallback
}

// NewHandler constructs a Handler.
func NewHandler(db FunctionDB, store FunctionStore, run FunctionRunner) *Handler {
	return &Handler{db: db, store: store, run: run}
}

// --- helper types ---

type deployRequest struct {
	Name    string `json:"name"`
	Runtime string `json:"runtime"`
	Code    string `json:"code"`
}

type invokeRequest struct {
	Payload string `json:"payload"`
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func tenantFromRequest(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Tenant-ID"))
}

// --- Route handlers ---

// DeployFunction handles POST /api/v1/functions
// Body: { "name": "...", "runtime": "node20", "code": "..." }
func (h *Handler) DeployFunction(w http.ResponseWriter, r *http.Request) {
	tenant := tenantFromRequest(r)
	if tenant == "" {
		errJSON(w, http.StatusBadRequest, "X-Tenant-ID header is required")
		return
	}

	var req deployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if req.Name == "" {
		errJSON(w, http.StatusBadRequest, "name is required")
		return
	}
	if !validFunctionName.MatchString(req.Name) {
		errJSON(w, http.StatusBadRequest, "name must be lowercase alphanumeric with hyphens, 2-63 chars")
		return
	}
	if req.Code == "" {
		errJSON(w, http.StatusBadRequest, "code is required")
		return
	}
	if req.Runtime == "" {
		req.Runtime = "node20"
	}

	ctx := r.Context()

	// Upload code to MinIO
	if err := h.store.PutFunction(ctx, tenant, req.Name, req.Code); err != nil {
		errJSON(w, http.StatusInternalServerError, "store error: "+err.Error())
		return
	}

	// Upsert DB record
	if err := h.db.UpsertFunction(ctx, tenant, req.Name, req.Runtime, len(req.Code)); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}

	if h.OnDeploy != nil {
		h.OnDeploy(tenant, +1)
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"tenant":  tenant,
		"name":    req.Name,
		"runtime": req.Runtime,
	})
}

// ListFunctions handles GET /api/v1/functions
func (h *Handler) ListFunctions(w http.ResponseWriter, r *http.Request) {
	tenant := tenantFromRequest(r)
	if tenant == "" {
		errJSON(w, http.StatusBadRequest, "X-Tenant-ID header is required")
		return
	}

	fns, err := h.db.ListFunctions(r.Context(), tenant)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}
	if fns == nil {
		fns = []FunctionRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "functions": fns})
}

// GetFunction handles GET /api/v1/functions/:name
// Returns 200 with function metadata if found, 404 if not found.
func (h *Handler) GetFunction(w http.ResponseWriter, r *http.Request, name string) {
	tenant := tenantFromRequest(r)
	if tenant == "" {
		errJSON(w, http.StatusBadRequest, "X-Tenant-ID header is required")
		return
	}

	fn, err := h.db.GetFunction(r.Context(), tenant, name)
	if err != nil {
		if err == sql.ErrNoRows {
			errJSON(w, http.StatusNotFound, "function not found")
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "function": fn})
}

// DeleteFunction handles DELETE /api/v1/functions/:name
func (h *Handler) DeleteFunction(w http.ResponseWriter, r *http.Request, name string) {
	tenant := tenantFromRequest(r)
	if tenant == "" {
		errJSON(w, http.StatusBadRequest, "X-Tenant-ID header is required")
		return
	}

	ctx := r.Context()

	if err := h.db.DeleteFunction(ctx, tenant, name); err != nil {
		if err == sql.ErrNoRows {
			errJSON(w, http.StatusNotFound, "function not found")
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}

	// Remove code object from MinIO (best-effort)
	_ = h.store.DeleteFunction(ctx, tenant, name)

	if h.OnDeploy != nil {
		h.OnDeploy(tenant, -1)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": name})
}

// InvokeFunction handles POST /api/v1/functions/:name/invoke
// Body (optional): { "payload": "..." }
func (h *Handler) InvokeFunction(w http.ResponseWriter, r *http.Request, name string) {
	tenant := tenantFromRequest(r)
	if tenant == "" {
		errJSON(w, http.StatusBadRequest, "X-Tenant-ID header is required")
		return
	}

	var req invokeRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // payload is optional

	ctx := r.Context()

	// Fetch function code from MinIO
	code, err := h.store.GetFunction(ctx, tenant, name)
	if err != nil {
		errJSON(w, http.StatusNotFound, "function not found: "+err.Error())
		return
	}

	// Execute via K8s Job runner — record duration and status for metrics.
	invokeStart := time.Now()
	output, err := h.run.InvokeFunction(ctx, tenant, name, code, req.Payload)
	elapsed := time.Since(invokeStart).Seconds()
	if err != nil {
		if h.OnInvoke != nil {
			h.OnInvoke(tenant, "error", elapsed)
		}
		errJSON(w, http.StatusInternalServerError, "invoke error: "+err.Error())
		return
	}
	if h.OnInvoke != nil {
		h.OnInvoke(tenant, "success", elapsed)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"output": output,
	})
}
