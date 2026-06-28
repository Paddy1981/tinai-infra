package idp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"tinai.cloud/auth/internal/auth"
)

// fakeUsers is an in-memory userLookup for the flow test.
type fakeUsers struct {
	id, email, hash, role, tenant string
	verified                      bool
}

func (f fakeUsers) byID(_ context.Context, id string) (string, string, string, bool, error) {
	if id != f.id {
		return "", "", "", false, errors.New("not found")
	}
	return f.role, f.tenant, f.email, f.verified, nil
}
func (f fakeUsers) byEmail(_ context.Context, email string) (string, string, bool, error) {
	if email != f.email {
		return "", "", false, errors.New("not found")
	}
	return f.id, f.hash, f.verified, nil
}
func (f fakeUsers) ping(context.Context) error { return nil }

// TestAuthCodeFlowEndToEnd drives a full PKCE authorization-code flow against an
// in-process IdP and verifies the signed id_token + userinfo carry role/tenant_id.
func TestAuthCodeFlowEndToEnd(t *testing.T) {
	users := fakeUsers{
		id: "user-uuid-1", email: "alice@acme.test", hash: auth.HashPassword("correct-horse"),
		role: "member", tenant: "acme", verified: true,
	}

	const issuer = "https://auth.tinai.cloud/oidc"
	t.Setenv("OIDC_SIGNING_KEY", testKeyPEM(t))
	t.Setenv("OIDC_ISSUER", issuer)
	t.Setenv("OIDC_IDP_CLIENTS", `[{"id":"e2e-test","secret":"","redirect_uris":["http://localhost:8765/callback"]}]`)

	mux := http.NewServeMux()
	if _, err := mountWith(mux, users, "seed", slog.Default()); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Jar:           jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	// get rewrites absolute issuer-host URLs back onto the test server.
	rebase := func(loc string) string {
		if u, err := url.Parse(loc); err == nil && (u.Host == "auth.tinai.cloud" || u.Host == "") {
			return srv.URL + u.Path + "?" + u.RawQuery
		}
		return loc
	}

	// PKCE
	verifier := "this-is-a-sufficiently-long-pkce-code-verifier-1234567890"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	// 1) /authorize -> 302 to login
	authQ := url.Values{
		"client_id": {"e2e-test"}, "redirect_uri": {"http://localhost:8765/callback"},
		"response_type": {"code"}, "scope": {"openid email profile"},
		"state": {"st-123"}, "nonce": {"nonce-abc"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"},
	}
	resp := mustGet(t, client, srv.URL+"/oidc/authorize?"+authQ.Encode())
	loc := resp.Header.Get("Location")
	if resp.StatusCode != http.StatusFound || !strings.Contains(loc, "/oidc/login/username") {
		t.Fatalf("authorize: status=%d loc=%q", resp.StatusCode, loc)
	}
	reqID := mustParam(t, loc, "authRequestID")

	// 2) POST login -> 302 to auth callback
	form := url.Values{"id": {reqID}, "username": {users.email}, "password": {"correct-horse"}}
	resp = mustPostForm(t, client, srv.URL+"/oidc/login/username", form)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("login: status=%d body=%s", resp.StatusCode, readBody(resp))
	}

	// 3) follow auth callback -> 302 to client redirect_uri with code
	resp = mustGet(t, client, rebase(resp.Header.Get("Location")))
	loc = resp.Header.Get("Location")
	if resp.StatusCode != http.StatusFound || !strings.HasPrefix(loc, "http://localhost:8765/callback") {
		t.Fatalf("callback: status=%d loc=%q body=%s", resp.StatusCode, loc, readBody(resp))
	}
	if got := mustParam(t, loc, "state"); got != "st-123" {
		t.Fatalf("state mismatch: %q", got)
	}
	code := mustParam(t, loc, "code")

	// 4) exchange code at /oauth/token (PKCE, public client)
	tok := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {"http://localhost:8765/callback"},
		"client_id":    {"e2e-test"}, "code_verifier": {verifier},
	}
	resp = mustPostForm(t, client, srv.URL+"/oidc/oauth/token", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("token: status=%d body=%s", resp.StatusCode, readBody(resp))
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal([]byte(readBody(resp)), &tr); err != nil {
		t.Fatal(err)
	}
	if tr.IDToken == "" || tr.AccessToken == "" {
		t.Fatalf("missing tokens: %+v", tr)
	}

	// 5) verify id_token signature (against JWKS) + claims
	claims := verifyIDToken(t, srv.URL, tr.IDToken)
	assertEq(t, "iss", claims["iss"], issuer)
	assertEq(t, "sub", claims["sub"], "user-uuid-1")
	assertEq(t, "nonce", claims["nonce"], "nonce-abc")
	assertEq(t, "role", claims["role"], "member")
	assertEq(t, "tenant_id", claims["tenant_id"], "acme")
	if aud, _ := claims["aud"].([]any); len(aud) != 1 || aud[0] != "e2e-test" {
		t.Fatalf("aud = %v", claims["aud"])
	}

	// 6) userinfo with the access token
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/oidc/userinfo", nil)
	req.Header.Set("Authorization", "Bearer "+tr.AccessToken)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("userinfo: status=%d body=%s", resp.StatusCode, readBody(resp))
	}
	var ui map[string]any
	json.Unmarshal([]byte(readBody(resp)), &ui)
	assertEq(t, "userinfo.sub", ui["sub"], "user-uuid-1")
	assertEq(t, "userinfo.email", ui["email"], "alice@acme.test")
	assertEq(t, "userinfo.role", ui["role"], "member")
	assertEq(t, "userinfo.tenant_id", ui["tenant_id"], "acme")

	// wrong password must be rejected
	bad := url.Values{"id": {reqID}, "username": {users.email}, "password": {"wrong"}}
	resp = mustPostForm(t, client, srv.URL+"/oidc/login/username", bad)
	if strings.Contains(readBody(resp), "code=") {
		t.Fatal("wrong password should not yield a code")
	}
}

// --- helpers ---

func verifyIDToken(t *testing.T, base, raw string) map[string]any {
	t.Helper()
	resp, err := http.Get(base + "/oidc/keys")
	if err != nil {
		t.Fatal(err)
	}
	var jwks jose.JSONWebKeySet
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	tok, err := jwt.ParseSigned(raw, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		t.Fatalf("parse id_token: %v", err)
	}
	if len(jwks.Keys) == 0 {
		t.Fatal("empty JWKS")
	}
	var claims map[string]any
	if err := tok.Claims(jwks.Keys[0].Key, &claims); err != nil {
		t.Fatalf("id_token signature/claims invalid: %v", err)
	}
	return claims
}

func mustGet(t *testing.T, c *http.Client, u string) *http.Response {
	t.Helper()
	r, err := c.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mustPostForm(t *testing.T, c *http.Client, u string, v url.Values) *http.Response {
	t.Helper()
	r, err := c.PostForm(u, v)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mustParam(t *testing.T, rawurl, key string) string {
	t.Helper()
	u, err := url.Parse(rawurl)
	if err != nil {
		t.Fatal(err)
	}
	val := u.Query().Get(key)
	if val == "" {
		t.Fatalf("missing %q in %s", key, rawurl)
	}
	return val
}

func readBody(r *http.Response) string {
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	return string(b)
}

func assertEq(t *testing.T, name string, got any, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}
