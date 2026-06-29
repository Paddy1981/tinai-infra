package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
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
	redis     *redis.Client
	// OnLogin is an optional callback invoked after each login attempt.
	// It is nil-safe.
	OnLogin LoginCallback
}

// NewHandler constructs a Handler wired to the given DB and config.
func NewHandler(db *sql.DB, cfg config.Config, mailer *email.Mailer) *Handler {
	return &Handler{db: db, cfg: cfg, smsClient: sms.NewClient(), mailer: mailer}
}

// SetRedis assigns a Redis client for token blacklisting.
func (h *Handler) SetRedis(rdb *redis.Client) {
	h.redis = rdb
}

// Register mounts all auth routes onto mux using Go 1.22 method+path patterns.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/register", h.register)
	mux.HandleFunc("POST /api/v1/auth/login", h.login)
	mux.HandleFunc("POST /api/v1/auth/magic-link", h.magicLink)
	mux.HandleFunc("POST /api/v1/auth/verify-magic-link", h.verifyMagicLink)
	mux.HandleFunc("POST /api/v1/auth/verify-email", h.verifyEmail)
	mux.HandleFunc("POST /api/v1/auth/resend-verification", h.resendVerification)
	mux.HandleFunc("POST /api/v1/auth/forgot-password", h.forgotPassword)
	mux.HandleFunc("POST /api/v1/auth/reset-password", h.resetPassword)
	mux.HandleFunc("GET /api/v1/auth/me", h.me)
	mux.HandleFunc("POST /api/v1/auth/logout", h.logout)
	mux.HandleFunc("GET /healthz", h.health)
	// SMS OTP routes
	mux.HandleFunc("POST /api/v1/auth/sms-otp", h.handleSMSOTP)
	mux.HandleFunc("POST /api/v1/auth/verify-sms", h.handleVerifySMS)
	mux.HandleFunc("POST /api/v1/auth/resend-sms", h.handleResendSMS)
	// Role management routes
	mux.HandleFunc("POST /api/v1/auth/invite", h.invite)
	mux.HandleFunc("PATCH /api/v1/auth/users/{id}/role", h.changeRole)
}

// reIndianMobile matches a 10-digit Indian mobile number starting with 6–9.
var reIndianMobile = regexp.MustCompile(`^[6-9]\d{9}$`)

