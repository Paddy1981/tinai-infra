package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"
)

// JWTMiddleware validates Bearer tokens and injects the tenant claim into the request header.
func JWTMiddleware(next http.Handler) http.Handler {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		// JWT_SECRET not configured — reject all requests
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `{"error":"JWT_SECRET not configured — service unavailable"}`, http.StatusUnauthorized)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
			return
		}
		token := auth[7:]
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			http.Error(w, `{"error":"malformed token"}`, http.StatusUnauthorized)
			return
		}
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
			http.Error(w, `{"error":"invalid token signature"}`, http.StatusUnauthorized)
			return
		}
		payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			http.Error(w, `{"error":"invalid token payload"}`, http.StatusUnauthorized)
			return
		}
		var claims map[string]any
		if err := json.Unmarshal(payloadBytes, &claims); err != nil {
			http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
			return
		}
		if exp, ok := claims["exp"].(float64); ok && int64(exp) < time.Now().Unix() {
			http.Error(w, `{"error":"token expired"}`, http.StatusUnauthorized)
			return
		}
		// Extract tenant from "tenant" or "sub" claim
		tenant := ""
		if t, ok := claims["tenant"].(string); ok && t != "" {
			tenant = t
		} else if s, ok := claims["sub"].(string); ok {
			tenant = s
		}
		if tenant == "" {
			http.Error(w, `{"error":"token missing tenant claim"}`, http.StatusUnauthorized)
			return
		}
		// Inject validated tenant — overrides any X-Tenant-ID header from client
		r2 := r.Clone(r.Context())
		r2.Header.Set("X-Tenant-ID", tenant)
		next.ServeHTTP(w, r2)
	})
}
