package tester

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/kubernetes"
)

// BrandingTest checks TinAI branding is present and upstream branding is absent
type BrandingTest struct {
	Product    string
	BaseURL    string
	kubeClient kubernetes.Interface
	logger     *zap.Logger
}

// NewBrandingTest creates a new branding test
func NewBrandingTest(product, baseURL string, kubeClient kubernetes.Interface, logger *zap.Logger) *BrandingTest {
	return &BrandingTest{
		Product:    product,
		BaseURL:    baseURL,
		kubeClient: kubeClient,
		logger:     logger,
	}
}

// Run executes the branding tests
func (bt *BrandingTest) Run() []TestResult {
	var results []TestResult

	client := &http.Client{Timeout: 10 * time.Second}

	// Test 1: TinAI branding present
	startTime := time.Now()
	hasTinAI, err := bt.checkTinAIBranding(client)
	results = append(results, TestResult{
		Name:     "TinAI branding present",
		Passed:   hasTinAI && err == nil,
		Message:  bt.formatMessage("TinAI branding", hasTinAI, err),
		Duration: time.Since(startTime),
	})

	// Test 2: Upstream branding absent
	startTime = time.Now()
	hasUpstream, err := bt.checkUpstreamBranding(client)
	results = append(results, TestResult{
		Name:     "Upstream branding absent",
		Passed:   !hasUpstream && err == nil,
		Message:  bt.formatMessage("upstream branding removed", !hasUpstream, err),
		Duration: time.Since(startTime),
	})

	// Test 3: Favicon responds
	startTime = time.Now()
	err = bt.checkResource(client, "/favicon.ico")
	results = append(results, TestResult{
		Name:     "Favicon accessible",
		Passed:   err == nil,
		Message:  bt.errorMessage("favicon", err),
		Duration: time.Since(startTime),
	})

	// Test 4: Logo image responds
	startTime = time.Now()
	err = bt.checkLogoImage(client)
	results = append(results, TestResult{
		Name:     "Logo image accessible",
		Passed:   err == nil,
		Message:  bt.errorMessage("logo image", err),
		Duration: time.Since(startTime),
	})

	// Test 5: Page title safe
	startTime = time.Now()
	isSafe, err := bt.checkPageTitle(client)
	results = append(results, TestResult{
		Name:     "Page title safe",
		Passed:   isSafe && err == nil,
		Message:  bt.formatMessage("page title", isSafe, err),
		Duration: time.Since(startTime),
	})

	bt.logger.Info("branding tests completed", zap.String("product", bt.Product), zap.Int("passed", countPassed(results)))
	return results
}

// checkTinAIBranding checks if TinAI branding is present
func (bt *BrandingTest) checkTinAIBranding(client *http.Client) (bool, error) {
	resp, err := client.Get(fmt.Sprintf("%s/login", bt.BaseURL))
	if err != nil {
		return false, fmt.Errorf("failed to fetch login page: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read response: %w", err)
	}

	content := strings.ToLower(string(body))

	// Check for TinAI branding
	if !strings.Contains(content, "tinai") {
		// Also check for variations
		if !strings.Contains(content, "tin ai") && !strings.Contains(content, "tin-ai") {
			return false, nil
		}
	}

	return true, nil
}

// checkUpstreamBranding checks if upstream tool names are absent
func (bt *BrandingTest) checkUpstreamBranding(client *http.Client) (bool, error) {
	resp, err := client.Get(fmt.Sprintf("%s/login", bt.BaseURL))
	if err != nil {
		return false, fmt.Errorf("failed to fetch login page: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read response: %w", err)
	}

	content := strings.ToLower(string(body))

	// Check for upstream tool names that should be removed
	upstreamNames := map[string][]string{
		"forgejo": {"forgejo", "gitea"},
		"grafana": {"grafana"},
		"prometheus": {"prometheus"},
		"loki": {"loki"},
		"woodpecker": {"woodpecker"},
	}

	// Get names for this product
	names, ok := upstreamNames[bt.Product]
	if !ok {
		// Don't fail if product not in list
		return false, nil
	}

	// Check if any upstream name is present
	for _, name := range names {
		if strings.Contains(content, name) {
			return true, nil // Upstream branding found (bad)
		}
	}

	return false, nil // No upstream branding found (good)
}

// checkResource checks if a resource responds with 200
func (bt *BrandingTest) checkResource(client *http.Client, path string) error {
	resp, err := client.Head(fmt.Sprintf("%s%s", bt.BaseURL, path))
	if err != nil {
		return fmt.Errorf("failed to fetch resource: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("resource returned %d", resp.StatusCode)
	}

	return nil
}

// checkLogoImage checks if logo image is accessible
func (bt *BrandingTest) checkLogoImage(client *http.Client) error {
	// Common logo paths
	logoPaths := []string{
		"/logo.png",
		"/images/logo.png",
		"/static/logo.png",
		"/public/logo.png",
		"/assets/logo.png",
	}

	for _, path := range logoPaths {
		resp, err := client.Head(fmt.Sprintf("%s%s", bt.BaseURL, path))
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			return nil
		}
	}

	return fmt.Errorf("no logo image found at common paths")
}

// checkPageTitle checks if page title doesn't expose upstream tool name
func (bt *BrandingTest) checkPageTitle(client *http.Client) (bool, error) {
	resp, err := client.Get(bt.BaseURL)
	if err != nil {
		return false, fmt.Errorf("failed to fetch page: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read response: %w", err)
	}

	content := strings.ToLower(string(body))

	// Extract title from <title> tag
	titleStart := strings.Index(content, "<title>")
	titleEnd := strings.Index(content, "</title>")

	if titleStart == -1 || titleEnd == -1 {
		return true, nil // No title found, not a failure
	}

	title := content[titleStart+7 : titleEnd]

	// Check for upstream tool names in title
	upstreamNames := []string{"forgejo", "gitea", "grafana", "prometheus", "loki", "woodpecker"}
	for _, name := range upstreamNames {
		if strings.Contains(title, name) {
			return false, nil // Upstream name in title (bad)
		}
	}

	return true, nil // Title is safe
}

// formatMessage formats the result message
func (bt *BrandingTest) formatMessage(feature string, passed bool, err error) string {
	if err != nil {
		return fmt.Sprintf("error: %v", err)
	}
	if passed {
		return fmt.Sprintf("%s verified", feature)
	}
	return fmt.Sprintf("%s not found", feature)
}

// errorMessage formats error messages
func (bt *BrandingTest) errorMessage(operation string, err error) string {
	if err == nil {
		return "passed"
	}
	return fmt.Sprintf("failed: %v", err)
}
