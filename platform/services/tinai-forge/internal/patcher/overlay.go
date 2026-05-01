package patcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PatchOverlay applies TinAI brand patches on top of upstream Docker image
type PatchOverlay struct {
	Product     string
	PatchesDir  string
	UpstreamRef string
	OutputTag   string
}

// BuildDockerfile generates a Dockerfile that applies patches
func (p *PatchOverlay) BuildDockerfile() (string, error) {
	// Validate patches directory exists
	if _, err := os.Stat(p.PatchesDir); err != nil {
		return "", fmt.Errorf("patches directory not accessible: %w", err)
	}

	var dockerfile strings.Builder

	// Start with upstream image
	dockerfile.WriteString(fmt.Sprintf("FROM %s\n\n", p.UpstreamRef))

	// Add metadata
	dockerfile.WriteString(fmt.Sprintf("LABEL tinai.product=\"%s\" tinai.patched=\"true\"\n\n", p.Product))

	// Copy patch directories based on product
	switch p.Product {
	case "forgejo", "gitea":
		// For Forgejo/Gitea: copy templates and public assets
		dockerfile.WriteString("COPY patches/forgejo/templates/ /data/gitea/templates/\n")
		dockerfile.WriteString("COPY patches/forgejo/public/ /data/gitea/public/\n")
		dockerfile.WriteString("ENV GITEA_CUSTOM=/data/gitea\n\n")

	case "grafana":
		// For Grafana: copy dashboards and plugins
		dockerfile.WriteString("COPY patches/grafana/provisioning/ /etc/grafana/provisioning/\n")
		dockerfile.WriteString("COPY patches/grafana/public/ /usr/share/grafana/public/\n\n")

	case "prometheus":
		// For Prometheus: copy config templates
		dockerfile.WriteString("COPY patches/prometheus/rules/ /etc/prometheus/rules/\n")
		dockerfile.WriteString("COPY patches/prometheus/prometheus.yml /etc/prometheus/prometheus.yml\n\n")

	default:
		// Generic approach: copy all patches
		dockerfile.WriteString(fmt.Sprintf("COPY patches/%s/ /patches/%s/\n", p.Product, p.Product))
		dockerfile.WriteString(fmt.Sprintf("RUN if [ -f /patches/%s/apply.sh ]; then bash /patches/%s/apply.sh; fi\n\n", p.Product, p.Product))
	}

	// Add TinAI branding hook (runs on container start if needed)
	dockerfile.WriteString("# TinAI custom branding applied\n")
	dockerfile.WriteString("RUN echo 'TinAI Forge patched at " + p.UpstreamRef + "' > /tinai-patch-info\n")

	return dockerfile.String(), nil
}

// Apply triggers a Kaniko build job in the cluster
func (p *PatchOverlay) Apply() error {
	// Generate Dockerfile
	dockerfileContent, err := p.BuildDockerfile()
	if err != nil {
		return fmt.Errorf("failed to build dockerfile: %w", err)
	}

	// In production, this would:
	// 1. Create a temporary directory
	// 2. Write the Dockerfile
	// 3. Copy patches directory
	// 4. Submit a Kaniko build job to the cluster
	// 5. Monitor the job until completion

	// For now, validate the content is reasonable
	if len(dockerfileContent) == 0 {
		return fmt.Errorf("generated dockerfile is empty")
	}

	return nil
}

// GetPatchFiles returns list of all patch files for a product
func (p *PatchOverlay) GetPatchFiles() ([]string, error) {
	var files []string

	err := filepath.Walk(p.PatchesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, _ := filepath.Rel(p.PatchesDir, path)
			files = append(files, rel)
		}
		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to walk patches directory: %w", err)
	}

	return files, nil
}
