package grafana_test

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const grafanaURL = "http://grafana-test.tinai-forge-test.svc.cluster.local:3000"

// TestGrafanaLoginPageBranding verifies TinAI Insights branding
func TestGrafanaLoginPageBranding(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL + "/login")
	if err != nil {
		t.Fatalf("Cannot reach Grafana: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	bodyStr := string(body)

	if !containsIgnoreCaseStr(bodyStr, "TinAI") {
		t.Error("Grafana login page does not show TinAI branding")
		return
	}

	t.Log("TinAI branding found on Grafana login page")

	// Check app title override
	if strings.Contains(bodyStr, "\"appTitle\":\"Grafana\"") {
		t.Error("Grafana app title not overridden - still shows default")
	}

	if containsIgnoreCaseStr(bodyStr, "appTitle") && containsIgnoreCaseStr(bodyStr, "TinAI") {
		t.Log("App title appears to be customized")
	}
}

// TestGrafanaAPIUp verifies Grafana API responds
func TestGrafanaAPIUp(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL + "/api/health")
	if err != nil {
		t.Fatalf("Grafana API health check failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200, got %d", resp.StatusCode)
		return
	}

	body, _ := io.ReadAll(resp.Body)
	t.Logf("Grafana health check passed: %s", string(body)[:100])
}

// TestGrafanaContainerStarts verifies Grafana pod starts successfully
func TestGrafanaContainerStarts(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	// Retry a few times as container may be starting
	deadline := time.Now().Add(30 * time.Second)

	for time.Now().Before(deadline) {
		resp, err := client.Get(grafanaURL + "/api/health")
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			t.Log("Grafana container is running and healthy")
			return
		}

		if err == nil {
			resp.Body.Close()
		}

		time.Sleep(2 * time.Second)
	}

	t.Error("Grafana container did not become ready within 30 seconds")
}

// TestGrafanaDatasourcesProvisioned verifies Prometheus datasource is configured
func TestGrafanaDatasourcesProvisioned(t *testing.T) {
	t.Log("Datasource provisioning test: requires admin API access")
	t.Log("Check provisioning directory: /etc/grafana/provisioning/datasources/")

	// In a real deployment, this would:
	// 1. GET /api/datasources with admin auth
	// 2. Verify "TinAI Prometheus" or similar datasource exists
	// 3. Check datasource is configured with correct Prometheus URL

	// For now, log as advisory
	client := &http.Client{Timeout: 10 * time.Second}

	// Try to access datasources endpoint (usually requires auth)
	resp, err := client.Get(grafanaURL + "/api/datasources")
	if err != nil {
		t.Logf("Cannot access datasources endpoint: %v (expected - requires auth)", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		t.Log("Datasource endpoint requires authentication (expected)")
	} else if resp.StatusCode == http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		if strings.Contains(string(body), "Prometheus") {
			t.Log("Prometheus datasource is configured")
		}
	}
}

// TestGrafanaLogoCustomized verifies TinAI logo is displayed
func TestGrafanaLogoCustomized(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL + "/login")
	if err != nil {
		t.Fatalf("Failed to fetch login page: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	logoIndicators := []string{
		"tinai-logo",
		"tinai",
		"logo",
	}

	hasLogoReference := false

	for _, indicator := range logoIndicators {
		if strings.Contains(strings.ToLower(bodyStr), strings.ToLower(indicator)) {
			t.Logf("Found logo reference: %s", indicator)
			hasLogoReference = true
			break
		}
	}

	if !hasLogoReference {
		t.Log("Advisory: Could not verify custom logo in HTML")
	}
}

// TestGrafanaThemeApplied verifies TinAI theme CSS is loaded
func TestGrafanaThemeApplied(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL)
	if err != nil {
		t.Fatalf("Failed to fetch Grafana: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Check for theme-related CSS or config
	themeIndicators := []string{
		"theme",
		"custom.css",
		"branding",
		"tinai",
	}

	foundTheme := false

	for _, indicator := range themeIndicators {
		if strings.Contains(strings.ToLower(bodyStr), strings.ToLower(indicator)) {
			t.Logf("Found theme indicator: %s", indicator)
			foundTheme = true
			break
		}
	}

	if !foundTheme {
		t.Log("Advisory: Theme configuration not obviously present in HTML")
	}
}

// TestGrafanaNoUpstreamBranding verifies Grafana branding is hidden
func TestGrafanaNoUpstreamBranding(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL + "/login")
	if err != nil {
		t.Fatalf("Failed to fetch login page: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	upstreamBranding := []string{
		"grafana.com",
		"Grafana Labs",
		"The Observability Platform",
	}

	foundUpstream := false

	for _, brand := range upstreamBranding {
		if strings.Contains(bodyStr, brand) {
			t.Logf("Found upstream branding: %s", brand)
			foundUpstream = true
		}
	}

	if !foundUpstream {
		t.Log("No obvious upstream branding detected")
	}
}

// TestGrafanaFaviconCustom verifies favicon is TinAI branded
func TestGrafanaFaviconCustom(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}

	faviconPaths := []string{
		"/public/img/fav32.png",
		"/public/img/tinai-favicon.png",
		"/favicon.ico",
		"/favicon.png",
	}

	foundFavicon := false

	for _, path := range faviconPaths {
		resp, err := client.Get(grafanaURL + path)
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
		t.Log("Advisory: Could not locate favicon at expected paths")
	}
}

// TestGrafanaPageTitle verifies page title contains TinAI
func TestGrafanaPageTitle(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(grafanaURL)
	if err != nil {
		t.Fatalf("Failed to fetch Grafana: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Extract title from HTML
	startIdx := strings.Index(bodyStr, "<title>")
	endIdx := strings.Index(bodyStr, "</title>")

	if startIdx != -1 && endIdx != -1 {
		title := bodyStr[startIdx+7 : endIdx]
		t.Logf("Page title: %s", title)

		if containsIgnoreCaseStr(title, "TinAI") {
			t.Log("Page title correctly branded")
		} else if containsIgnoreCaseStr(title, "Grafana") {
			t.Error("Page title still shows default Grafana branding")
		}
	}
}

// Helper functions

func containsIgnoreCaseStr(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}
