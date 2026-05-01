package config

import "os"

type Config struct {
	Port               string
	WebhookSecret      string
	BuildNamespace     string
	StagingNamespace   string
	ProdNamespace      string
	RegistryHost       string
	ForgejoExternalURL string
	ForgejoInternalURL string
	AppsDomain         string
	CertIssuer         string

	// ScanEnabled controls whether Trivy vulnerability scanning runs after each
	// Kaniko build. Set SCAN_ENABLED=false to disable in dev/test environments.
	ScanEnabled bool

	// Tenant namespace template — %s is replaced with the tenant ID.
	// Default: "tinai-tenant-%s"
	TenantNamespaceTemplate string

	// Region-aware namespace configuration
	DefaultRegion  string // "IN", "QA", "AE"
	IndiaStagingNS string // mirrors StagingNamespace
	IndiaProdNS    string // mirrors ProdNamespace
	QatarStagingNS string // tinai-staging-qa
	QatarProdNS    string // tinai-prod-qa
	UAEStagingNS   string // tinai-staging-ae
	UAEProdNS      string // tinai-prod-ae
}

func Load() Config {
	stagingNS := getEnv("STAGING_NAMESPACE", "tinai-staging")
	prodNS := getEnv("PROD_NAMESPACE", "tinai-prod")
	return Config{
		Port:               getEnv("PORT", "8080"),
		ScanEnabled:        getBoolEnv("SCAN_ENABLED", true),
		WebhookSecret:      getEnv("WEBHOOK_SECRET", ""),
		BuildNamespace:     getEnv("BUILD_NAMESPACE", "tinai-build"),
		StagingNamespace:   stagingNS,
		ProdNamespace:      prodNS,
		RegistryHost:       getEnv("REGISTRY_HOST", "forgejo-http.forgejo.svc.cluster.local:3000"),
		ForgejoExternalURL: getEnv("FORGEJO_EXTERNAL_URL", ""),
		ForgejoInternalURL: getEnv("FORGEJO_INTERNAL_URL", "http://forgejo-http.forgejo.svc.cluster.local:3000"),
		AppsDomain:         getEnv("APPS_DOMAIN", "apps.tinai.cloud"),
		CertIssuer:         getEnv("CERT_ISSUER", "letsencrypt-prod"),

		TenantNamespaceTemplate: getEnv("TENANT_NS_TEMPLATE", "tinai-tenant-%s"),

		DefaultRegion:  getEnv("DEFAULT_REGION", "IN"),
		IndiaStagingNS: stagingNS,
		IndiaProdNS:    prodNS,
		QatarStagingNS: getEnv("QATAR_STAGING_NS", "tinai-staging-qa"),
		QatarProdNS:    getEnv("QATAR_PROD_NS", "tinai-prod-qa"),
		UAEStagingNS:   getEnv("UAE_STAGING_NS", "tinai-staging-ae"),
		UAEProdNS:      getEnv("UAE_PROD_NS", "tinai-prod-ae"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getBoolEnv returns the boolean value of an environment variable.
// If the variable is unset or empty the fallback is used.
// Recognised truthy values: "1", "true", "yes" (case-insensitive).
func getBoolEnv(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	switch v {
	case "1", "true", "True", "TRUE", "yes", "Yes", "YES":
		return true
	default:
		return false
	}
}
