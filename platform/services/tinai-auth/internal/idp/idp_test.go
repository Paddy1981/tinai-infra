package idp

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testKeyPEM(t *testing.T) string {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(k),
	}))
}

func TestParseRSAPrivateKey(t *testing.T) {
	if _, err := parseRSAPrivateKey(testKeyPEM(t)); err != nil {
		t.Fatalf("PKCS1: %v", err)
	}
	if _, err := parseRSAPrivateKey("not a pem"); err == nil {
		t.Fatal("expected error for garbage input")
	}
}

func TestLoadClients(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "https://auth.test/oidc")
	cs, err := loadClients(`[{"id":"headscale","secret":"s3cr3t","redirect_uris":["https://trunk.test/cb"]}]`)
	if err != nil {
		t.Fatal(err)
	}
	c, ok := cs["headscale"]
	if !ok {
		t.Fatal("client not loaded")
	}
	if got := c.LoginURL("abc"); !strings.HasPrefix(got, "/oidc/login/username?authRequestID=abc") {
		t.Fatalf("LoginURL = %q", got)
	}
	if _, err := loadClients(`[{"id":"x"}]`); err == nil {
		t.Fatal("expected error: missing redirect_uris")
	}
}

// Mount must serve a valid discovery document with the configured issuer.
func TestMountDiscovery(t *testing.T) {
	t.Setenv("OIDC_SIGNING_KEY", testKeyPEM(t))
	t.Setenv("OIDC_ISSUER", "https://auth.test/oidc")
	t.Setenv("OIDC_IDP_CLIENTS", `[{"id":"headscale","secret":"s3cr3t","redirect_uris":["https://trunk.test/cb"]}]`)

	mux := http.NewServeMux()
	enabled, err := Mount(mux, nil, "jwt-seed", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Fatal("expected IdP enabled")
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/oidc/.well-known/openid-configuration", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("discovery status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`"issuer":"https://auth.test/oidc"`,
		`"authorization_endpoint":"https://auth.test/oidc/authorize"`,
		`"jwks_uri":"https://auth.test/oidc/keys"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("discovery missing %s\nbody: %s", want, body)
		}
	}
}

// MountDisabled: no signing key ⇒ not mounted, no routes added.
func TestMountDisabled(t *testing.T) {
	t.Setenv("OIDC_SIGNING_KEY", "")
	mux := http.NewServeMux()
	enabled, err := Mount(mux, nil, "jwt-seed", slog.Default())
	if err != nil || enabled {
		t.Fatalf("expected disabled, got enabled=%v err=%v", enabled, err)
	}
}
