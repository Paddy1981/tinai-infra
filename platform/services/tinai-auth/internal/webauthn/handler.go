// Package webauthn implements HTTP handlers for the WebAuthn / passkeys
// registration and authentication ceremonies.
//
// Routes:
//
//	POST /api/v1/auth/passkey/register/begin   — start registration
//	POST /api/v1/auth/passkey/register/finish  — complete registration, issue JWT
//	POST /api/v1/auth/passkey/login/begin      — start authentication
//	POST /api/v1/auth/passkey/login/finish     — complete authentication, issue JWT
//
// Session state is stored in the webauthn_sessions Postgres table so the
// service remains stateless and safe to run across multiple replicas.
package webauthn

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	gowa "github.com/go-webauthn/webauthn/webauthn"
	gowaprotocol "github.com/go-webauthn/webauthn/protocol"

	"tinai.cloud/auth/internal/auth"
	"tinai.cloud/auth/internal/config"
)

// Handler holds all dependencies for the passkey endpoints.
type Handler struct {
	db      *sql.DB
	cfg     config.Config
	wa      *gowa.WebAuthn
	onLogin func(method, status string) // nil-safe Prometheus hook
}

// NewHandler constructs a Handler.  It reads WEBAUTHN_RPID, WEBAUTHN_ORIGINS
// from the environment, falling back to sensible defaults for tinai.cloud.
// Returns an error only if the go-webauthn Config is invalid.
func NewHandler(db *sql.DB, cfg config.Config, onLogin func(string, string)) (*Handler, error) {
	rpid := getEnv("WEBAUTHN_RPID", "tinai.cloud")

	originsRaw := getEnv("WEBAUTHN_ORIGINS", "https://app.tinai.cloud,https://tinai.cloud")
	var origins []string
	for _, o := range strings.Split(originsRaw, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}

	wa, err := gowa.New(&gowa.Config{
		RPID:          rpid,
		RPDisplayName: "Tinai Cloud",
		RPOrigins:     origins,
	})
	if err != nil {
		return nil, fmt.Errorf("webauthn config: %w", err)
	}

	return &Handler{db: db, cfg: cfg, wa: wa, onLogin: onLogin}, nil
}

// Register mounts the four passkey routes onto mux using Go 1.22 method+path patterns.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/passkey/register/begin", h.registerBegin)
	mux.HandleFunc("POST /api/v1/auth/passkey/register/finish", h.registerFinish)
	mux.HandleFunc("POST /api/v1/auth/passkey/login/begin", h.loginBegin)
	mux.HandleFunc("POST /api/v1/auth/passkey/login/finish", h.loginFinish)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func httpError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint:errcheck
}

// ─── waUser implements gowa.User ──────────────────────────────────────────────

// waUser is a transient in-memory value that satisfies the go-webauthn User
// interface.  It is constructed from data fetched from Postgres and is never
// persisted on its own.
type waUser struct {
	id          []byte // UUID as raw bytes — used as WebAuthn user handle
	email       string
	tenantID    string
	credentials []gowa.Credential
}

func (u *waUser) WebAuthnID() []byte                    { return u.id }
func (u *waUser) WebAuthnName() string                  { return u.email }
func (u *waUser) WebAuthnDisplayName() string           { return u.email }
func (u *waUser) WebAuthnIcon() string                  { return "" }
func (u *waUser) WebAuthnCredentials() []gowa.Credential { return u.credentials }

// ─── DB helpers ───────────────────────────────────────────────────────────────

// lookupUser fetches the user record (id, tenant_id) by email.  The returned
// waUser will have its credentials list pre-loaded from webauthn_credentials.
func (h *Handler) lookupUser(r *http.Request, email string) (*waUser, error) {
	var userIDStr, tenantID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id::text, tenant_id FROM users WHERE email = $1`, email,
	).Scan(&userIDStr, &tenantID)
	if err != nil {
		return nil, err
	}

	userIDBytes, err := uuidStringToBytes(userIDStr)
	if err != nil {
		return nil, fmt.Errorf("uuid parse: %w", err)
	}

	u := &waUser{id: userIDBytes, email: email, tenantID: tenantID}

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT credential_id, public_key, sign_count
		   FROM webauthn_credentials
		  WHERE tenant_id = $1 AND user_id = $2`, tenantID, userIDStr,
	)
	if err != nil {
		return nil, fmt.Errorf("load credentials: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var credID, pubKey []byte
		var signCount int64
		if err := rows.Scan(&credID, &pubKey, &signCount); err != nil {
			return nil, fmt.Errorf("scan credential: %w", err)
		}
		u.credentials = append(u.credentials, gowa.Credential{
			ID:        credID,
			PublicKey: pubKey,
			Authenticator: gowa.Authenticator{
				SignCount: uint32(signCount),
			},
		})
	}
	return u, rows.Err()
}

