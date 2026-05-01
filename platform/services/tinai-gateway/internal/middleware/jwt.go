// Package middleware provides HTTP middleware for the Tinai AI Gateway.
package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// jwtSecret is loaded once at package init from the JWT_SECRET env var.
// A missing or empty JWT_SECRET is a fatal misconfiguration — the process
// exits immediately rather than silently running without authentication.
var jwtSecret []byte

func init() {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		log.Fatal("FATAL: JWT_SECRET environment variable is not set — refusing to start without authentication")
	}
	jwtSecret = []byte(secret)
}

// RequireJWT is HTTP middleware that validates an HMAC-SHA256 signed JWT from
// the Authorization header, extracts the tenant_id claim, and overwrites the
// X-Tenant-ID request header with the validated value so downstream handlers
// can trust it.
//
// Unauthenticated or expired requests receive HTTP 401.
func RequireJWT(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			jsonUnauthorized(w, "missing or malformed Authorization header")
			return
		}
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		tenantID, err := validateToken(tokenStr)
		if err != nil {
			log.Printf("jwt validation failed: %v", err)
			if _, expired := err.(*jwtExpiredError); expired {
				jsonUnauthorized(w, "token expired")
			} else {
				jsonUnauthorized(w, "invalid token")
			}
			return
		}

		// Overwrite any client-supplied X-Tenant-ID with the validated claim.
		r.Header.Set("X-Tenant-ID", tenantID)
		next.ServeHTTP(w, r)
	})
}

// validateToken parses and verifies a JWT with HMAC-SHA256.
// Returns the tenant_id claim on success, or an error.
func validateToken(tokenStr string) (string, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return "", &jwtError{"token does not have three parts"}
	}

	// Verify signature: HMAC-SHA256(base64url(header) + "." + base64url(payload))
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, jwtSecret)
	mac.Write([]byte(signingInput))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expectedSig), []byte(parts[2])) {
		return "", &jwtError{"signature verification failed"}
	}

	// Decode the payload (base64url, no padding).
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", &jwtError{"invalid base64url payload: " + err.Error()}
	}

	var claims map[string]any
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		return "", &jwtError{"invalid JSON payload: " + err.Error()}
	}

	// Enforce the exp (expiry) claim. JSON numbers unmarshal as float64.
	expRaw, hasExp := claims["exp"]
	if !hasExp {
		return "", &jwtError{"exp claim missing"}
	}
	expFloat, ok := expRaw.(float64)
	if !ok {
		return "", &jwtError{fmt.Sprintf("exp claim has unexpected type %T", expRaw)}
	}
	if time.Now().Unix() > int64(expFloat) {
		return "", &jwtExpiredError{}
	}

	tenantID, ok := claims["tenant_id"].(string)
	if !ok || tenantID == "" {
		return "", &jwtError{"tenant_id claim missing or empty"}
	}

	return tenantID, nil
}

// ParseTokenTenantID is exported so the WebSocket handler and other callers
// can validate a raw token string directly (without going through HTTP middleware).
// Returns the tenant_id claim or an error.
func ParseTokenTenantID(tokenStr string) (string, error) {
	return validateToken(tokenStr)
}

// jwtError is a simple error type for JWT failures.
type jwtError struct{ msg string }

func (e *jwtError) Error() string { return "jwt: " + e.msg }

// jwtExpiredError is returned specifically when the exp claim is in the past,
// so callers can distinguish expiry from other validation failures.
type jwtExpiredError struct{}

func (e *jwtExpiredError) Error() string { return "jwt: token has expired" }

// jsonUnauthorized writes a JSON 401 response.
func jsonUnauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":"` + msg + `"}`))
}
