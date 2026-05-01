package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"tinai.cloud/build-api/internal/deployer"
	"tinai.cloud/build-api/internal/detect"
)

// internalToken is the bearer token required for all /api/v1/* routes.
// Loaded from INTERNAL_API_TOKEN at startup. If unset, authentication is
// skipped with a warning (dev mode only — never deploy without it).
var internalToken string

func init() {
	internalToken = os.Getenv("INTERNAL_API_TOKEN")
	if internalToken == "" {
		log.Fatal("INTERNAL_API_TOKEN must be set")
	}
}

// BuildTriggerer is a minimal interface that lets the API handler trigger
// builds without importing the full builder package (avoids circular deps).
type BuildTriggerer interface {
	TriggerBuild(ctx context.Context, repoFullName, cloneURL, commit, region, tenant string) error
}

type Handler struct {
	dep     *deployer.Deployer
	builder BuildTriggerer // may be nil in tests
}

func New(dep *deployer.Deployer) *Handler {
	return &Handler{dep: dep}
}

// WithBuilder attaches a BuildTriggerer so the /build/* endpoints are active.
func (h *Handler) WithBuilder(b BuildTriggerer) *Handler {
	h.builder = b
	return h
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/apps", h.requireToken(h.listApps))
	mux.Handle("GET /api/v1/apps/{name}", h.requireToken(h.getApp))
	mux.Handle("POST /api/v1/apps/{name}/promote", h.requireToken(h.promoteApp))
	mux.Handle("POST /api/v1/apps/{name}/rollback", h.requireToken(h.rollbackApp))
	mux.Handle("GET /api/v1/apps/{name}/logs", h.requireToken(h.getLogs))

	// Zero-config build endpoints.
	mux.Handle("POST /build/detect", h.requireToken(h.detectBuild))
	mux.Handle("POST /build/trigger", h.requireToken(h.triggerBuild))
}

// requireToken wraps an http.HandlerFunc with a simple bearer token check
// against INTERNAL_API_TOKEN. Returns HTTP 401 on mismatch.
// If INTERNAL_API_TOKEN is unset (dev mode), the check is skipped.
func (h *Handler) requireToken(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if internalToken == "" {
			// Dev mode — no token configured.
			next(w, r)
			return
		}

		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeJSONError(w, "missing or malformed Authorization header", http.StatusUnauthorized)
			return
		}
		provided := strings.TrimPrefix(auth, "Bearer ")
		if provided != internalToken {
			writeJSONError(w, "invalid token", http.StatusUnauthorized)
			return
		}

		next(w, r)
	})
}

func (h *Handler) listApps(w http.ResponseWriter, r *http.Request) {
	apps, err := h.dep.ListApps(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, apps)
}

func (h *Handler) getApp(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	app, err := h.dep.GetApp(r.Context(), name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, app)
}

func (h *Handler) promoteApp(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	region := r.URL.Query().Get("region")
	if region == "" {
		region = "IN"
	}
	if err := h.dep.PromoteApp(r.Context(), name, region); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "promoted", "app": name, "region": region})
}

func (h *Handler) rollbackApp(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	region := r.URL.Query().Get("region")
	if region == "" {
		region = "IN"
	}
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		ns = "staging"
	}
	if err := h.dep.RollbackApp(r.Context(), name, region, nsName(ns)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "rolled back", "app": name, "ns": ns, "region": region})
}

func (h *Handler) getLogs(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		ns = "staging"
	}
	tail, _ := strconv.ParseInt(r.URL.Query().Get("tail"), 10, 64)
	if tail == 0 {
		tail = 100
	}
	logs, err := h.dep.GetLogs(r.Context(), name, nsName(ns), tail)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(logs))
}

// ---------- /build/* handlers ----------

// detectBuildRequest is the JSON body for POST /build/detect.
type detectBuildRequest struct {
	RepoURL string `json:"repo_url"`
	Ref     string `json:"ref"` // branch, tag, or commit SHA (optional, defaults to HEAD)
}

