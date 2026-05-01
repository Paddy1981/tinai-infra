# TinAI CTS - Compatibility Test Suite

The **TinAI Compatibility Test Suite (CTS)** is an automated testing framework for validating white-labeled builds before production deployment. It runs comprehensive tests across smoke, branding, functional, and security categories to ensure every release meets quality standards.

## Overview

### Purpose
- Validate white-labeled builds (Forgejo, Grafana, Woodpecker, etc.) before production
- Verify TinAI branding is properly applied
- Test core functionality works as expected
- Detect security regressions
- Provide quick feedback on image readiness

### Test Categories

**Blocking (Must Pass)**:
- **Smoke**: Container starts, basic health checks
- **Branding**: TinAI branding applied, upstream branding hidden
- **Functional**: Core product features work
- **Security**: No default credentials, security headers present

**Advisory Only**:
- Environment-dependent tests (HTTPS redirects, rate limiting)
- Optional features
- Configuration checks

## Directory Structure

```
tests/
├── runner/              # Test orchestration
│   └── runner.go
├── forgejo/             # Forgejo (Git service) tests
│   ├── smoke_test.go
│   ├── branding_test.go
│   ├── functional_test.go
│   └── security_test.go
├── grafana/             # Grafana (Insights) tests
│   └── branding_test.go
├── woodpecker/          # Woodpecker (CI/CD) tests
│   ├── smoke_test.go
│   └── branding_test.go
├── common/              # Shared test helpers
│   └── helpers.go
├── Makefile             # Test targets and CI commands
├── go.mod               # Module dependencies
└── README.md            # This file
```

## Running Tests

### Prerequisites
- Go 1.21+
- Access to Kubernetes cluster (for integration tests)
- Test docker images available

### Quick Start

**Run all tests**:
```bash
make test-all
```

**Run product-specific tests**:
```bash
make test-forgejo IMAGE=registry.e2enetworks.net/tinai/tinai-repos:1.22.7-tinai
make test-grafana IMAGE=registry.e2enetworks.net/tinai/tinai-insights:1.0.0-tinai
```

**Run test category**:
```bash
make test-smoke        # 30 seconds
make test-branding     # 60 seconds
make test-functional   # 120 seconds
make test-security     # 90 seconds
```

**Full options**:
```bash
make help              # Show all targets
make test-all VERBOSE=1 TIMEOUT=600s
```

## Test Files

### runner/runner.go
**Test Orchestrator**

The main runner that:
- Manages test lifecycle (setup, run, teardown)
- Orchestrates test categories in order
- Determines pass/fail status
- Generates test results

Key types:
- `TestSuite`: Results container with pass status
- `TestResult`: Individual test result
- `Runner`: Orchestration engine

### forgejo/smoke_test.go
**Forgejo Smoke Tests** (8 tests, ~60s)

1. **TestForgejoContainerStarts**: Verifies pod reaches Ready state
2. **TestForgejoHealthEndpoint**: Checks `/api/healthz` returns 200
3. **TestForgejoLoginPageLoads**: Verifies login page renders (200, HTML)
4. **TestForgejoDatabaseMigrations**: Checks logs for migration success
5. **TestForgejoAPIResponds**: Calls `/api/v1/version` - 200 or 401 acceptable

### forgejo/branding_test.go
**Forgejo Branding Tests** (6 tests, ~30s)

1. **TestLoginPageHasTinAIBranding**: "TinAI" text present on login
2. **TestLoginPageHasNoForgejoText**: No "Forgejo", "Gitea", "codeberg.org"
3. **TestPageTitleIsTinAI**: HTML `<title>` contains "TinAI"
4. **TestFaviconResponds**: Favicon served at expected paths
5. **TestTinAICSSLoaded**: Custom CSS references present
6. **TestEmailTemplatesUseTinAIDomain**: Advisory - checks config

### forgejo/functional_test.go
**Forgejo Functional Tests** (7 tests, ~120s)

1. **TestCreateRepositoryViaAPI**: Create/delete repo via API
2. **TestWebhookDelivery**: Webhook creation and delivery
3. **TestOAuthSSOLogin**: OAuth endpoints accessible
4. **TestFileUploadDownload**: File operations work
5. **TestGitCloneWorks**: Git HTTP endpoint responds
6. **TestAPIPaginationWorks**: List pagination works
7. **TestAPIErrorHandling**: Proper 404 responses

### forgejo/security_test.go
**Forgejo Security Tests** (11 tests, ~90s)

1. **TestNoDefaultAdminPassword**: Default creds don't work
2. **TestXSSHeadersPresent**: Security headers set
3. **TestNoVersionDisclosure**: Version info hidden
4. **TestCSRFProtection**: CSRF tokens required
5. **TestPasswordPolicyEnforced**: Advisory - pwd requirements
6. **TestAuthenticationRequired**: Protected endpoints need auth
7. **TestSQLInjectionProtection**: SQL injection prevented
8. **TestCookieSecurityFlags**: Secure/HttpOnly flags set
9. **TestRateLimiting**: Rate limiting in place
10. **TestHTTPSRedirect**: Advisory - HTTP→HTTPS redirect

### grafana/branding_test.go
**Grafana Branding Tests** (8 tests, ~30s)

1. **TestGrafanaLoginPageBranding**: "TinAI Insights" branding
2. **TestGrafanaAPIUp**: Health check passes
3. **TestGrafanaContainerStarts**: Pod becomes Ready
4. **TestGrafanaDatasourcesProvisioned**: Prometheus datasource configured
5. **TestGrafanaLogoCustomized**: Custom logo present
6. **TestGrafanaThemeApplied**: Theme CSS loaded
7. **TestGrafanaNoUpstreamBranding**: "Grafana Labs" hidden
8. **TestGrafanaPageTitle**: Page title contains "TinAI"

