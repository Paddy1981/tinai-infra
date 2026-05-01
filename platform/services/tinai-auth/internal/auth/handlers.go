package auth

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"tinai.cloud/auth/internal/config"
	"tinai.cloud/auth/internal/email"
	"tinai.cloud/auth/internal/sms"
)

// LoginCallback is invoked after each login attempt to drive Prometheus counters.
// method: "password", "magic_link", or "sms_otp". status: "success" or "failure".
type LoginCallback func(method, status string)

// Handler holds the shared dependencies for all auth HTTP handlers.
type Handler struct {
	db        *sql.DB
	cfg       config.Config
	smsClient *sms.Client
	mailer    *email.Mailer
	// OnLogin is an optional callback invoked after each login attempt.
	// It is nil-safe.
	OnLogin LoginCallback
}

// NewHandler constructs a Handler wired to the given DB and config.
func NewHandler(db *sql.DB, cfg config.Config, mailer *email.Mailer) *Handler {
	return &Handler{db: db, cfg: cfg, smsClient: sms.NewClient(), mailer: mailer}
}

// Register mounts all auth routes onto mux using Go 1.22 method+path patterns.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/register", h.register)
	mux.HandleFunc("POST /api/v1/auth/login", h.login)
	mux.HandleFunc("POST /api/v1/auth/magic-link", h.magicLink)
	mux.HandleFunc("POST /api/v1/auth/verify-magic-link", h.verifyMagicLink)
	mux.HandleFunc("GET /api/v1/auth/me", h.me)
	mux.HandleFunc("POST /api/v1/auth/logout", h.logout)
	mux.HandleFunc("GET /healthz", h.health)
	// SMS OTP routes
	mux.HandleFunc("POST /api/v1/auth/sms-otp", h.handleSMSOTP)
	mux.HandleFunc("POST /api/v1/auth/verify-sms", h.handleVerifySMS)
	mux.HandleFunc("POST /api/v1/auth/resend-sms", h.handleResendSMS)
}

// reIndianMobile matches a 10-digit Indian mobile number starting with 6–9.
var reIndianMobile = regexp.MustCompile(`^[6-9]\d{9}$`)

// health returns a simple liveness response.
func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"status": "ok", "service": "tinai-auth"})
}

// register creates a new user account and returns a signed JWT.
func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TenantID string `json:"tenant_id"`
		Region   string `json:"region"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Email == "" || body.Password == "" {
		httpError(w, "email and password required", http.StatusBadRequest)
		return
	}
	if body.TenantID == "" {
		body.TenantID = "tinai-admin"
	}
	if body.Region == "" {
		body.Region = "IN"
	}
	if len(body.Password) < 8 {
		httpError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	hash := HashPassword(body.Password)
	var userID string
	err := h.db.QueryRowContext(r.Context(),
		`INSERT INTO users (email, password_hash, role, tenant_id, region)
		 VALUES ($1, $2, 'tenant', $3, $4) RETURNING id`,
		body.Email, hash, body.TenantID, body.Region,
	).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
			httpError(w, "email already registered", http.StatusConflict)
			return
		}
		log.Printf("register: %v", err)
		httpError(w, "registration failed", http.StatusInternalServerError)
		return
	}

	claims := NewClaims(userID, body.Email, "tenant", body.TenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token":      token,
		"user_id":    userID,
		"email":      body.Email,
		"expires_in": h.cfg.JWTExpirySec,
	})
}

// login authenticates an existing user by email + password and returns a JWT.
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Email == "" || body.Password == "" {
		httpError(w, "email and password required", http.StatusBadRequest)
		return
	}

	var userID, passwordHash, role, tenantID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, password_hash, role, tenant_id FROM users WHERE email=$1`,
		body.Email,
	).Scan(&userID, &passwordHash, &role, &tenantID)
	if err == sql.ErrNoRows {
		if h.OnLogin != nil {
			h.OnLogin("password", "failure")
		}
		httpError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if err != nil {
		log.Printf("login query: %v", err)
		if h.OnLogin != nil {
			h.OnLogin("password", "failure")
		}
		httpError(w, "login failed", http.StatusInternalServerError)
		return
	}

	if !VerifyPassword(body.Password, passwordHash) {
		if h.OnLogin != nil {
			h.OnLogin("password", "failure")
		}
		httpError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if h.OnLogin != nil {
		h.OnLogin("password", "success")
	}

	// Best-effort last_login update — ignore error
	h.db.ExecContext(r.Context(), `UPDATE users SET last_login=NOW() WHERE id=$1`, userID) //nolint:errcheck

	claims := NewClaims(userID, body.Email, role, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token": token,
		"user": map[string]string{
			"id":        userID,
			"email":     body.Email,
			"role":      role,
			"tenant_id": tenantID,
		},
		"expires_in": h.cfg.JWTExpirySec,
	})
}

