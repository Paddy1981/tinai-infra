package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds the application configuration
type Config struct {
	// Database
	DatabaseURL string

	// Kubernetes
	KubeNamespace  string
	TestNamespace  string
	KubeconfigPath string

	// Registry
	RegistryHost    string
	RegistryProject string

	// GitHub
	GitHubToken string

	// Prometheus
	PrometheusURL string

	// Watcher
	CheckIntervalHours int
	AutoBuildPatch     bool
	AutoBuildMinor     bool

	// API
	APIPort int
	APIKey  string

	// TinAI API (callbacks)
	TinAIAPIURL string
	TinAIAPIKey string
}

// Load loads configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{
		// Set defaults
		KubeNamespace:      getEnv("FORGE_KUBE_NAMESPACE", "tinai-forge"),
		TestNamespace:      getEnv("FORGE_TEST_NAMESPACE", "tinai-forge-test"),
		KubeconfigPath:     getEnv("KUBECONFIG", ""),
		RegistryHost:       getEnv("FORGE_REGISTRY_HOST", "registry.e2enetworks.net"),
		RegistryProject:    getEnv("FORGE_REGISTRY_PROJECT", "tinai"),
		GitHubToken:        getEnv("FORGE_GITHUB_TOKEN", ""),
		PrometheusURL:      getEnv("FORGE_PROMETHEUS_URL", "http://kube-prometheus-stack-prometheus.monitoring:9090"),
		CheckIntervalHours: getEnvInt("FORGE_CHECK_INTERVAL_HOURS", 6),
		AutoBuildPatch:     getEnvBool("FORGE_AUTO_BUILD_PATCH", true),
		AutoBuildMinor:     getEnvBool("FORGE_AUTO_BUILD_MINOR", false),
		APIPort:            getEnvInt("FORGE_API_PORT", 8090),
		APIKey:             getEnv("FORGE_API_KEY", ""),
		TinAIAPIURL:        getEnv("TINAI_API_URL", ""),
		TinAIAPIKey:        getEnv("FORGE_API_KEY", ""),
	}

	// Database URL is required
	cfg.DatabaseURL = os.Getenv("FORGE_DB_URL")
	if cfg.DatabaseURL == "" {
		// Try common PostgreSQL env vars
		user := getEnv("PGUSER", "forge")
		password := getEnv("PGPASSWORD", "")
		host := getEnv("PGHOST", "localhost")
		port := getEnv("PGPORT", "5432")
		dbname := getEnv("PGDATABASE", "tinai_forge")

		if password != "" {
			cfg.DatabaseURL = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
				user, password, host, port, dbname)
		} else {
			cfg.DatabaseURL = fmt.Sprintf("postgres://%s@%s:%s/%s?sslmode=disable",
				user, host, port, dbname)
		}
	}

	return cfg, nil
}

// Validate validates the configuration
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("database URL not configured (FORGE_DB_URL)")
	}

	if c.RegistryHost == "" {
		return fmt.Errorf("registry host not configured (FORGE_REGISTRY_HOST)")
	}

	if c.APIPort <= 0 || c.APIPort > 65535 {
		return fmt.Errorf("invalid API port: %d", c.APIPort)
	}

	if c.APIKey == "" {
		return fmt.Errorf("API key not configured (FORGE_API_KEY is required)")
	}

	return nil
}

// Helper functions
func getEnv(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value, exists := os.LookupEnv(key); exists {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value, exists := os.LookupEnv(key); exists {
		return value == "true" || value == "1" || value == "yes"
	}
	return defaultValue
}