// reEmail validates a basic email format: local@domain.tld
var reEmail = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// revokedTokenPrefix is the Redis key prefix for blacklisted JWT IDs.
const revokedTokenPrefix = "tinai:revoked_jti:"

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
	if !reEmail.MatchString(body.Email) {
		httpError(w, "invalid email format", http.StatusBadRequest)
		return
	}
	if body.Region == "" {
		body.Region = "IN"
	}
	if len(body.Password) < 8 {
		httpError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	// SECURITY: tenant_id is server-generated and unguessable. Any client-supplied
	// body.TenantID is deliberately ignored — registration ALWAYS creates a brand-new
	// tenant whose registrant becomes its tenant_admin. This prevents a caller from
	// joining (or seizing admin of) an existing tenant by guessing its id, which was a
	// cross-tenant data-access vulnerability. Joining an existing tenant is only possible
	// via an authenticated invite (see the invite handler). Mirrors tinai-api's randomUUID().
	tenantID := uuid.NewString()
	assignedRole := RoleTenantAdmin

	hash := HashPassword(body.Password)

	// Email verification token (consumed via /verify-email). New accounts start
	// unverified; login is not blocked, but the app can prompt for verification.
	verifyToken := generateJTI()
	verifyExpires := time.Now().Add(24 * time.Hour)

	var userID string
	err := h.db.QueryRowContext(r.Context(),
		`INSERT INTO users (email, password_hash, role, tenant_id, region, email_verified, verify_token, verify_expires)
		 VALUES ($1, $2, $3, $4, $5, false, $6, $7) RETURNING id`,
		body.Email, hash, assignedRole, tenantID, body.Region, verifyToken, verifyExpires,
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

	if h.mailer != nil {
		link := fmt.Sprintf("%s/verify-email?email=%s&token=%s",
			h.cfg.AppBaseURL, url.QueryEscape(body.Email), verifyToken)
		if err := h.mailer.SendVerificationEmail(r.Context(), body.Email, link, h.cfg.AppName); err != nil {
			log.Printf("failed to queue verification email to %s: %v", body.Email, err)
		}
	}

	claims := NewClaims(userID, body.Email, assignedRole, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token":          token,
		"user_id":        userID,
		"email":          body.Email,
		"role":           assignedRole,
		"tenant_id":      tenantID,
		"email_verified": false,
		"expires_in":     h.cfg.JWTExpirySec,
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
	if !reEmail.MatchString(body.Email) {
		httpError(w, "invalid email format", http.StatusBadRequest)
		return
	}

	var userID, passwordHash, role, tenantID string
	var emailVerified bool
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, password_hash, role, tenant_id, email_verified FROM users WHERE email=$1`,
		body.Email,
	).Scan(&userID, &passwordHash, &role, &tenantID, &emailVerified)
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

	// Normalize legacy roles to the new 3-tier model in the JWT
	normalizedRole := NormalizeRole(role)

	claims := NewClaims(userID, body.Email, normalizedRole, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token": token,
		"user": map[string]string{
			"id":        userID,
			"email":     body.Email,
			"role":      normalizedRole,
			"tenant_id": tenantID,
		},
		"email_verified": emailVerified,
		"expires_in":     h.cfg.JWTExpirySec,
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

	normalizedRole := NormalizeRole(role)
	claims := NewClaims(userID, body.Email, normalizedRole, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"token":   token,
		"user_id": userID,
	})
}

// verifyEmail consumes an email-verification token and marks the account verified.
func (h *Handler) verifyEmail(w http.ResponseWriter, r *http.Request) {
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

	var userID string
	err := h.db.QueryRowContext(r.Context(),
		`UPDATE users
		 SET email_verified=true, verify_token=NULL, verify_expires=NULL
		 WHERE email=$1 AND verify_token=$2 AND verify_expires > NOW()
		 RETURNING id`,
		body.Email, body.Token,
	).Scan(&userID)
	if err == sql.ErrNoRows {
		httpError(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	if err != nil {
		log.Printf("verify email: %v", err)
		httpError(w, "verification failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "email_verified": true})
}

// resendVerification re-issues a verification email when the account is still
// unverified. Always returns a generic response (no account-existence leak).
func (h *Handler) resendVerification(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
		httpError(w, "email required", http.StatusBadRequest)
		return
	}

	token := generateJTI()
	expires := time.Now().Add(24 * time.Hour)
	var email string
	err := h.db.QueryRowContext(r.Context(),
		`UPDATE users SET verify_token=$1, verify_expires=$2
		 WHERE email=$3 AND email_verified=false
		 RETURNING email`,
		token, expires, body.Email,
	).Scan(&email)
	if err == nil && h.mailer != nil {
		link := fmt.Sprintf("%s/verify-email?email=%s&token=%s",
			h.cfg.AppBaseURL, url.QueryEscape(email), token)
		if mErr := h.mailer.SendVerificationEmail(r.Context(), email, link, h.cfg.AppName); mErr != nil {
			log.Printf("failed to queue verification email to %s: %v", email, mErr)
		}
	} else if err != nil && err != sql.ErrNoRows {
		log.Printf("resend verification: %v", err)
	}

	writeJSON(w, map[string]any{"message": "If this email needs verification, a new link has been sent"})
}

// forgotPassword issues a password-reset link. Always returns a generic
// response to avoid email enumeration.
func (h *Handler) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
		httpError(w, "email required", http.StatusBadRequest)
		return
	}

	token := generateJTI()
	expires := time.Now().Add(1 * time.Hour)
	var email string
	err := h.db.QueryRowContext(r.Context(),
		`UPDATE users SET reset_token=$1, reset_expires=$2
		 WHERE email=$3
		 RETURNING email`,
		token, expires, body.Email,
	).Scan(&email)
	if err == nil && h.mailer != nil {
		link := fmt.Sprintf("%s/reset-password?email=%s&token=%s",
			h.cfg.AppBaseURL, url.QueryEscape(email), token)
		if mErr := h.mailer.SendPasswordReset(r.Context(), email, link, h.cfg.AppName); mErr != nil {
			log.Printf("failed to queue password reset to %s: %v", email, mErr)
		}
	} else if err != nil && err != sql.ErrNoRows {
		log.Printf("forgot password: %v", err)
	}

	writeJSON(w, map[string]any{"message": "If this email is registered, a reset link has been sent"})
}

// resetPassword consumes a reset token and sets a new password.
func (h *Handler) resetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email       string `json:"email"`
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Email == "" || body.Token == "" || body.NewPassword == "" {
		httpError(w, "email, token and new_password required", http.StatusBadRequest)
		return
	}
	if len(body.NewPassword) < 8 {
		httpError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	hash := HashPassword(body.NewPassword)
	var userID string
	err := h.db.QueryRowContext(r.Context(),
		`UPDATE users
		 SET password_hash=$1, reset_token=NULL, reset_expires=NULL
		 WHERE email=$2 AND reset_token=$3 AND reset_expires > NOW()
		 RETURNING id`,
		hash, body.Email, body.Token,
	).Scan(&userID)
	if err == sql.ErrNoRows {
		httpError(w, "invalid or expired token", http.StatusUnauthorized)
		return
	}
	if err != nil {
		log.Printf("reset password: %v", err)
		httpError(w, "reset failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// me returns the user profile encoded in the bearer token.
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	claims, err := h.extractClaims(r)
	if err != nil {
		httpError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Check token blacklist
	if h.IsTokenRevoked(claims.ID) {
		httpError(w, "token revoked", http.StatusUnauthorized)
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

// logout revokes the bearer token by adding its JTI to the Redis blacklist.
// If Redis is unavailable, logout still succeeds (client discards token).
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if h.redis != nil {
		claims, err := h.extractClaims(r)
		if err == nil && claims.ID != "" {
			// TTL = remaining token validity so blacklist entries auto-expire
			ttl := time.Until(claims.ExpiresAt.Time)
			if ttl > 0 {
				key := revokedTokenPrefix + claims.ID
				h.redis.Set(context.Background(), key, "1", ttl) //nolint:errcheck
			}
		}
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// IsTokenRevoked checks whether a token's JTI has been blacklisted in Redis.
// Returns false if Redis is not configured or on error (fail-open for availability).
func (h *Handler) IsTokenRevoked(jti string) bool {
	if h.redis == nil || jti == "" {
		return false
	}
	val, err := h.redis.Exists(context.Background(), revokedTokenPrefix+jti).Result()
	if err != nil {
		return false
	}
	return val > 0
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
	var userID, tenantID string
	err = h.db.QueryRowContext(r.Context(),
		`SELECT id, tenant_id FROM users WHERE mobile=$1`, fullMobile,
	).Scan(&userID, &tenantID)

	if err == sql.ErrNoRows {
		// Auto-create account keyed on the mobile number, in its own dedicated
		// tenant (full isolation), registrant becomes tenant_admin — mirrors the
		// password-register path. The DB mints the tenant_id.
		err = h.db.QueryRowContext(r.Context(),
			`INSERT INTO users (role, tenant_id, region, mobile, mobile_verified)
			 VALUES ('tenant_admin', gen_random_uuid()::text, 'IN', $1, true)
			 RETURNING id, tenant_id`,
			fullMobile,
		).Scan(&userID, &tenantID)
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

	// Fetch the actual role from the DB (may have been migrated)
	var userRole string
	if err := h.db.QueryRowContext(r.Context(),
		`SELECT role FROM users WHERE id=$1`, userID,
	).Scan(&userRole); err != nil {
		userRole = RoleMember
	}
	normalizedRole := NormalizeRole(userRole)

	claims := NewMobileClaims(userID, fullMobile, normalizedRole, tenantID, h.cfg.JWTExpirySec)
	token := Sign(claims, h.cfg.JWTSecret)
	writeJSON(w, map[string]any{
		"ok":    true,
		"token": token,
		"user": map[string]string{
			"id":     userID,
			"mobile": fullMobile,
			"role":   normalizedRole,
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

// invite allows a tenant_admin (or platform_admin) to create a new user in their tenant.
// POST /api/v1/auth/invite — accepts email and role (member or tenant_admin).
func (h *Handler) invite(w http.ResponseWriter, r *http.Request) {
	claims, err := h.extractClaims(r)
	if err != nil {
		httpError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if h.IsTokenRevoked(claims.ID) {
		httpError(w, "token revoked", http.StatusUnauthorized)
		return
	}

	// Only tenant_admin or platform_admin can invite
	callerRole := NormalizeRole(claims.Role)
	if callerRole != RoleTenantAdmin && callerRole != RolePlatformAdmin {
		httpError(w, "forbidden: only tenant_admin or platform_admin can invite users", http.StatusForbidden)
		return
	}

	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Email == "" {
		httpError(w, "email required", http.StatusBadRequest)
		return
	}
	if !reEmail.MatchString(body.Email) {
		httpError(w, "invalid email format", http.StatusBadRequest)
		return
	}

	// Validate requested role — only member or tenant_admin allowed via invite
	if body.Role == "" {
		body.Role = RoleMember
	}
	if body.Role != RoleMember && body.Role != RoleTenantAdmin {
		httpError(w, "role must be 'member' or 'tenant_admin'", http.StatusBadRequest)
		return
	}
	// Only platform_admin can invite another tenant_admin
	if body.Role == RoleTenantAdmin && callerRole != RolePlatformAdmin && callerRole != RoleTenantAdmin {
		httpError(w, "insufficient permissions to assign tenant_admin", http.StatusForbidden)
		return
	}

	// Create user in the same tenant as the caller with a random temporary password
	tempPassword := generateJTI() // random 32-char hex
	hash := HashPassword(tempPassword)

	var userID string
	err = h.db.QueryRowContext(r.Context(),
		`INSERT INTO users (email, password_hash, role, tenant_id, region)
		 VALUES ($1, $2, $3, $4, 'IN') RETURNING id`,
		body.Email, hash, body.Role, claims.TenantID,
	).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
			httpError(w, "email already registered", http.StatusConflict)
			return
		}
		log.Printf("invite: %v", err)
		httpError(w, "invite failed", http.StatusInternalServerError)
		return
	}

	// In production, send an invite email with a magic link or password reset.
	// For now, return the user ID.
	writeJSON(w, map[string]any{
		"ok":        true,
		"user_id":   userID,
		"email":     body.Email,
		"role":      body.Role,
		"tenant_id": claims.TenantID,
	})
}

// changeRole allows tenant_admin to promote/demote users within their tenant,
// or platform_admin to change any user's role.
// PATCH /api/v1/auth/users/{id}/role
func (h *Handler) changeRole(w http.ResponseWriter, r *http.Request) {
	claims, err := h.extractClaims(r)
	if err != nil {
		httpError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if h.IsTokenRevoked(claims.ID) {
		httpError(w, "token revoked", http.StatusUnauthorized)
		return
	}

	callerRole := NormalizeRole(claims.Role)
	if callerRole != RoleTenantAdmin && callerRole != RolePlatformAdmin {
		httpError(w, "forbidden: only tenant_admin or platform_admin can change roles", http.StatusForbidden)
		return
	}

	targetUserID := r.PathValue("id")
	if targetUserID == "" {
		httpError(w, "user id required", http.StatusBadRequest)
		return
	}

	var body struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if !ValidRoles[body.Role] {
		httpError(w, "invalid role: must be platform_admin, tenant_admin, or member", http.StatusBadRequest)
		return
	}

	// Only platform_admin can assign platform_admin role
	if body.Role == RolePlatformAdmin && callerRole != RolePlatformAdmin {
		httpError(w, "forbidden: only platform_admin can assign platform_admin role", http.StatusForbidden)
		return
	}

	// Fetch target user to verify tenant ownership
	var targetTenantID, targetCurrentRole string
	err = h.db.QueryRowContext(r.Context(),
		`SELECT tenant_id, role FROM users WHERE id=$1`, targetUserID,
	).Scan(&targetTenantID, &targetCurrentRole)
	if err == sql.ErrNoRows {
		httpError(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Printf("changeRole lookup: %v", err)
		httpError(w, "lookup failed", http.StatusInternalServerError)
		return
	}

	// tenant_admin can only modify users in their own tenant
	if callerRole == RoleTenantAdmin && targetTenantID != claims.TenantID {
		httpError(w, "forbidden: cannot modify users outside your tenant", http.StatusForbidden)
		return
	}

	// tenant_admin cannot demote another tenant_admin (only platform_admin can)
	if callerRole == RoleTenantAdmin && NormalizeRole(targetCurrentRole) == RoleTenantAdmin && body.Role != RoleTenantAdmin {
		httpError(w, "forbidden: tenant_admin cannot demote another tenant_admin", http.StatusForbidden)
		return
	}

	// Perform the update
	_, err = h.db.ExecContext(r.Context(),
		`UPDATE users SET role=$1 WHERE id=$2`, body.Role, targetUserID,
	)
	if err != nil {
		log.Printf("changeRole update: %v", err)
		httpError(w, "role update failed", http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"ok":       true,
		"user_id":  targetUserID,
		"old_role": NormalizeRole(targetCurrentRole),
		"new_role": body.Role,
	})
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