// magicLink generates an OTP, stores it, and (in dev mode) returns it directly.
// In production a real email delivery integration should replace the stub.
func (h *Handler) magicLink(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
		httpError(w, "email required", http.StatusBadRequest)
		return
	}

	otp := GenerateOTP()
	expires := time.Now().Add(15 * time.Minute)

	_, err := h.db.ExecContext(r.Context(),
		`UPDATE users SET magic_token=$1, magic_expires=$2 WHERE email=$3`,
		otp, expires, body.Email,
	)
	if err != nil {
		log.Printf("magic link store: %v", err)
		httpError(w, "failed to generate magic link", http.StatusInternalServerError)
		return
	}

	if h.mailer != nil {
		if err := h.mailer.SendMagicLink(r.Context(), body.Email, otp, h.cfg.AppName); err != nil {
			log.Printf("failed to queue magic link to %s: %v", body.Email, err)
		}
	}

	resp := map[string]any{
		"message": "If this email is registered, a magic link has been sent",
	}
	writeJSON(w, resp)
}

// verifyMagicLink validates an OTP and issues a JWT on success.
func (h *Handler) verifyMagicLink(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Email == "" || body.Token == "" {
		httpError(w, "email and token required", http.StatusBadRequest)
		return
	}

	// Atomically consume the token in a single UPDATE: validates email, token,
	// and expiry in one statement, then clears the token to prevent replay.
	// This eliminates the TOCTOU race that existed with a separate SELECT+UPDATE.
	var userID, role, tenantID string
	err := h.db.QueryRowContext(r.Context(),
		`UPDATE users
		 SET magic_token=NULL, magic_expires=NULL, last_login=NOW()
		 WHERE email=$1 AND magic_token=$2 AND magic_expires > NOW()
		 RETURNING id, role, tenant_id`,
		body.Email, body.Token,
	).Scan(&userID, &role, &tenantID)

	if err == sql.ErrNoRows {
		if h.OnLogin != nil {
			h.OnLogin("magic_link", "failure")
		}
		httpError(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	if err != nil {
		log.Printf("verify magic link: %v", err)
		if h.OnLogin != nil {
			h.OnLogin("magic_link", "failure")
		}
		httpError(w, "verification failed", http.StatusInternalServerError)
		return
	}

	if h.OnLogin != nil {
		h.OnLogin("magic_link", "success")
	}

	claims := NewClaims(userID, body.Email, role, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token":   token,
		"user_id": userID,
	})
}

// me returns the user profile encoded in the bearer token.
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	claims, err := h.extractClaims(r)
	if err != nil {
		httpError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, map[string]any{
		"id":            claims.Subject,
		"email":         claims.Email,
		"role":          claims.Role,
		"tenant_id":     claims.TenantID,
		"token_expires": TimeUntilExpiry(claims.ExpiresAt),
	})
}

// logout is a no-op for stateless JWTs; the client is responsible for
// discarding the token. The endpoint exists for API symmetry.
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
}

// extractClaims parses and verifies the Bearer token from the Authorization header.
func (h *Handler) extractClaims(r *http.Request) (*Claims, error) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return nil, fmt.Errorf("no bearer token")
	}
	return Verify(strings.TrimPrefix(authHeader, "Bearer "), h.cfg.JWTSecret)
}