// saveSession serialises gowa.SessionData to JSONB and stores it in
// webauthn_sessions.  Old expired sessions are pruned first.
func (h *Handler) saveSession(r *http.Request, tenantID, flow string, session *gowa.SessionData) error {
	h.db.ExecContext(r.Context(), //nolint:errcheck
		`DELETE FROM webauthn_sessions WHERE expires_at < NOW()`)

	data, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO webauthn_sessions (tenant_id, challenge, session_data, flow)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (challenge) DO UPDATE
		   SET session_data = EXCLUDED.session_data,
		       expires_at   = NOW() + INTERVAL '5 minutes'`,
		nullableStr(tenantID), session.Challenge, data, flow,
	)
	return err
}

// loadSession fetches and atomically deletes the session row for a given
// challenge, returning the deserialised SessionData.
func (h *Handler) loadSession(r *http.Request, challenge string) (*gowa.SessionData, error) {
	var raw []byte
	err := h.db.QueryRowContext(r.Context(),
		`DELETE FROM webauthn_sessions
		  WHERE challenge = $1 AND expires_at > NOW()
		  RETURNING session_data`,
		challenge,
	).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("session not found or expired")
	}
	if err != nil {
		return nil, fmt.Errorf("load session: %w", err)
	}

	var sd gowa.SessionData
	if err := json.Unmarshal(raw, &sd); err != nil {
		return nil, fmt.Errorf("unmarshal session: %w", err)
	}
	return &sd, nil
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// uuidStringToBytes converts a canonical UUID string (with dashes) to 16 bytes.
func uuidStringToBytes(s string) ([]byte, error) {
	clean := strings.ReplaceAll(s, "-", "")
	if len(clean) != 32 {
		return nil, fmt.Errorf("not a UUID: %q", s)
	}
	b := make([]byte, 16)
	for i := 0; i < 16; i++ {
		hi := hexVal(clean[i*2])
		lo := hexVal(clean[i*2+1])
		if hi < 0 || lo < 0 {
			return nil, fmt.Errorf("invalid hex in UUID %q", s)
		}
		b[i] = byte(hi<<4 | lo)
	}
	return b, nil
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

// bytesToUUIDString converts 16 raw bytes to a canonical UUID string.
func bytesToUUIDString(b []byte) string {
	if len(b) != 16 {
		return ""
	}
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16],
	)
}

// ─── Registration ─────────────────────────────────────────────────────────────

// registerBegin handles POST /api/v1/auth/passkey/register/begin.
//
// Body:  { "email": "user@example.com" }
// Returns: PublicKeyCredentialCreationOptions JSON (for the browser).
func (h *Handler) registerBegin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
		httpError(w, "email required", http.StatusBadRequest)
		return
	}

	user, err := h.lookupUser(r, body.Email)
	if err == sql.ErrNoRows {
		httpError(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("passkey register begin: lookup user: %v", err)
		httpError(w, "internal error", http.StatusInternalServerError)
		return
	}

	creation, session, err := h.wa.BeginRegistration(user)
	if err != nil {
		log.Printf("passkey register begin: BeginRegistration: %v", err)
		httpError(w, "failed to begin registration", http.StatusInternalServerError)
		return
	}

	if err := h.saveSession(r, user.tenantID, "registration", session); err != nil {
		log.Printf("passkey register begin: saveSession: %v", err)
		httpError(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, creation)
}

// registerFinish handles POST /api/v1/auth/passkey/register/finish.
//
// Body:  the PublicKeyCredential JSON returned by the browser's
//
//	navigator.credentials.create() call.
//
// Returns: JWT (same format as the existing password login endpoint).
func (h *Handler) registerFinish(w http.ResponseWriter, r *http.Request) {
	rawBody, parsedBody, err := bufferBody(r)
	if err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	challenge, err := extractChallenge(parsedBody)
	if err != nil {
		httpError(w, "could not extract challenge: "+err.Error(), http.StatusBadRequest)
		return
	}

	session, err := h.loadSession(r, challenge)
	if err != nil {
		httpError(w, "session not found or expired", http.StatusBadRequest)
		return
	}

	// Re-inject the buffered body so FinishRegistration can read it.
	r.Body = io.NopCloser(strings.NewReader(string(rawBody)))

	user, userIDStr, tenantID, err := h.lookupUserByID(r, session.UserID)
	if err != nil {
		log.Printf("passkey register finish: lookupUserByID: %v", err)
		httpError(w, "user not found", http.StatusNotFound)
		return
	}

	credential, err := h.wa.FinishRegistration(user, *session, r)
	if err != nil {
		log.Printf("passkey register finish: FinishRegistration: %v", err)
		httpError(w, "registration verification failed", http.StatusBadRequest)
		return
	}

	backedUp := credential.Flags.BackupState
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO webauthn_credentials
		   (tenant_id, user_id, credential_id, public_key, sign_count, aaguid, transports, backed_up)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		tenantID,
		userIDStr,
		credential.ID,
		credential.PublicKey,
		int64(credential.Authenticator.SignCount),
		aaguidToUUID(credential.Authenticator.AAGUID),
		transportStrings(credential.Transport),
		backedUp,
	)
	if err != nil {
		log.Printf("passkey register finish: insert credential: %v", err)
		httpError(w, "failed to save credential", http.StatusInternalServerError)
		return
	}

	var email, role string
	h.db.QueryRowContext(r.Context(), //nolint:errcheck
		`SELECT email, role FROM users WHERE id = $1`, userIDStr,
	).Scan(&email, &role)

	if h.onLogin != nil {
		h.onLogin("passkey", "success")
	}

	claims := auth.NewClaims(userIDStr, email, role, tenantID, h.cfg.JWTExpirySec)
	token := auth.Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token": token,
		"user": map[string]string{
			"id":        userIDStr,
			"email":     email,
			"role":      role,
			"tenant_id": tenantID,
		},
		"expires_in": h.cfg.JWTExpirySec,
	})
}

// ─── Authentication ───────────────────────────────────────────────────────────

// loginBegin handles POST /api/v1/auth/passkey/login/begin.
//
// Body:  { "email": "user@example.com" }  (or {} for discoverable credentials)
// Returns: PublicKeyCredentialRequestOptions JSON.
func (h *Handler) loginBegin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	// Ignore decode errors — email is optional for discoverable login.
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck

	var (
		assertion *gowaprotocol.CredentialAssertion
		session   *gowa.SessionData
		tenantID  string
		err       error
	)

	if body.Email != "" {
		user, lookupErr := h.lookupUser(r, body.Email)
		if lookupErr == sql.ErrNoRows {
			httpError(w, "user not found", http.StatusNotFound)
			return
		}
		if lookupErr != nil {
			log.Printf("passkey login begin: lookup user: %v", lookupErr)
			httpError(w, "internal error", http.StatusInternalServerError)
			return
		}
		tenantID = user.tenantID
		assertion, session, err = h.wa.BeginLogin(user)
	} else {
		assertion, session, err = h.wa.BeginDiscoverableLogin()
	}

	if err != nil {
		log.Printf("passkey login begin: %v", err)
		httpError(w, "failed to begin login", http.StatusInternalServerError)
		return
	}

	if err := h.saveSession(r, tenantID, "authentication", session); err != nil {
		log.Printf("passkey login begin: saveSession: %v", err)
		httpError(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, assertion)
}

// loginFinish handles POST /api/v1/auth/passkey/login/finish.
//
// Body:  the PublicKeyCredential JSON returned by the browser's
//
//	navigator.credentials.get() call.
//
// Returns: JWT (same format as the existing password login endpoint).
func (h *Handler) loginFinish(w http.ResponseWriter, r *http.Request) {
	rawBody, parsedBody, err := bufferBody(r)
	if err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	challenge, err := extractChallenge(parsedBody)
	if err != nil {
		httpError(w, "could not extract challenge: "+err.Error(), http.StatusBadRequest)
		return
	}

	session, err := h.loadSession(r, challenge)
	if err != nil {
		httpError(w, "session not found or expired", http.StatusBadRequest)
		return
	}

	r.Body = io.NopCloser(strings.NewReader(string(rawBody)))

	var (
		credential *gowa.Credential
		userIDStr  string
		tenantID   string
	)

	if session.UserID != nil {
		// Known-user flow: UserID was set during loginBegin.
		var user *waUser
		user, userIDStr, tenantID, err = h.lookupUserByID(r, session.UserID)
		if err != nil {
			log.Printf("passkey login finish: lookupUserByID: %v", err)
			httpError(w, "user not found", http.StatusNotFound)
			return
		}
		credential, err = h.wa.FinishLogin(user, *session, r)
	} else {
		// Discoverable flow: browser returns userHandle in the assertion.
		credential, err = h.wa.FinishDiscoverableLogin(
			func(rawID, userHandle []byte) (gowa.User, error) {
				u, uid, tid, e := h.lookupUserByID(r, userHandle)
				if e != nil {
					return nil, e
				}
				userIDStr = uid
				tenantID = tid
				return u, nil
			},
			*session, r,
		)
	}

	if err != nil {
		log.Printf("passkey login finish: %v", err)
		if h.onLogin != nil {
			h.onLogin("passkey", "failure")
		}
		httpError(w, "authentication failed", http.StatusUnauthorized)
		return
	}

	var email, role string
	h.db.QueryRowContext(r.Context(), //nolint:errcheck
		`SELECT email, role FROM users WHERE id = $1`, userIDStr,
	).Scan(&email, &role)

	// Update sign_count and last_used_at for the matched credential.
	h.db.ExecContext(r.Context(), //nolint:errcheck
		`UPDATE webauthn_credentials
		    SET sign_count = $1, last_used_at = NOW()
		  WHERE credential_id = $2`,
		int64(credential.Authenticator.SignCount),
		credential.ID,
	)

	h.db.ExecContext(r.Context(), //nolint:errcheck
		`UPDATE users SET last_login = NOW() WHERE id = $1`, userIDStr)

	if h.onLogin != nil {
		h.onLogin("passkey", "success")
	}

	claims := auth.NewClaims(userIDStr, email, role, tenantID, h.cfg.JWTExpirySec)
	token := auth.Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token": token,
		"user": map[string]string{
			"id":        userIDStr,
			"email":     email,
			"role":      role,
			"tenant_id": tenantID,
		},
		"expires_in": h.cfg.JWTExpirySec,
	})
}

// ─── internal helpers ─────────────────────────────────────────────────────────

// lookupUserByID finds a user by their 16-byte WebAuthn user handle (UUID as
// raw bytes).  Returns the waUser, the UUID string, and the tenantID.
func (h *Handler) lookupUserByID(r *http.Request, idBytes []byte) (*waUser, string, string, error) {
	uuidStr := bytesToUUIDString(idBytes)
	var email, tenantID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT email, tenant_id FROM users WHERE id = $1::uuid`, uuidStr,
	).Scan(&email, &tenantID)
	if err != nil {
		return nil, "", "", err
	}

	u := &waUser{id: idBytes, email: email, tenantID: tenantID}

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT credential_id, public_key, sign_count
		   FROM webauthn_credentials
		  WHERE tenant_id = $1 AND user_id = $2`, tenantID, uuidStr,
	)
	if err != nil {
		return nil, "", "", fmt.Errorf("load credentials: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var credID, pubKey []byte
		var signCount int64
		if err := rows.Scan(&credID, &pubKey, &signCount); err != nil {
			return nil, "", "", fmt.Errorf("scan credential: %w", err)
		}
		u.credentials = append(u.credentials, gowa.Credential{
			ID:        credID,
			PublicKey: pubKey,
			Authenticator: gowa.Authenticator{
				SignCount: uint32(signCount),
			},
		})
	}
	return u, uuidStr, tenantID, rows.Err()
}

// bufferBody reads r.Body entirely, decodes it as JSON into a
// map[string]json.RawMessage, and returns both the raw bytes (for replaying)
// and the decoded map (for challenge extraction).
func bufferBody(r *http.Request) ([]byte, map[string]json.RawMessage, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil, err
	}
	return raw, m, nil
}

// extractChallenge digs out the base64url-encoded challenge from a
// PublicKeyCredential JSON object by decoding response.clientDataJSON.
func extractChallenge(raw map[string]json.RawMessage) (string, error) {
	respRaw, ok := raw["response"]
	if !ok {
		return "", fmt.Errorf("missing 'response' field")
	}
	var resp map[string]json.RawMessage
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}

	cdJRaw, ok := resp["clientDataJSON"]
	if !ok {
		return "", fmt.Errorf("missing 'response.clientDataJSON'")
	}

	var cdJBase64 string
	if err := json.Unmarshal(cdJRaw, &cdJBase64); err != nil {
		return "", fmt.Errorf("parse clientDataJSON string: %w", err)
	}

	cdJBytes, err := base64URLDecode(cdJBase64)
	if err != nil {
		return "", fmt.Errorf("decode clientDataJSON: %w", err)
	}

	var clientData struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(cdJBytes, &clientData); err != nil {
		return "", fmt.Errorf("parse clientData: %w", err)
	}
	if clientData.Challenge == "" {
		return "", fmt.Errorf("empty challenge")
	}
	return clientData.Challenge, nil
}

// base64URLDecode decodes a base64url string (with or without padding).
func base64URLDecode(s string) ([]byte, error) {
	// Normalise to standard base64 with padding.
	s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
	switch len(s) % 4 {
	case 2:
		s += "=="
	case 3:
		s += "="
	}
	return base64.StdEncoding.DecodeString(s)
}

// transportStrings converts the go-webauthn transport slice to []string for
// Postgres TEXT[] storage.
func transportStrings(ts []gowaprotocol.AuthenticatorTransport) []string {
	if len(ts) == 0 {
		return []string{}
	}
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = string(t)
	}
	return out
}

// aaguidToUUID converts a 16-byte AAGUID to a UUID string for Postgres, or
// returns nil if the slice is not exactly 16 bytes (zero AAGUID = no device metadata).
func aaguidToUUID(b []byte) any {
	if len(b) != 16 {
		return nil
	}
	return bytesToUUIDString(b)
}
