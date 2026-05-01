// Package jwtauth provides HMAC-SHA256 JWT validation for tinai-realtime.
package jwtauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
)

// secret is loaded from JWT_SECRET at package init.
var secret []byte

func init() {
	s := os.Getenv("JWT_SECRET")
	if s == "" {
		log.Println("WARNING: JWT_SECRET is not set — WebSocket JWT validation is DISABLED (dev mode only)")
	} else {
		secret = []byte(s)
	}
}

// DevMode reports whether JWT validation is disabled (JWT_SECRET unset).
func DevMode() bool { return len(secret) == 0 }

// ParseTenantID validates a raw JWT string and returns the tenant_id claim.
// In dev mode (no JWT_SECRET) it returns "dev-tenant" without validation.
func ParseTenantID(tokenStr string) (string, error) {
	if len(secret) == 0 {
		return "dev-tenant", nil
	}

	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return "", errors.New("jwt: token must have three parts")
	}

	// Verify HMAC-SHA256 signature.
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expectedSig), []byte(parts[2])) {
		return "", errors.New("jwt: signature verification failed")
	}

	// Decode payload.
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("jwt: invalid base64url payload: " + err.Error())
	}

	var claims map[string]any
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		return "", errors.New("jwt: invalid JSON payload: " + err.Error())
	}

	tenantID, ok := claims["tenant_id"].(string)
	if !ok || tenantID == "" {
		return "", errors.New("jwt: tenant_id claim missing or empty")
	}

	return tenantID, nil
}