// handleSMSOTP accepts a 10-digit Indian mobile number, sends a 6-digit OTP
// via Msg91, and records the request in sms_otp_requests.
func (h *Handler) handleSMSOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mobile string `json:"mobile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	mobile := strings.TrimSpace(body.Mobile)
	if !reIndianMobile.MatchString(mobile) {
		httpError(w, "mobile must be a 10-digit Indian number starting with 6-9", http.StatusBadRequest)
		return
	}

	if !h.smsClient.Enabled() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"error": "SMS not configured",
			"hint":  "set MSG91_AUTH_KEY",
		})
		return
	}

	fullMobile := "91" + mobile
	if err := h.smsClient.SendOTP(r.Context(), fullMobile); err != nil {
		log.Printf("sms-otp send: %v", err)
		httpError(w, "failed to send OTP", http.StatusBadGateway)
		return
	}

	_, err := h.db.ExecContext(r.Context(), `
		INSERT INTO sms_otp_requests (mobile, sent_at, expires_at, attempt_count)
		VALUES ($1, NOW(), NOW() + interval '10 minutes', 1)
		ON CONFLICT (mobile) DO UPDATE
		  SET sent_at       = NOW(),
		      expires_at    = NOW() + interval '10 minutes',
		      attempt_count = sms_otp_requests.attempt_count + 1`,
		fullMobile,
	)
	if err != nil {
		// Non-fatal — OTP is already sent; log and continue.
		log.Printf("sms-otp db upsert: %v", err)
	}

	writeJSON(w, map[string]any{"ok": true, "expires_in": 600})
}

// handleVerifySMS verifies the OTP entered by the user, auto-creates an
// account if necessary, and issues a JWT on success.
func (h *Handler) handleVerifySMS(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mobile string `json:"mobile"`
		OTP    string `json:"otp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	mobile := strings.TrimSpace(body.Mobile)
	otp := strings.TrimSpace(body.OTP)
	if !reIndianMobile.MatchString(mobile) {
		httpError(w, "invalid mobile number", http.StatusBadRequest)
		return
	}
	if otp == "" {
		httpError(w, "otp required", http.StatusBadRequest)
		return
	}

	fullMobile := "91" + mobile
	ok, err := h.smsClient.VerifyOTP(r.Context(), fullMobile, otp)
	if err != nil {
		log.Printf("verify-sms: %v", err)
		if h.OnLogin != nil {
			h.OnLogin("sms_otp", "failure")
		}
		httpError(w, "OTP verification failed", http.StatusBadGateway)
		return
	}
	if !ok {
		if h.OnLogin != nil {
			h.OnLogin("sms_otp", "failure")
		}
		httpError(w, "invalid or expired OTP", http.StatusUnauthorized)
		return
	}

	// Look up or create a user keyed on mobile number.
	var userID string
	err = h.db.QueryRowContext(r.Context(),
		`SELECT id FROM users WHERE mobile=$1`, fullMobile,
	).Scan(&userID)

	if err == sql.ErrNoRows {
		// Auto-create account: use the mobile number as the primary identifier.
		// email and password_hash are now nullable (Finding TINAI-H32).
		err = h.db.QueryRowContext(r.Context(),
			`INSERT INTO users (role, tenant_id, region, mobile, mobile_verified)
			 VALUES ('tenant', 'tinai-admin', 'IN', $1, true)
			 RETURNING id`,
			fullMobile,
		).Scan(&userID)
		if err != nil {
			log.Printf("verify-sms create user: %v", err)
			httpError(w, "account creation failed", http.StatusInternalServerError)
			return
		}
	} else if err != nil {
		log.Printf("verify-sms lookup user: %v", err)
		httpError(w, "lookup failed", http.StatusInternalServerError)
		return
	} else {
		// Mark mobile_verified on existing accounts and stamp last_login.
		h.db.ExecContext(r.Context(), //nolint:errcheck
			`UPDATE users SET mobile_verified=true, last_login=NOW() WHERE id=$1`, userID)
	}

	if h.OnLogin != nil {
		h.OnLogin("sms_otp", "success")
	}

	claims := NewMobileClaims(userID, fullMobile, "tenant", "tinai-admin", h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"ok":    true,
		"token": token,
		"user": map[string]string{
			"id":     userID,
			"mobile": fullMobile,
		},
	})
}

// handleResendSMS rate-limits resend attempts (minimum 60 s between sends)
// then triggers a voice-call fallback via Msg91.
func (h *Handler) handleResendSMS(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mobile string `json:"mobile"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	mobile := strings.TrimSpace(body.Mobile)
	if !reIndianMobile.MatchString(mobile) {
		httpError(w, "invalid mobile number", http.StatusBadRequest)
		return
	}

	if !h.smsClient.Enabled() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"error": "SMS not configured",
			"hint":  "set MSG91_AUTH_KEY",
		})
		return
	}

	fullMobile := "91" + mobile

	// Rate-limit: reject if the last send was fewer than 60 seconds ago.
	var sentAt time.Time
	err := h.db.QueryRowContext(r.Context(),
		`SELECT sent_at FROM sms_otp_requests WHERE mobile=$1`, fullMobile,
	).Scan(&sentAt)
	if err == nil && time.Since(sentAt) < 60*time.Second {
		httpError(w, "please wait 60 seconds before resending", http.StatusTooManyRequests)
		return
	}

	if err := h.smsClient.ResendOTP(r.Context(), fullMobile); err != nil {
		log.Printf("resend-sms: %v", err)
		httpError(w, "resend failed", http.StatusBadGateway)
		return
	}

	// Update the sent_at timestamp so the rate limiter resets.
	h.db.ExecContext(r.Context(), //nolint:errcheck
		`UPDATE sms_otp_requests SET sent_at=NOW() WHERE mobile=$1`, fullMobile)

	writeJSON(w, map[string]bool{"ok": true})
}

// writeJSON serialises v as JSON with the correct Content-Type header.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// httpError writes a JSON error body and sets the given HTTP status code.
func httpError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint:errcheck
}
