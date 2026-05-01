.PHONY: test-all test-forgejo test-grafana test-woodpecker test-smoke test-branding test-functional test-security deps clean help

# Help target
help:
	@echo "TinAI CTS Test Suite"
	@echo ""
	@echo "Usage: make [target] [options]"
	@echo ""
	@echo "Targets:"
	@echo "  test-all           - Run all tests for all products (full suite)"
	@echo "  test-forgejo       - Run all Forgejo tests"
	@echo "  test-grafana       - Run all Grafana tests"
	@echo "  test-woodpecker    - Run all Woodpecker tests"
	@echo "  test-smoke         - Run only smoke tests (fast, ~30s)"
	@echo "  test-branding      - Run only branding tests"
	@echo "  test-functional    - Run only functional tests"
	@echo "  test-security      - Run only security tests"
	@echo "  deps               - Install/update test dependencies"
	@echo "  clean              - Clean test artifacts"
	@echo ""
	@echo "Options:"
	@echo "  IMAGE=<image>      - Docker image to test (required for product-specific tests)"
	@echo "  TIMEOUT=<duration> - Test timeout (default: 300s for product tests, 60s for category tests)"
	@echo "  VERBOSE=1          - Enable verbose output"
	@echo ""
	@echo "Examples:"
	@echo "  make test-forgejo IMAGE=registry.e2enetworks.net/tinai/tinai-repos:1.22.7-tinai"
	@echo "  make test-smoke TIMEOUT=120s"
	@echo "  make test-all VERBOSE=1"

# Run all tests for a specific product and image
# Usage: make test-forgejo IMAGE=registry.e2enetworks.net/tinai/tinai-repos:1.22.7-tinai
test-forgejo:
	@if [ -z "$(IMAGE)" ]; then \
		echo "ERROR: IMAGE is required"; \
		echo "Usage: make test-forgejo IMAGE=<image>"; \
		exit 1; \
	fi
	@echo "Running Forgejo tests with image: $(IMAGE)"
	go test -v -timeout $(TIMEOUT) ./forgejo/... -args -image=$(IMAGE)

test-grafana:
	@if [ -z "$(IMAGE)" ]; then \
		echo "ERROR: IMAGE is required"; \
		echo "Usage: make test-grafana IMAGE=<image>"; \
		exit 1; \
	fi
	@echo "Running Grafana tests with image: $(IMAGE)"
	go test -v -timeout $(TIMEOUT) ./grafana/... -args -image=$(IMAGE)

test-woodpecker:
	@if [ -z "$(IMAGE)" ]; then \
		echo "ERROR: IMAGE is required"; \
		echo "Usage: make test-woodpecker IMAGE=<image>"; \
		exit 1; \
	fi
	@echo "Running Woodpecker tests with image: $(IMAGE)"
	go test -v -timeout $(TIMEOUT) ./woodpecker/... -args -image=$(IMAGE)

# Run only smoke tests (fast, < 30s)
# Smoke tests verify basic functionality: container starts, health endpoints respond
test-smoke:
	@echo "Running smoke tests..."
	go test -v -short -run "^TestSmoke|^Test.*Starts|^Test.*Health|^Test.*ContainerStarts|^Test.*HealthEndpoint" \
		-timeout $(or $(TIMEOUT),60s) ./...

# Run only branding tests
# Branding tests verify TinAI branding is applied and upstream branding is hidden
test-branding:
	@echo "Running branding tests..."
	go test -v -run "^TestBranding|^Test.*Brand|^Test.*TinAI|^Test.*NoForgejo|^Test.*Customized|^Test.*Title|^Test.*Logo|^Test.*Theme|^Test.*UpstreamBranding|^Test.*NoUpstream|^Test.*Custom" \
		-timeout $(or $(TIMEOUT),60s) ./...

# Run only functional tests
# Functional tests verify core product features work
test-functional:
	@echo "Running functional tests..."
	go test -v -run "^TestAPI|^TestRepository|^Test.*Upload|^Test.*Clone|^Test.*OAuth|^Test.*Webhook|^Test.*Pagination|^Test.*ErrorHandling" \
		-timeout $(or $(TIMEOUT),120s) ./...

# Run only security tests
# Security tests verify default credentials don't work, headers are set, etc.
test-security:
	@echo "Running security tests..."
	go test -v -run "^TestSecurity|^TestNo|^TestXSS|^TestHTTPS|^TestCSRF|^TestPassword|^TestAuthentication|^TestSQL|^TestCookie|^TestRate|^TestVersion" \
		-timeout $(or $(TIMEOUT),90s) ./...

# Full test suite with JSON output for CI
# Generates test-results.json for CI/CD pipelines
test-all:
	@echo "Running full test suite..."
	@mkdir -p ./results
	go test -v -json -timeout $(or $(TIMEOUT),600s) ./... 2>&1 | tee ./results/test-results.json
	@echo ""
	@echo "Test results saved to: ./results/test-results.json"

# Install test dependencies
deps:
	@echo "Installing test dependencies..."
	go mod tidy
	go mod download
	@echo "Dependencies installed"

# Run tests and generate coverage report
coverage:
	@echo "Running tests with coverage..."
	@mkdir -p ./results
	go test -v -cover -coverprofile=./results/coverage.out -timeout 600s ./...
	go tool cover -html=./results/coverage.out -o ./results/coverage.html
	@echo "Coverage report generated: ./results/coverage.html"

# Run tests in short mode (skip long-running tests)
short:
	@echo "Running short test suite..."
	go test -v -short -timeout 120s ./...

# Clean test artifacts
clean:
	@echo "Cleaning test artifacts..."
	rm -rf ./results
	go clean -testcache
	@echo "Clean complete"

# Run linter (requires golangci-lint)
lint:
	@echo "Running linters..."
	golangci-lint run ./...

# Run only tests for debugging (verbose, stop on first failure)
debug:
	@echo "Running tests in debug mode..."
	go test -v -race -failfast ./forgejo/...

# Format test code
fmt:
	@echo "Formatting code..."
	go fmt ./...
	goimports -w .

# Run tests and generate test report
report: test-all
	@echo ""
	@echo "=== Test Report ==="
	@jq '.Summary' ./results/test-results.json || echo "Could not parse test results"

.DEFAULT_GOAL := help
