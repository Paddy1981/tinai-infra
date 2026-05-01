package auth

import (
	"crypto/rand"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

const (
	pbkdf2Iter   = 100000
	pbkdf2KeyLen = 64
)

// HashPassword creates a PBKDF2-SHA512 hash with a random 16-byte salt.
// The stored format is: pbkdf2:<saltHex>:<hashHex>
func HashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt) //nolint:errcheck — crypto/rand.Read never returns an error on supported platforms
	saltHex := hex.EncodeToString(salt)
	hash := pbkdf2.Key([]byte(password), salt, pbkdf2Iter, pbkdf2KeyLen, sha512.New)
	return fmt.Sprintf("pbkdf2:%s:%s", saltHex, hex.EncodeToString(hash))
}

// VerifyPassword checks a plaintext password against a stored PBKDF2 hash.
func VerifyPassword(password, stored string) bool {
	parts := strings.SplitN(stored, ":", 3)
	if len(parts) != 3 || parts[0] != "pbkdf2" {
		return false
	}
	salt, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	hash := pbkdf2.Key([]byte(password), salt, pbkdf2Iter, pbkdf2KeyLen, sha512.New)
	return constantTimeEqual(hash, expected)
}

// GenerateOTP generates a 6-character alphanumeric one-time password.
func GenerateOTP() string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 6)
	rand.Read(b) //nolint:errcheck
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}

// constantTimeEqual compares two byte slices in constant time.
func constantTimeEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}
