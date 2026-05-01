# TinAI CTS Quick Start Guide

Get the Compatibility Test Suite running in under 5 minutes.

## Prerequisites

- Go 1.21+ installed
- `kubectl` configured with cluster access
- Docker image built and available

## Installation

```bash
cd /path/to/tinai-forge/tests
go mod download
```

## Running Tests

### Option 1: Fast Smoke Tests (30 seconds)
Verify container starts and basic endpoints respond:

```bash
make test-smoke
```

### Option 2: Test Specific Product
Run all tests (smoke + branding + functional + security) for one product:

```bash
make test-forgejo IMAGE=registry.example.com/forgejo:1.22-tinai
```

Replace `forgejo` with `grafana` or `woodpecker` as needed.

### Option 3: Test by Category
Run tests in a specific category:

```bash
make test-branding    # 60 seconds - TinAI branding validation
make test-functional  # 120 seconds - Feature tests
make test-security    # 90 seconds - Security checks
```

### Option 4: Full Suite
Run everything:

```bash
make test-all IMAGE=registry.example.com/forgejo:1.22-tinai
```

## Interpreting Results

### All Tests Pass
```
PASS
ok      tinai-forge/tests/forgejo       45.321s
```
Image is ready for production.

### Some Tests Fail
```
FAIL
FAIL    tinai-forge/tests/forgejo       45.321s
--- FAIL: TestLoginPageHasTinAIBranding
    branding_test.go:15: Login page does not contain 'TinAI'
```
Review failed test and check image configuration.

### Test Timeout
Increase timeout and retry:
```bash
make test-forgejo IMAGE=... TIMEOUT=600s
```

## Common Issues

### "Cannot reach Grafana" / Connection error
- Pod may still be starting - wait 30-60 seconds
- Check pod status: `kubectl get pods -n tinai-forge-test`
- Check pod logs: `kubectl logs -n tinai-forge-test <pod-name>`

### "Expected 200, got 500"
- Health endpoint not ready yet
- Database migrations still running
- Check logs for initialization errors

### "Login page does not contain 'TinAI'"
- Branding assets not included in image
- Check Dockerfile includes custom theme
- Verify config mounts branding directory

### Timeout waiting for pod
- Increase TIMEOUT: `make test-forgejo TIMEOUT=600s`
- Check node resources: `kubectl top nodes`
- Verify image pull is working: `kubectl describe pod <pod-name>`

## Next Steps

1. **Review test results**: Check which tests passed/failed
2. **Fix failures**: Update image configuration as needed
3. **Run full suite**: `make test-all IMAGE=...`
4. **Promote to production**: If all blocking tests pass
5. **Archive results**: Save test-results.json for audit trail

## More Information

- **Full Documentation**: See `README.md`
- **Makefile Help**: `make help`
- **Coverage Report**: `make coverage`
- **Clean Artifacts**: `make clean`

## Test Categories Explained

| Category | Purpose | Blocks Promotion | Duration |
|----------|---------|------------------|----------|
| **Smoke** | Container starts, basic health | Yes | 30s |
| **Branding** | TinAI branding applied | Yes | 60s |
| **Functional** | Features work | Yes | 120s |
| **Security** | No critical vulns | Yes | 90s |

## Quick Reference

```bash
# Test just one product quickly
make test-forgejo IMAGE=registry.example.com/forgejo:latest

# Test everything
make test-all IMAGE=registry.example.com/forgejo:latest

# Fast check (30 seconds)
make test-smoke

# Just branding validation
make test-branding

# With more verbose output
make test-all IMAGE=... VERBOSE=1

# Generate coverage report
make coverage

# Show all available targets
make help
```

---

**Questions?** Check `README.md` for detailed documentation.
