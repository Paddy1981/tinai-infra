// Package router decides which model and provider to use for a given request,
// applying tenant preferences and quota-based fallback logic.
package router

import (
	"context"
	"log"

	"github.com/tinai/tinai-gateway/internal/models"
)

const (
	defaultModel          = "claude-haiku-4-5"  // cheapest non-free model
	fallbackModel         = "llama3:8b"         // free self-hosted fallback when quota exceeded
	defaultSovereignModel = "sarvam-vikram-8b"  // cheapest sovereign model
)

// QuotaChecker is the minimal interface the router needs to inspect quotas.
type QuotaChecker interface {
	CheckQuota(ctx context.Context, tenantID string) (allowed bool, remainingPaise int64, err error)
	PreferredModel(ctx context.Context, tenantID string) (modelID string, fallback string, err error)
}

// Decision is the result of routing a request.
type Decision struct {
	Model          models.Model
	QuotaExceeded  bool
	FallbackReason string
	SovereignOnly  bool // true when this decision was produced by RouteSovereign
}

// Route selects the best model for tenantID given the requested modelID.
//
// Priority order:
//  1. If tenant quota is exceeded  → force fallbackModel (llama3:8b, free).
//  2. If modelID is provided and known → use it.
//  3. If tenant has a stored preference → use that.
//  4. Otherwise fall back to defaultModel.
func Route(ctx context.Context, requestedModel, tenantID string, qc QuotaChecker) Decision {
	// 1. Check quota first — overrides everything.
	if tenantID != "" && qc != nil {
		allowed, remaining, err := qc.CheckQuota(ctx, tenantID)
		if err != nil {
			log.Printf("router: quota check error for tenant %s: %v — allowing request", tenantID, err)
		} else if !allowed {
			fb, ok := models.Lookup(fallbackModel)
			if !ok {
				// Registry misconfiguration — should never happen.
				log.Printf("router: fallback model %q not found in registry", fallbackModel)
			}
			return Decision{
				Model:          fb,
				QuotaExceeded:  true,
				FallbackReason: "quota_exceeded",
			}
		} else {
			_ = remaining // could log or surface this in response headers
		}
	}

	// 2. Requested model (from request body).
	if requestedModel != "" {
		if m, ok := models.Lookup(requestedModel); ok && m.Available {
			return Decision{Model: m}
		}
		log.Printf("router: requested model %q not found or unavailable, falling back", requestedModel)
	}

	// 3. Tenant preference stored in DB.
	if tenantID != "" && qc != nil {
		preferred, _, err := qc.PreferredModel(ctx, tenantID)
		if err == nil && preferred != "" {
			if m, ok := models.Lookup(preferred); ok && m.Available {
				return Decision{Model: m, FallbackReason: "tenant_preference"}
			}
		}
	}

	// 4. Hard default.
	def, ok := models.Lookup(defaultModel)
	if !ok {
		// Absolute last resort: first available model.
		for _, m := range models.Registry {
			if m.Available {
				return Decision{Model: m, FallbackReason: "registry_first"}
			}
		}
	}
	return Decision{Model: def, FallbackReason: "default"}
}

// RouteSovereign is like Route but restricts model selection to Indian sovereign models only.
//
// Priority order:
//  1. If tenant quota is exceeded → force defaultSovereignModel (sarvam-vikram-8b, cheapest sovereign).
//  2. If requestedModel is provided and is sovereign → use it.
//  3. If requestedModel is provided but NOT sovereign → log and fall back to defaultSovereignModel.
//  4. Otherwise fall back to defaultSovereignModel.
func RouteSovereign(ctx context.Context, requestedModel, tenantID string, qc QuotaChecker) Decision {
	sovereignFallback := func(reason string) Decision {
		m, ok := models.Lookup(defaultSovereignModel)
		if !ok {
			// Registry misconfiguration — pick first available sovereign model.
			for _, sm := range models.SovereignModels() {
				if sm.Available {
					return Decision{Model: sm, FallbackReason: "sovereign_registry_first", SovereignOnly: true}
				}
			}
		}
		return Decision{Model: m, FallbackReason: reason, SovereignOnly: true}
	}

	// 1. Check quota first — overrides everything.
	if tenantID != "" && qc != nil {
		allowed, remaining, err := qc.CheckQuota(ctx, tenantID)
		if err != nil {
			log.Printf("router/sovereign: quota check error for tenant %s: %v — allowing request", tenantID, err)
		} else if !allowed {
			_ = remaining
			d := sovereignFallback("quota_exceeded")
			d.QuotaExceeded = true
			return d
		} else {
			_ = remaining
		}
	}

	// 2. Requested model — must be sovereign.
	if requestedModel != "" {
		m, ok := models.Lookup(requestedModel)
		if ok && m.Available && m.Sovereign {
			return Decision{Model: m, SovereignOnly: true}
		}
		if ok && !m.Sovereign {
			log.Printf("router/sovereign: requested model %q is not sovereign, falling back to %s", requestedModel, defaultSovereignModel)
		} else {
			log.Printf("router/sovereign: requested model %q not found or unavailable, falling back to %s", requestedModel, defaultSovereignModel)
		}
	}

	// 3 & 4. Default sovereign model.
	return sovereignFallback("default_sovereign")
}
