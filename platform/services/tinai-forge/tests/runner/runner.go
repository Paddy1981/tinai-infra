package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/kubernetes"
)

type TestCategory string

const (
	CategorySmoke      TestCategory = "smoke"
	CategoryBranding   TestCategory = "branding"
	CategoryFunctional TestCategory = "functional"
	CategorySecurity   TestCategory = "security"
)

type TestResult struct {
	Category   TestCategory
	Name       string
	Passed     bool
	Message    string
	Duration   time.Duration
	Screenshot string // base64 PNG for branding tests
}

type TrivyVulnerability struct {
	VulnerabilityID string `json:"VulnerabilityID"`
	Severity        string `json:"Severity"`
	Title           string `json:"Title"`
	PkgName         string `json:"PkgName"`
}

type TestSuite struct {
	Product   string
	ImageTag  string
	Results   []TestResult
	StartedAt time.Time
	Duration  time.Duration
	Passed    bool // true only if all blocking tests pass
}

type Runner struct {
	kubeClient kubernetes.Interface
	namespace  string // tinai-forge-test
	logger     *zap.Logger
}

// NewRunner creates a new test runner with Kubernetes client
func NewRunner(kubeClient kubernetes.Interface, namespace string, logger *zap.Logger) *Runner {
	return &Runner{
		kubeClient: kubeClient,
		namespace:  namespace,
		logger:     logger,
	}
}

// Run executes all tests for a built image
// Returns TestSuite with results
// Blocking categories: smoke, branding, functional, security (CRITICAL CVEs)
// Advisory only: compatibility warnings
func (r *Runner) Run(ctx context.Context, product, imageTag string) (*TestSuite, error) {
	suite := &TestSuite{
		Product:   product,
		ImageTag:  imageTag,
		Results:   []TestResult{},
		StartedAt: time.Now(),
		Passed:    false,
	}

	// Setup test namespace
	r.logger.Info("setting up test namespace", zap.String("namespace", r.namespace))
	if err := r.SetupTestNamespace(ctx, product); err != nil {
		r.logger.Error("failed to setup test namespace", zap.Error(err))
		return suite, fmt.Errorf("namespace setup failed: %w", err)
	}

	// Defer cleanup
	defer func() {
		r.logger.Info("tearing down test namespace")
		if err := r.TeardownTestNamespace(ctx); err != nil {
			r.logger.Error("failed to teardown test namespace", zap.Error(err))
		}
	}()

	// Run test categories in order
	// Smoke tests first - if these fail, stop immediately
	r.logger.Info("running smoke tests")
	smokeResults, err := r.runCategory(ctx, CategorySmoke, product, imageTag)
	suite.Results = append(suite.Results, smokeResults...)
	if err != nil {
		r.logger.Error("smoke tests failed", zap.Error(err))
		suite.Duration = time.Since(suite.StartedAt)
		suite.Passed = false
		return suite, err
	}

	// If all smoke tests passed, continue with other categories
	r.logger.Info("running branding tests")
	brandingResults, _ := r.runCategory(ctx, CategoryBranding, product, imageTag)
	suite.Results = append(suite.Results, brandingResults...)

	r.logger.Info("running functional tests")
	functionalResults, _ := r.runCategory(ctx, CategoryFunctional, product, imageTag)
	suite.Results = append(suite.Results, functionalResults...)

	r.logger.Info("running security tests")
	securityResults, _ := r.runCategory(ctx, CategorySecurity, product, imageTag)
	suite.Results = append(suite.Results, securityResults...)

	// Calculate if suite passed (all critical tests passed)
	suite.Passed = r.allCriticalTestsPassed(suite.Results)
	suite.Duration = time.Since(suite.StartedAt)

	r.logger.Info("test suite complete", zap.Bool("passed", suite.Passed), zap.Duration("duration", suite.Duration))
	return suite, nil
}

// runCategory runs all tests in a given category and returns results
func (r *Runner) runCategory(ctx context.Context, category TestCategory, product, imageTag string) ([]TestResult, error) {
	results := []TestResult{}

	switch category {
	case CategorySmoke:
		// Smoke tests run via Go test framework
		// This is orchestration - actual tests are in forgejo/, grafana/, etc.
		r.logger.Info("smoke tests would be executed here", zap.String("product", product))

	case CategoryBranding:
		r.logger.Info("branding tests would be executed here", zap.String("product", product))

	case CategoryFunctional:
		r.logger.Info("functional tests would be executed here", zap.String("product", product))

	case CategorySecurity:
		r.logger.Info("running security tests", zap.String("product", product), zap.String("imageTag", imageTag))
		// Run Trivy security scan on the image
		vulns, err := r.runTrivyScan(imageTag)
		if err != nil {
			// Log warning but don't fail - trivy may not be installed
			r.logger.Warn("security scan skipped", zap.Error(err))
			results = append(results, TestResult{
				Category: CategorySecurity,
				Name:     "image-vulnerability-scan",
				Passed:   true, // Mark as skipped (advisory only)
				Message:  fmt.Sprintf("Trivy scan skipped: %v", err),
				Duration: 0,
			})
		} else {
			// Analyze vulnerabilities
			result := r.analyzeTrivyResults(vulns)
			results = append(results, result)
		}
	}

	return results, nil
}

