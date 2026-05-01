// Package handlers contains HTTP handler types that sit alongside the core
// auth package but depend on additional internal packages (e.g. oidc).
package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"tinai.cloud/auth/internal/auth"
	"tinai.cloud/auth/internal/config"
	"tinai.cloud/auth/internal/oidc"
)

// OIDCHandler handles the OIDC login and callback flows.
type OIDCHandler struct {
	cfg     *oidc.Config
	db      *sql.DB
	appCfg  config.Config
	onLogin func(method, status string) // optional Prometheus hook; nil-safe
}

// NewOIDCHandler constructs an OIDCHandler.
// onLogin may be nil; if provided it is called with the same signature as
// auth.Handler.OnLogin (method, status).
func NewOIDCHandler(cfg *oidc.Config, db *sql.DB, appCfg config.Config, onLogin func(string, string)) *OIDCHandler {
	return &OIDCHandler{cfg: cfg, db: db, appCfg: appCfg, onLogin: onLogin}
}

// Register mounts the SSO redirect and callback routes onto mux.
//
// Because tinai-auth targets Go 1.21 (no r.PathValue), the routes are
// registered as a single prefix pattern and the provider name is parsed
// from the URL path at request time.
//
//	GET /api/v1/auth/sso/{provider}           → OIDCHandler.Redirect
//	GET /api/v1/auth/sso/{provider}/callback  → OIDCHandler.Callback
func (h *OIDCHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/auth/sso/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/callback") {
			h.Callback(w, r)
		} else {
			h.Redirect(w, r)
		}
	})
}

// Redirect handles GET /api/v1/auth/sso/{provider}.
// It validates the provider, generates a CSRF state cookie, and redirects
// the browser to the provider's authorization endpoint.
func (h *OIDCHandler) Redirect(w http.ResponseWriter, r *http.Request) {
	providerName := providerFromPath(r.URL.Path, false)
	if providerName == "" {
		writeJSONError(w, "could not determine SSO provider from URL", http.StatusBadRequest)
		return
	}

	p, ok := h.cfg.Providers[providerName]
	if !ok {
		writeJSONError(w, "unknown SSO provider: "+providerName, http.StatusBadRequest)
		return
	}

	state := randomState()
	http.SetCookie(w, &http.Cookie{
		Name:     "oidc_state",
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   300,
	})

	http.Redirect(w, r, p.AuthCodeURL(state), http.StatusFound)
}

// Callback handles GET /api/v1/auth/sso/{provider}/callback.
// It validates the CSRF state, exchanges the authorization code for an
// IDToken, upserts the user in Postgres, and issues a Tinai JWT.
func (h *OIDCHandler) Callback(w http.ResponseWriter, r *http.Request) {
	providerName := providerFromPath(r.URL.Path, true)
	if providerName == "" {
		writeJSONError(w, "could not determine SSO provider from URL", http.StatusBadRequest)
		return
	}

	p, ok := h.cfg.Providers[providerName]
	if !ok {
		writeJSONError(w, "unknown SSO provider: "+providerName, http.StatusBadRequest)
		return
	}

	// Validate CSRF state.
	stateCookie, err := r.Cookie("oidc_state")
	if err != nil || stateCookie.Value != r.URL.Query().Get("state") {
		writeJSONError(w, "invalid state parameter", http.StatusBadRequest)
		return
	}
	// Clear state cookie immediately after validation.
	http.SetCookie(w, &http.Cookie{Name: "oidc_state", MaxAge: -1, Path: "/"})

	// Surface provider-side errors (user denied, misconfiguration, etc.).
	code := r.URL.Query().Get("code")
	if code == "" {
		errMsg := r.URL.Query().Get("error_description")
		if errMsg == "" {
			errMsg = r.URL.Query().Get("error")
		}
		if errMsg == "" {
			errMsg = "no authorization code returned"
		}
		writeJSONError(w, "SSO error: "+errMsg, http.StatusBadRequest)
		return
	}

	// Exchange authorization code for user identity.
	idToken, err := p.Exchange(r.Context(), code)
	if err != nil {
		log.Printf("oidc callback [%s] exchange: %v", providerName, err)
		writeJSONError(w, fmt.Sprintf("SSO exchange failed: %v", err), http.StatusInternalServerError)
		return
	}
	if idToken.Email == "" {
		writeJSONError(w, "SSO provider did not return an email address", http.StatusBadRequest)
		return
	}

	// Upsert user: find by email or create with an empty password_hash
	// (SSO users never authenticate via password).
	var userID, role, tenantID string
	err = h.db.QueryRowContext(r.Context(),
		`SELECT id, role, tenant_id FROM users WHERE email = $1`,
		idToken.Email,
	).Scan(&userID, &role, &tenantID)

	if err == sql.ErrNoRows {
		// New SSO user — auto-provision with default tenant/role.
		err = h.db.QueryRowContext(r.Context(),
			`INSERT INTO users (email, password_hash, role, tenant_id, region)
			 VALUES ($1, '', 'tenant', 'tinai-admin', 'IN')
			 RETURNING id, role, tenant_id`,
			idToken.Email,
		).Scan(&userID, &role, &tenantID)
		if err != nil {
			log.Printf("oidc callback [%s] create user: %v", providerName, err)
			writeJSONError(w, "account creation failed", http.StatusInternalServerError)
			return
		}
	} else if err != nil {
		log.Printf("oidc callback [%s] lookup user: %v", providerName, err)
		writeJSONError(w, "user lookup failed", http.StatusInternalServerError)
		return
	}

	// Best-effort last_login stamp — ignore error (same pattern as existing handlers).
	h.db.ExecContext(r.Context(), //nolint:errcheck
		`UPDATE users SET last_login = NOW() WHERE id = $1`, userID)

	if h.onLogin != nil {
		h.onLogin("sso_"+providerName, "success")
	}

	claims := auth.NewClaims(userID, idToken.Email, role, tenantID, h.appCfg.JWTExpirySec)
	token := auth.Sign(claims, h.appCfg.JWTSecret)

	writeJSON(w, map[string]any{
		"token": token,
		"user": map[string]string{
			"id":        userID,
			"email":     idToken.Email,
			"role":      role,
			"tenant_id": tenantID,
			"provider":  providerName,
		},
		"expires_in": h.appCfg.JWTExpirySec,
	})
}

// providerFromPath extracts the provider name from a path of the form:
//
//	/api/v1/auth/sso/{provider}           (isCallback=false)
//	/api/v1/auth/sso/{provider}/callback  (isCallback=true)
func providerFromPath(path string, isCallback bool) string {
	var parts []string
	for _, seg := range strings.Split(path, "/") {
		if seg != "" {
			parts = append(parts, seg)
		}
	}
	// Expected segments: ["api", "v1", "auth", "sso", "{provider}"]
	//               or:  ["api", "v1", "auth", "sso", "{provider}", "callback"]
	for i, seg := range parts {
		if seg == "sso" && i+1 < len(parts) {
			candidate := parts[i+1]
			if isCallback {
				if i+2 < len(parts) && parts[i+2] == "callback" {
					return candidate
				}
				return ""
			}
			return candidate
		}
	}
	return ""
}

func randomState() string {
	b := make([]byte, 16)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeJSONError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint:errcheck
}
