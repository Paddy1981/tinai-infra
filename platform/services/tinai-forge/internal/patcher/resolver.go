package patcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PatchConflict describes a conflict between patches and upstream changes
type PatchConflict struct {
	Product      string
	PatchFile    string
	UpstreamFile string
	ConflictType string // "file_moved", "file_deleted", "content_changed"
	Diff         string
}

// ConflictResolver detects conflicts between patches and new upstream versions
type ConflictResolver struct {
	product       string
	patchesDir    string
	upstreamRef   string
}

// NewConflictResolver creates a new conflict resolver
func NewConflictResolver(product, patchesDir, upstreamRef string) *ConflictResolver {
	return &ConflictResolver{
		product:     product,
		patchesDir:  patchesDir,
		upstreamRef: upstreamRef,
	}
}

// DetectConflicts compares patch file paths against new upstream image
func (cr *ConflictResolver) DetectConflicts() ([]PatchConflict, error) {
	var conflicts []PatchConflict

	// Get list of patch files
	patchFiles, err := getPatchFilesList(cr.patchesDir)
	if err != nil {
		return nil, fmt.Errorf("failed to get patch files: %w", err)
	}

	// For each patch file, check if corresponding upstream file exists
	// In production, this would extract the upstream image and check file existence
	for _, patchFile := range patchFiles {
		// Map patch file to expected upstream location
		upstreamPath := mapPatchToUpstream(cr.product, patchFile)

		// Check common conflict scenarios
		conflict := detectConflict(cr.product, patchFile, upstreamPath)
		if conflict != nil {
			conflicts = append(conflicts, *conflict)
		}
	}

	return conflicts, nil
}

// getPatchFilesList returns all patch files in a directory
func getPatchFilesList(patchesDir string) ([]string, error) {
	var files []string

	err := filepath.Walk(patchesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, _ := filepath.Rel(patchesDir, path)
			files = append(files, rel)
		}
		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to walk patches directory: %w", err)
	}

	return files, nil
}

// mapPatchToUpstream maps a patch file path to the expected upstream location
func mapPatchToUpstream(product, patchFile string) string {
	// Remove product prefix from path
	path := strings.TrimPrefix(patchFile, product+"/")

	// Map common directories
	switch {
	case strings.Contains(path, "templates/"):
		switch product {
		case "forgejo", "gitea":
			return "/data/gitea/templates/" + strings.TrimPrefix(path, "templates/")
		case "grafana":
			return "/usr/share/grafana/public/" + strings.TrimPrefix(path, "templates/")
		}
	case strings.Contains(path, "public/"):
		switch product {
		case "forgejo", "gitea":
			return "/data/gitea/public/" + strings.TrimPrefix(path, "public/")
		case "grafana":
			return "/usr/share/grafana/public/" + strings.TrimPrefix(path, "public/")
		}
	case strings.Contains(path, "provisioning/"):
		return "/etc/grafana/provisioning/" + strings.TrimPrefix(path, "provisioning/")
	}

	return path
}

// detectConflict checks for conflicts with a single patch file
func detectConflict(product, patchFile, upstreamPath string) *PatchConflict {
	// In production, this would:
	// 1. Extract the upstream image
	// 2. Check if the file exists
	// 3. Compare content with the patch
	// 4. Detect moves/renames
	// 5. Report conflicts

	// For now, return nil (no conflicts detected)
	// This is a placeholder for the actual implementation

	return nil
}

// AnalyzeConflicts categorizes conflicts by severity
func AnalyzeConflicts(conflicts []PatchConflict) map[string][]PatchConflict {
	categories := make(map[string][]PatchConflict)

	for _, conflict := range conflicts {
		categories[conflict.ConflictType] = append(categories[conflict.ConflictType], conflict)
	}

	return categories
}
