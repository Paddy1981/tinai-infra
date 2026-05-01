package builder

import (
	"fmt"
)

// Registry manages Docker image tags in container registry
type Registry struct {
	Host    string
	Project string
}

// NewRegistry creates a new registry manager
func NewRegistry(host, project string) *Registry {
	return &Registry{
		Host:    host,
		Project: project,
	}
}

// Tag returns the full image tag for a specific product and version
func (r *Registry) Tag(product, version, patchVersion string) string {
	return fmt.Sprintf("%s/%s/tinai-%s:%s-tinai.%s",
		r.Host,
		r.Project,
		product,
		version,
		patchVersion,
	)
}

// LatestTag returns the latest tag for a product
func (r *Registry) LatestTag(product string) string {
	return fmt.Sprintf("%s/%s/tinai-%s:latest",
		r.Host,
		r.Project,
		product,
	)
}

// BaseRef returns a reference to the upstream image (without TinAI modifications)
func (r *Registry) BaseRef(product, version string) string {
	// This maps to the upstream repository
	switch product {
	case "forgejo":
		return fmt.Sprintf("codeberg.org/forgejo/forgejo:%s", version)
	case "woodpecker":
		return fmt.Sprintf("ghcr.io/woodpecker-ci/woodpecker:%s", version)
	case "grafana":
		return fmt.Sprintf("docker.io/grafana/grafana:%s", version)
	case "prometheus":
		return fmt.Sprintf("docker.io/prom/prometheus:%s", version)
	case "loki":
		return fmt.Sprintf("docker.io/grafana/loki:%s", version)
	case "minio":
		return fmt.Sprintf("docker.io/minio/minio:%s", version)
	case "cloudnativepg":
		return fmt.Sprintf("ghcr.io/cloudnative-pg/cloudnative-pg:%s", version)
	case "cert-manager":
		return fmt.Sprintf("quay.io/jetstack/cert-manager-controller:%s", version)
	case "keda":
		return fmt.Sprintf("ghcr.io/kedacore/keda:%s", version)
	case "knative":
		return fmt.Sprintf("gcr.io/knative-releases/serving/cmd/controller:%s", version)
	case "ingress-nginx":
		return fmt.Sprintf("registry.k8s.io/ingress-nginx/controller:%s", version)
	default:
		return fmt.Sprintf("docker.io/library/%s:%s", product, version)
	}
}

// CacheRef returns the cache repository reference
func (r *Registry) CacheRef(product string) string {
	return fmt.Sprintf("%s/%s/cache/tinai-%s",
		r.Host,
		r.Project,
		product,
	)
}

// GetProductImage returns the full image reference for internal use
func (r *Registry) GetProductImage(product, version, patchVersion string) string {
	if patchVersion == "" || patchVersion == "0" {
		return r.LatestTag(product)
	}
	return r.Tag(product, version, patchVersion)
}