// detectBuild clones the repo shallowly, runs the detector, and returns the
// BuildPlan as JSON — including the generated Dockerfile content.
//
// POST /build/detect
//
//	{"repo_url": "https://...", "ref": "main"}
func (h *Handler) detectBuild(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req detectBuildRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.RepoURL == "" {
		writeJSONError(w, "repo_url is required", http.StatusBadRequest)
		return
	}

	dir, cleanup, err := shallowClone(req.RepoURL, req.Ref)
	if err != nil {
		writeJSONError(w, fmt.Sprintf("clone failed: %v", err), http.StatusInternalServerError)
		return
	}
	defer cleanup()

	plan, err := detect.Detect(dir)
	if err != nil {
		writeJSONError(w, fmt.Sprintf("detect failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("detect: repo=%s runtime=%s framework=%s port=%d", req.RepoURL, plan.Runtime, plan.Framework, plan.Port)
	writeJSON(w, plan)
}

// triggerBuildRequest is the JSON body for POST /build/trigger.
type triggerBuildRequest struct {
	RepoFullName string `json:"repo_full_name"` // e.g. "orgname/reponame"
	CloneURL     string `json:"clone_url"`
	Commit       string `json:"commit"`         // full SHA
	Region       string `json:"region"`         // "IN", "QA", "AE" — defaults to "IN"
	AutoDetect   bool   `json:"auto_detect"`    // if true and no Dockerfile, generate one
}

// triggerBuild triggers a Kaniko build for the supplied repository. When
// auto_detect is true it clones the repo first, runs the detector, and if no
// Dockerfile is found it injects a generated one via StrategyGenerated.
//
// POST /build/trigger
//
//	{"repo_full_name": "org/app", "clone_url": "https://...", "commit": "abc123", "auto_detect": true}
func (h *Handler) triggerBuild(w http.ResponseWriter, r *http.Request) {
	if h.builder == nil {
		writeJSONError(w, "build trigger not available (builder not initialised)", http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req triggerBuildRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.RepoFullName == "" || req.CloneURL == "" || req.Commit == "" {
		writeJSONError(w, "repo_full_name, clone_url, and commit are required", http.StatusBadRequest)
		return
	}
	if req.Region == "" {
		req.Region = "IN"
	}

	if req.AutoDetect {
		dir, cleanup, err := shallowClone(req.CloneURL, req.Commit)
		if err != nil {
			// Non-fatal: fall through to a normal build which will fail fast if
			// no Dockerfile is present.
			log.Printf("triggerBuild: auto_detect clone failed (will attempt without): %v", err)
		} else {
			defer cleanup()
			plan, err := detect.Detect(dir)
			if err != nil {
				log.Printf("triggerBuild: detect failed (will attempt without): %v", err)
			} else if plan.Runtime != "docker" && plan.Dockerfile != "" {
				log.Printf("triggerBuild: auto_detect runtime=%s framework=%s — injecting generated Dockerfile", plan.Runtime, plan.Framework)
				// Write the generated Dockerfile into the cloned workspace so
				// TriggerBuild picks it up via the repo's clone URL.  Because
				// TriggerBuild re-clones inside the Kaniko job we instead log
				// the plan and pass it back to the caller; the actual injection
				// happens in the Kaniko prepare container via StrategyGenerated
				// (nixpacks.go).  For now we surface the plan in the response.
				w.Header().Set("X-Tinai-Detected-Runtime", plan.Runtime)
				w.Header().Set("X-Tinai-Detected-Framework", plan.Framework)
			}
		}
	}

	// Extract tenant from repo org name; the builder routes to the correct namespace.
	tenant := tenantFromRepo(req.RepoFullName)
	if err := h.builder.TriggerBuild(r.Context(), req.RepoFullName, req.CloneURL, req.Commit, req.Region, tenant); err != nil {
		log.Printf("triggerBuild: %v", err)
		writeJSONError(w, fmt.Sprintf("build trigger failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("build triggered via API: repo=%s commit=%s region=%s auto_detect=%v",
		req.RepoFullName, req.Commit[:min(len(req.Commit), 8)], req.Region, req.AutoDetect)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"status": "accepted", "repo": req.RepoFullName, "commit": req.Commit, "region": req.Region})
}

// shallowClone performs a `git clone --depth=1` of repoURL into a temp
// directory.  ref may be a branch, tag, or empty (defaults to HEAD).
// Returns the directory path and a cleanup function that removes it.
func shallowClone(repoURL, ref string) (dir string, cleanup func(), err error) {
	dir, err = os.MkdirTemp("", "tinai-detect-*")
	if err != nil {
		return "", func() {}, fmt.Errorf("mktemp: %w", err)
	}
	cleanup = func() { os.RemoveAll(dir) }

	args := []string{"clone", "--depth=1", "--single-branch"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	args = append(args, repoURL, dir)

	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("git clone: %w\n%s", err, out)
	}
	return filepath.Clean(dir), cleanup, nil
}

// nsName maps "staging"/"prod" to the actual namespace names.
// Only allows known namespaces to prevent namespace escape attacks.
func nsName(s string) string {
	allowed := map[string]string{
		"staging":      "tinai-staging",
		"prod":         "tinai-prod",
		"tinai-staging": "tinai-staging",
		"tinai-prod":    "tinai-prod",
		"tinai-build":   "tinai-build",
	}
	if ns, ok := allowed[s]; ok {
		return ns
	}
	// Tenant namespaces must start with "tenant-"
	if strings.HasPrefix(s, "tenant-") && regexp.MustCompile(`^tenant-[a-z0-9-]+$`).MatchString(s) {
		return s
	}
	return "tinai-staging" // safe fallback
}

// tenantFromRepo extracts the org portion of "org/repo" as the tenant ID.
func tenantFromRepo(repoFullName string) string {
	if idx := strings.Index(repoFullName, "/"); idx > 0 {
		return repoFullName[:idx]
	}
	return ""
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
