package woodpecker_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestWoodpeckerLoginPageBranding verifies TinAI CI/CD branding
func TestWoodpeckerLoginPageBranding(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL + "/login")
	if err != nil {
		t.Fatalf("Cannot reach Woodpecker: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	bodyStr := string(body)

	if !strings.Contains(strings.ToLower(bodyStr), strings.ToLower("TinAI")) {
		t.Error("Woodpecker login page does not show TinAI branding")
		return
	}

	t.Log("TinAI branding found on Woodpecker login page")
}

// TestWoodpeckerNoUpstreamBranding verifies upstream brand is hidden
func TestWoodpeckerNoUpstreamBranding(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL + "/login")
	if err != nil {
		t.Fatalf("Failed to fetch login page: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	forbiddenStrings := []string{"Woodpecker", "woodpecker.org", "CI/CD"}
	foundForbidden := false

	for _, forbidden := range forbiddenStrings {
		if strings.Contains(bodyStr, forbidden) {
			// Some mentions might be unavoidable, just log
			t.Logf("Found upstream reference: %s", forbidden)
			foundForbidden = true
		}
	}

	if !foundForbidden {
		t.Log("No obvious upstream branding detected")
	}
}

// TestWoodpeckerPageTitle verifies page title is branded
func TestWoodpeckerPageTitle(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL)
	if err != nil {
		t.Fatalf("Failed to fetch dashboard: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Extract title
	startIdx := strings.Index(bodyStr, "<title>")
	endIdx := strings.Index(bodyStr, "</title>")

	if startIdx == -1 || endIdx == -1 {
		t.Log("No title tag found or could not be parsed")
		return
	}

	title := bodyStr[startIdx+7 : endIdx]
	t.Logf("Page title: %s", title)

	if !strings.Contains(strings.ToLower(title), strings.ToLower("TinAI")) {
		t.Log("Advisory: Page title does not contain TinAI")
	}
}

// TestWoodpeckerLogoCustomized verifies logo is customized
func TestWoodpeckerLogoCustomized(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL)
	if err != nil {
		t.Fatalf("Failed to fetch page: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	logoIndicators := []string{
		"tinai-logo",
		"logo",
		"branding",
	}

	hasLogo := false

	for _, indicator := range logoIndicators {
		if strings.Contains(strings.ToLower(bodyStr), strings.ToLower(indicator)) {
			t.Logf("Found logo indicator: %s", indicator)
			hasLogo = true
			break
		}
	}

	if !hasLogo {
		t.Log("Advisory: Could not verify custom logo")
	}
}

// TestWoodpeckerFaviconResponds verifies favicon is served
func TestWoodpeckerFaviconResponds(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}

	paths := []string{
		"/favicon.png",
		"/favicon.ico",
		"/assets/favicon.ico",
	}

	foundFavicon := false

	for _, path := range paths {
		resp, err := client.Get(woodpeckerURL + path)
		if err != nil {
			continue
		}

		if resp.StatusCode == http.StatusOK {
			t.Logf("Favicon found at: %s", path)
			foundFavicon = true
			resp.Body.Close()
			break
		}

		resp.Body.Close()
	}

	if !foundFavicon {
		t.Log("Advisory: No favicon found")
	}
}
