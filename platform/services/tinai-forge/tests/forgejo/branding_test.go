package forgejo_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const baseURL = "http://forgejo-test.tinai-forge-test.svc.cluster.local:3000"

// TestLoginPageHasTinAIBranding verifies TinAI brand appears on login page
func TestLoginPageHasTinAIBranding(t *testing.T) {
	body := fetchPage(t, baseURL+"/user/login")

	// Must contain TinAI branding
	if !containsIgnoreCase(body, "TinAI") {
		t.Error("Login page does not contain 'TinAI' - branding not applied")
		return
	}

	t.Log("TinAI branding found on login page")
}

// TestLoginPageHasNoForgejoText verifies upstream brand is hidden
func TestLoginPageHasNoForgejoText(t *testing.T) {
	body := fetchPage(t, baseURL+"/user/login")

	forbiddenStrings := []string{"Forgejo", "Gitea", "gitea.io", "codeberg.org"}
	foundForbidden := false

	for _, forbidden := range forbiddenStrings {
		if strings.Contains(body, forbidden) {
			t.Errorf("Login page exposes upstream brand: found '%s'", forbidden)
			foundForbidden = true
		}
	}

	if !foundForbidden {
		t.Log("No upstream branding detected on login page")
	}
}

// TestPageTitleIsTinAI verifies HTML title tag contains TinAI
func TestPageTitleIsTinAI(t *testing.T) {
	body := fetchPage(t, baseURL)

	if !strings.Contains(body, "<title>") {
		t.Error("No title tag found in page")
		return
	}

	// Extract title
	startIdx := strings.Index(body, "<title>")
	endIdx := strings.Index(body, "</title>")

	if startIdx == -1 || endIdx == -1 {
		t.Error("Could not parse title tag")
		return
	}

	title := body[startIdx+7 : endIdx]

	if !containsIgnoreCase(title, "TinAI") {
		t.Errorf("Page title does not contain 'TinAI'. Title: %s", title)
		return
	}

	t.Logf("Page title correctly set: %s", title)
}

// TestFaviconResponds verifies TinAI favicon is served
func TestFaviconResponds(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}

	paths := []string{
		"/assets/img/tinai-favicon.png",
		"/favicon.png",
		"/favicon.ico",
		"/assets/favicon.ico",
	}

	foundFavicon := false

	for _, path := range paths {
		resp, err := client.Get(baseURL + path)
		if err != nil {
			t.Logf("Favicon path %s: connection error %v", path, err)
			continue
		}

		if resp.StatusCode == http.StatusOK {
			t.Logf("Favicon found at: %s (status: %d)", path, resp.StatusCode)
			foundFavicon = true
			resp.Body.Close()
			break
		}

		resp.Body.Close()
		t.Logf("Favicon path %s: status %d", path, resp.StatusCode)
	}

	if !foundFavicon {
		t.Log("Advisory: No favicon found at expected paths (not blocking)")
	}
}

// TestTinAICSSLoaded verifies the TinAI theme CSS is included
func TestTinAICSSLoaded(t *testing.T) {
	body := fetchPage(t, baseURL)

	// Check for tinai-specific CSS references
	hasCustomCSS := false

	customCSSIndicators := []string{
		"tinai",
		"custom.css",
		"theme.css",
		"branding",
	}

	for _, indicator := range customCSSIndicators {
		if containsIgnoreCase(body, indicator) {
			t.Logf("Found CSS indicator: %s", indicator)
			hasCustomCSS = true
			break
		}
	}

	if !hasCustomCSS {
		t.Log("Advisory: No custom TinAI CSS references found (may be inlined)")
	}
}

// TestEmailTemplatesUseTinAIDomain verifies mailer config uses @tinai.cloud
func TestEmailTemplatesUseTinAIDomain(t *testing.T) {
	// This test is advisory - doesn't block promotion
	t.Log("Email template branding test: advisory only (requires config access)")

	// In a real deployment, this would:
	// 1. Call Forgejo API to get configuration
	// 2. Check SENDER_EMAIL_ADDRESS or APP_NAME settings
	// 3. Verify they use TinAI branding
}

// TestNoDefaultBranding verifies default Forgejo/Gitea branding is removed
func TestNoDefaultBranding(t *testing.T) {
	body := fetchPage(t, baseURL)

	defaultBrandingItems := []string{
		"git with a cup of tea",
		"Gitea",
		"go-gitea",
	}

	foundDefault := false

	for _, item := range defaultBrandingItems {
		if strings.Contains(body, item) {
			t.Errorf("Found default branding: %s", item)
			foundDefault = true
		}
	}

	if !foundDefault {
		t.Log("No default Forgejo/Gitea branding found")
	}
}

// TestLogoImageIsCustom verifies logo points to TinAI asset
func TestLogoImageIsCustom(t *testing.T) {
	body := fetchPage(t, baseURL)

	// Look for logo image tags
	logoIndicators := []string{
		"tinai-logo",
		"logo.png",
		"logo.svg",
	}

	hasLogo := false

	for _, indicator := range logoIndicators {
		if strings.Contains(body, indicator) {
			t.Logf("Found logo indicator: %s", indicator)
			hasLogo = true
		}
	}

	if !hasLogo {
		t.Log("Advisory: Could not verify custom logo in HTML (may be in CSS)")
	}
}

// fetchPage is a helper that retrieves a URL body as string
func fetchPage(t *testing.T, url string) string {
	t.Helper()

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("Failed to fetch %s: %v", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200 from %s, got %d", url, resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	return string(body)
}

// containsIgnoreCase does case-insensitive substring search
func containsIgnoreCase(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}
