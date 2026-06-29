package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestJWT(t *testing.T) {
	secret := "test-secret-123"
	sub := "user-123"
	email := "test@example.com"
	role := RolePlatformAdmin
	tenant := "tinai-test"
	expiry := int64(3600)

	// Test NewClaims and Sign
	claims := NewClaims(sub, email, role, tenant, expiry)
	token := Sign(claims, secret)
	if token == "" {
		t.Fatal("token should not be empty")
	}

	// Test Verify
	verified, err := Verify(token, secret)
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}

	if verified.Subject != sub {
		t.Errorf("expected sub %s, got %s", sub, verified.Subject)
	}
	if verified.Email != email {
		t.Errorf("expected email %s, got %s", email, verified.Email)
	}
	if verified.Role != role {
		t.Errorf("expected role %s, got %s", role, verified.Role)
	}

	// Test Expired Token
	expiredClaims := NewClaims(sub, email, role, tenant, -10)
	expiredToken := Sign(expiredClaims, secret)
	_, err = Verify(expiredToken, secret)
	if err == nil {
		t.Error("expected error for expired token, got nil")
	}

	// Test Invalid Secret
	_, err = Verify(token, "wrong-secret")
	if err == nil {
		t.Error("expected error for wrong secret, got nil")
	}
}

func TestNormalizeRole(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"admin", RolePlatformAdmin},
		{"tenant", RoleMember},
		{"platform_admin", RolePlatformAdmin},
		{"tenant_admin", RoleTenantAdmin},
		{"member", RoleMember},
		{"unknown", RoleMember},
		{"", RoleMember},
	}
	for _, tt := range tests {
		got := NormalizeRole(tt.input)
		if got != tt.expected {
			t.Errorf("NormalizeRole(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestTimeUntilExpiry(t *testing.T) {
	now := time.Now()
	
	// Test 2 hours
	exp2h := jwt.NewNumericDate(now.Add(2 * time.Hour))
	if res := TimeUntilExpiry(exp2h); res != "2 hours" {
		t.Errorf("expected '2 hours', got '%s'", res)
	}

	// Test 3 days
	exp3d := jwt.NewNumericDate(now.Add(72 * time.Hour))
	if res := TimeUntilExpiry(exp3d); res != "3 days" {
		t.Errorf("expected '3 days', got '%s'", res)
	}

	// Test expired
	expExp := jwt.NewNumericDate(now.Add(-1 * time.Hour))
	if res := TimeUntilExpiry(expExp); res != "expired" {
		t.Errorf("expected 'expired', got '%s'", res)
	}
}
