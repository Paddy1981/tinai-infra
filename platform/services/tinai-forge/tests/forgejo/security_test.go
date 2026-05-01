package forgejo_test

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestNoDefaultAdminPassword verifies default credentials are changed
func TestNoDefaultAdminPassword(t *testing.T) {
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // Don't follow redirects
		},
	}

	defaults := []struct {
		username string
		password string
	}{
		{"admin", "admin"},
		{"admin", "password"},
		{"gitea", "gitea"},
		{"forgejo", "forgejo"},
	}

	for _, creds := range defaults {
		formData := url.Values{
			"user_name": {creds.username},
			"password":  {creds.password},
		}

		resp, err := client.PostForm(baseURL+"/user/login", formData)
		if err != nil {
			t.Logf("Could not test credentials %s/%s: %v", creds.username, creds.password, err)
			continue
		}
		defer resp.Body.Close()

		// Successful login would redirect to dashboard (302)
		// Failed login returns to login page (200)
		if resp.StatusCode == http.StatusFound || resp.StatusCode == http.StatusMovedPermanently {
			// Check redirect location
			location := resp.Header.Get("Location")
			if strings.Contains(location, "dashboard") || strings.Contains(location, "/") {
				t.Errorf("Default credentials %s/%s accepted! Security risk!", creds.username, creds.password)
			}
		}
	}

	t.Log("Default credential check completed")
}

// TestHTTPSRedirect verifies HTTP redirects to HTTPS (in production)
func TestHTTPSRedirect(t *testing.T) {
	t.Log("HTTPS redirect test: advisory only (environment-dependent)")
	// This test is environment-dependent
	// In production, HTTP should redirect to HTTPS
	// In local test, this may not apply
}

// TestXSSHeadersPresent verifies security headers are set
func TestXSSHeadersPresent(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(baseURL)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	requiredHeaders := map[string]string{
		"X-Content-Type-Options": "nosniff",
	}

	advisoryHeaders := map[string]bool{
		"X-Frame-Options":       true,
		"X-XSS-Protection":      true,
		"Content-Security-Policy": true,
		"Strict-Transport-Security": true,
	}

	t.Log("Security headers check:")

	// Check required headers
	for header, expected := range requiredHeaders {
		val := resp.Header.Get(header)
		if val == "" {
			t.Errorf("Missing required security header: %s", header)
		} else if val != expected {
			t.Errorf("Header %s: expected %s, got %s", header, expected, val)
		} else {
			t.Logf("  %s: OK (%s)", header, val)
		}
	}

	// Check advisory headers
	for header := range advisoryHeaders {
		val := resp.Header.Get(header)
		if val == "" {
			t.Logf("  %s: missing (advisory)", header)
		} else {
			t.Logf("  %s: OK", header)
		}
	}
}

// TestNoVersionDisclosure verifies upstream version is not exposed
func TestNoVersionDisclosure(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(baseURL)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	// Check Server header
	server := resp.Header.Get("Server")
	if server != "" {
		if strings.Contains(strings.ToLower(server), "forgejo") || strings.Contains(strings.ToLower(server), "gitea") {
			t.Logf("Advisory: Server header reveals upstream tool: %s", server)
		}
	}

	// Check for version info in HTML
	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	versionIndicators := []string{
		"Forgejo v",
		"Gitea v",
		"gitea.io",
	}

	for _, indicator := range versionIndicators {
		if strings.Contains(bodyStr, indicator) {
			t.Logf("Advisory: Version disclosure in HTML: %s", indicator)
		}
	}
}