### woodpecker/smoke_test.go
**Woodpecker Smoke Tests** (4 tests, ~60s)

1. **TestWoodpeckerContainerStarts**: Pod reaches Ready
2. **TestWoodpeckerHealthEndpoint**: Health check passes
3. **TestWoodpeckerDashboardLoads**: Dashboard renders
4. **TestWoodpeckerAPIResponds**: API endpoint responds

### woodpecker/branding_test.go
**Woodpecker Branding Tests** (5 tests, ~30s)

1. **TestWoodpeckerLoginPageBranding**: TinAI branding present
2. **TestWoodpeckerNoUpstreamBranding**: No "Woodpecker" references
3. **TestWoodpeckerPageTitle**: Title is branded
4. **TestWoodpeckerLogoCustomized**: Logo present
5. **TestWoodpeckerFaviconResponds**: Favicon served

### common/helpers.go
**Shared Test Utilities** (20+ functions)

Kubernetes helpers:
- `DeployTestPod()`: Deploy single-container pod
- `WaitForPodReady()`: Wait for pod Ready condition
- `WaitForPodHealthy()`: Wait for health endpoint
- `DeletePod()` / `DeletePodForce()`: Cleanup pods
- `GetPodLogs()`: Retrieve pod logs
- `IsPodReady()`: Check pod status

HTTP helpers:
- `WaitForHTTP()`: Poll URL until status matches
- `WaitForHTTPAny()`: Poll until any status matches

Namespace helpers:
- `CreateNamespace()`: Create test namespace
- `DeleteNamespace()`: Delete namespace

## Key Design Decisions

### 1. Blocking vs Advisory Tests
- **Blocking**: Must pass to promote image to production
  - Smoke, branding, functional, security with CRITICAL severity
- **Advisory**: For awareness but don't block promotion
  - Environment-specific tests (HTTPS redirects)
  - Optional features (email templates)
  - Informational checks (server headers)

### 2. Short Mode Support
Tests use Go's `-short` flag for fast CI:
```bash
go test -short ./...  # Skips long-running tests
```

### 3. Timeout Structure
- Smoke: 60s (container startup)
- Branding: 30s (HTTP only)
- Functional: 120s (API operations)
- Security: 90s (multiple probes)

### 4. Kubernetes Integration
- Tests deploy ephemeral pods with test images
- Automatic cleanup on failure/completion
- Uses in-cluster DNS for service discovery
- No external dependencies beyond test image

### 5. Graceful Degradation
- Tests skip if Kubernetes client unavailable
- Continue testing even if some tests fail
- Report both passed and failed tests
- Advisory tests never block promotion

## Integration with CI/CD

### Test Output
```bash
go test -v -json ./... > test-results.json
```

Produces structured JSON for CI parsing:
```json
{
  "Time": "2025-03-24T10:30:00Z",
  "Action": "pass",
  "Package": "tinai-forge/tests/forgejo",
  "Test": "TestForgejoHealthEndpoint",
  "Elapsed": 0.523
}
```

### Exit Codes
- `0`: All blocking tests passed
- `1`: At least one blocking test failed
- `2`: Setup/infrastructure error

### Coverage Report
```bash
make coverage  # Generates coverage.html
```

## Common Issues

### Tests timeout
- Increase `TIMEOUT`: `make test-forgejo TIMEOUT=600s`
- Check pod resources (CPU/memory)
- Verify cluster network connectivity

### Pod fails to start
- Check image exists and is pullable
- Review pod logs: `kubectl logs -n tinai-forge-test <pod-name>`
- Verify image configuration (ports, env vars)

### API endpoints not responding
- Wait 30-60s after pod becomes Ready
- Database migrations may still be running
- Check pod logs for initialization errors

### Branding tests fail
- Verify theme/CSS files are in image
- Check Dockerfile includes branding assets
- Ensure config mounts custom branding

## Extending CTS

### Adding a New Product

1. Create product directory: `mkdir xyzapp`
2. Add test files: `xyzapp/smoke_test.go`, `xyzapp/branding_test.go`
3. Use common helpers: `import "tinai-forge/tests/common"`
4. Add Makefile target: `test-xyzapp`

### Adding a New Test

```go
func TestNewFeature(t *testing.T) {
    // Use helper functions from common/
    pod := "xyzapp-test"
    namespace := "tinai-forge-test"

    // Test logic
    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Get("http://service:8080/endpoint")

    if err != nil || resp.StatusCode != 200 {
        t.Errorf("Feature check failed")
    }
}
```

### Test Best Practices

1. **Naming**: `TestFeatureName(t *testing.T)`
2. **Isolation**: Each test is independent
3. **Cleanup**: Use `t.Cleanup()` or defer
4. **Timeouts**: All HTTP clients have 10s timeout
5. **Logging**: Use `t.Logf()` for debugging
6. **Skipping**: Use `t.Skip()` if environment doesn't support test

## Performance Targets

| Category | Count | Duration | CI Time |
|----------|-------|----------|---------|
| Smoke | 8-15 | 30-60s | 1m |
| Branding | 15-20 | 30-60s | 1m |
| Functional | 10-15 | 60-120s | 2m |
| Security | 10-15 | 60-90s | 2m |
| **Total** | **50-60** | **180-330s** | **6-7m** |

## References

- **Kubernetes Client**: `k8s.io/client-go` - Kubernetes API
- **Logging**: `go.uber.org/zap` - Structured logging
- **Testing**: `testing` - Go standard library
- **HTTP**: `net/http` - Go standard library
