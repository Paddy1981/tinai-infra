package auth

import (
	"testing"
)

func TestPassword(t *testing.T) {
	pass := "super-secret-password-123"
	
	// Test Hash and Verify
	hash := HashPassword(pass)
	if hash == "" {
		t.Fatal("hash should not be empty")
	}

	if !VerifyPassword(pass, hash) {
		t.Error("VerifyPassword failed with correct password")
	}

	if VerifyPassword("wrong-password", hash) {
		t.Error("VerifyPassword succeeded with wrong password")
	}

	// Test OTP Generation
	otp1 := GenerateOTP()
	otp2 := GenerateOTP()
	
	if len(otp1) != 6 {
		t.Errorf("expected OTP length 6, got %d", len(otp1))
	}
	
	if otp1 == otp2 {
		t.Error("OTPs should be unique (random)")
	}
}