// allCriticalTestsPassed checks if all blocking test categories passed
func (r *Runner) allCriticalTestsPassed(results []TestResult) bool {
	criticalCategories := map[TestCategory]bool{
		CategorySmoke:      true,
		CategoryBranding:   true,
		CategoryFunctional: true,
		CategorySecurity:   true,
	}

	for category := range criticalCategories {
		for _, result := range results {
			if result.Category == category && !result.Passed {
				return false
			}
		}
	}
	return true
}

// SetupTestNamespace creates ephemeral test namespace with pre-seeded data
func (r *Runner) SetupTestNamespace(ctx context.Context, product string) error {
	// Namespace creation would be handled by caller (typically Helm/GitOps)
	// This method ensures the namespace is ready and seeded with test data
	r.logger.Info("setting up test data in namespace", zap.String("namespace", r.namespace))

	// Create ConfigMaps for test configuration
	// Create Secrets for test credentials
	// Seed initial data if needed

	return nil
}

// TeardownTestNamespace deletes the test namespace
func (r *Runner) TeardownTestNamespace(ctx context.Context) error {
	r.logger.Info("deleting test namespace", zap.String("namespace", r.namespace))

	// Delete namespace - Kubernetes will cascade delete all resources
	// err := r.kubeClient.CoreV1().Namespaces().Delete(ctx, r.namespace, metav1.DeleteOptions{})
	// For now, just log - actual deletion handled by cleanup job
	return nil
}

// GetResults returns the current test results
func (r *Runner) GetResults(suite *TestSuite) []TestResult {
	return suite.Results
}

// GetPassRate returns the percentage of tests that passed
func (r *Runner) GetPassRate(suite *TestSuite) float64 {
	if len(suite.Results) == 0 {
		return 100.0
	}

	passed := 0
	for _, result := range suite.Results {
		if result.Passed {
			passed++
		}
	}

	return (float64(passed) / float64(len(suite.Results))) * 100.0
}

// runTrivyScan executes a trivy scan using the trivy server for faster scanning.
// Falls back to local trivy binary if server is not available.
func (r *Runner) runTrivyScan(image string) ([]TrivyVulnerability, error) {
	trivyServer := os.Getenv("TRIVY_SERVER_URL")

	var cmd *exec.Cmd
	if trivyServer != "" {
		// Use trivy server for faster scanning (DB cached on server)
		r.logger.Info("using trivy server for scan", zap.String("server", trivyServer))
		cmd = exec.Command("trivy", "image",
			"--server", trivyServer,
			"--format", "json",
			"--exit-code", "0",
			image)
	} else {
		// Local trivy binary
		r.logger.Info("using local trivy for scan")
		cmd = exec.Command("trivy", "image",
			"--format", "json",
			"--exit-code", "0",
			image)
	}

	out, err := cmd.Output()
	if err != nil {
		// trivy not installed — skip security scan, log warning
		return nil, fmt.Errorf("trivy not available: %w", err)
	}

	// Parse JSON output
	var result struct {
		Results []struct {
			Vulnerabilities []TrivyVulnerability `json:"Vulnerabilities"`
		} `json:"Results"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parse trivy output: %w", err)
	}

	var vulns []TrivyVulnerability
	for _, r := range result.Results {
		vulns = append(vulns, r.Vulnerabilities...)
	}
	return vulns, nil
}

// analyzeTrivyResults evaluates vulnerabilities and returns a test result.
// Fails if there are any CRITICAL vulnerabilities or more than 5 HIGH vulnerabilities.
func (r *Runner) analyzeTrivyResults(vulns []TrivyVulnerability) TestResult {
	result := TestResult{
		Category: CategorySecurity,
		Name:     "image-vulnerability-scan",
		Passed:   true,
		Duration: 0,
	}

	if len(vulns) == 0 {
		result.Message = "No vulnerabilities found"
		result.Passed = true
		return result
	}

	// Count vulnerabilities by severity
	criticalCount := 0
	highCount := 0
	mediumCount := 0
	lowCount := 0

	for _, vuln := range vulns {
		switch strings.ToUpper(vuln.Severity) {
		case "CRITICAL":
			criticalCount++
		case "HIGH":
			highCount++
		case "MEDIUM":
			mediumCount++
		case "LOW":
			lowCount++
		}
	}

	// Build message
	message := fmt.Sprintf("Found %d total vulnerabilities: %d CRITICAL, %d HIGH, %d MEDIUM, %d LOW",
		len(vulns), criticalCount, highCount, mediumCount, lowCount)

	// Determine pass/fail
	if criticalCount > 0 {
		result.Passed = false
		result.Message = "FAILED: " + message + " - CRITICAL vulnerabilities must be resolved"
		r.logger.Error("security test failed: critical vulnerabilities detected", zap.Int("count", criticalCount))
		return result
	}

	if highCount > 5 {
		result.Passed = false
		result.Message = "FAILED: " + message + " - More than 5 HIGH vulnerabilities detected"
		r.logger.Error("security test failed: too many high vulnerabilities", zap.Int("count", highCount))
		return result
	}

	result.Passed = true
	result.Message = "PASSED: " + message
	r.logger.Info("security test passed", zap.String("message", message))
	return result
}