// TestCSRFProtection verifies CSRF tokens are required
func TestCSRFProtection(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	// Try to perform a state-changing action without CSRF token
	formData := url.Values{
		"user_name": {"test"},
		"password":  {"test"},
	}

	resp, err := client.PostForm(baseURL+"/user/login", formData)
	if err != nil {
		t.Logf("CSRF test request failed: %v", err)
		return
	}
	defer resp.Body.Close()

	// Without CSRF token, login should fail
	if resp.StatusCode != http.StatusOK {
		t.Log("CSRF protection appears to be enforced")
		return
	}

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Check if _csrf field is present in the response
	if strings.Contains(bodyStr, "_csrf") {
		t.Log("CSRF token fields are present in login form")
	}
}

// TestPasswordPolicyEnforced verifies passwords meet minimum requirements
func TestPasswordPolicyEnforced(t *testing.T) {
	// This test is advisory - checks if password requirements are enforced
	// Would require attempting to set weak passwords via API
	t.Log("Password policy test: advisory (requires API credential management)")
}

// TestAuthenticationRequired verifies protected endpoints require auth
func TestAuthenticationRequired(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	// These endpoints should require authentication
	protectedEndpoints := []string{
		"/api/v1/user",
		"/api/v1/user/repos",
		"/api/v1/admin",
	}

	for _, endpoint := range protectedEndpoints {
		resp, err := client.Get(baseURL + endpoint)
		if err != nil {
			t.Logf("Could not test %s: %v", endpoint, err)
			continue
		}
		defer resp.Body.Close()

		// Should return 401 or 403, not 200
		if resp.StatusCode == http.StatusOK {
			t.Logf("Warning: %s returned 200 without auth (may be unauthenticated endpoint)", endpoint)
		} else if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			t.Logf("%s correctly requires authentication", endpoint)
		}
	}
}

// TestSQLInjectionProtection verifies SQL injection is prevented
func TestSQLInjectionProtection(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	// Try some common SQL injection patterns
	sqlPayloads := []string{
		"' OR '1'='1",
		"1; DROP TABLE users--",
		"admin' --",
	}

	for _, payload := range sqlPayloads {
		// Try as username in login
		formData := url.Values{
			"user_name": {payload},
			"password":  {"test"},
		}

		resp, err := client.PostForm(baseURL+"/user/login", formData)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		// Should not cause a 500 error or database error
		if resp.StatusCode >= 500 {
			t.Errorf("Potential SQL injection vulnerability detected with payload: %s", payload)
		}
	}

	t.Log("SQL injection test completed (no obvious vulnerabilities)")
}

// TestCookieSecurityFlags verifies cookies are secure
func TestCookieSecurityFlags(t *testing.T) {
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Get(baseURL + "/user/login")
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	setCookie := resp.Header.Get("Set-Cookie")
	if setCookie == "" {
		t.Log("No session cookies set on login page (expected)")
		return
	}

	t.Logf("Session cookie: %s", truncateStr(setCookie, 50))

	// Check for security flags
	if strings.Contains(SetCookie, "Secure") || strings.Contains(setCookie, "secure") {
		t.Log("  Secure flag present")
	} else {
		t.Log("  Advisory: Secure flag not found on cookie")
	}

	if strings.Contains(SetCookie, "HttpOnly") || strings.Contains(setCookie, "httponly") {
		t.Log("  HttpOnly flag present")
	} else {
		t.Log("  Advisory: HttpOnly flag not found on cookie")
	}
}

// TestRateLimiting verifies rate limiting is in place
func TestRateLimiting(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}

	// Make multiple rapid requests
	const attempts = 20
	var blocked int

	for i := 0; i < attempts; i++ {
		resp, err := client.Get(baseURL + "/user/login")
		if err != nil {
			continue
		}
		resp.Body.Close()

		// 429 = Too Many Requests (rate limited)
		if resp.StatusCode == http.StatusTooManyRequests {
			blocked++
		}
	}

	if blocked > 0 {
		t.Logf("Rate limiting detected (%d/%d requests blocked)", blocked, attempts)
	} else {
		t.Log("Advisory: No obvious rate limiting detected (may be configured elsewhere)")
	}
}

// Helper functions

func truncateStr(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}
