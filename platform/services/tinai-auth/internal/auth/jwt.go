package auth

import (
	"fmt"
	"math"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims holds the JWT payload fields issued by tinai-auth.
// It embeds jwt.RegisteredClaims to handle standard fields (sub, exp, iat).
type Claims struct {
	Email    string `json:"email,omitempty"`
	Mobile   string `json:"mobile,omitempty"`
	Role     string `json:"role"`
	TenantID string `json:"tenant_id"`
	jwt.RegisteredClaims
}

// Sign creates a signed HS256 JWT from the given claims.
func Sign(claims Claims, secret string) string {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte(secret))
	return tokenString
}

// Verify validates an HS256 JWT and returns the decoded claims.
func Verify(tokenString, secret string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		// Ensure the signing method is HMAC (HS256)
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}
	return nil, fmt.Errorf("invalid token")
}

// NewClaims builds a Claims value stamped with the current time.
func NewClaims(sub, email, role, tenantID string, expirySeconds int64) Claims {
	now := time.Now()
	return Claims{
		Email:    email,
		Role:     role,
		TenantID: tenantID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(expirySeconds) * time.Second)),
		},
	}
}

// NewMobileClaims builds Claims for a mobile-OTP authenticated session.
// The Mobile field is populated instead of Email.
func NewMobileClaims(sub, mobile, role, tenantID string, expirySeconds int64) Claims {
	now := time.Now()
	return Claims{
		Mobile:   mobile,
		Role:     role,
		TenantID: tenantID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   sub,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(expirySeconds) * time.Second)),
		},
	}
}

// TimeUntilExpiry returns a human-readable string for when the token expires.
func TimeUntilExpiry(exp *jwt.NumericDate) string {
	if exp == nil {
		return "unknown"
	}
	d := time.Until(exp.Time)
	if d < 0 {
		return "expired"
	}
	hours := int(math.Ceil(d.Hours()))
	if hours >= 24 {
		return fmt.Sprintf("%d days", int(math.Ceil(float64(hours)/24.0)))
	}
	return fmt.Sprintf("%d hours", hours)
}
