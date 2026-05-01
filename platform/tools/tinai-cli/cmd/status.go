package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/spf13/cobra"
)

var statusJSON bool

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show platform health summary",
	Args:  cobra.NoArgs,
	RunE:  runStatus,
}

func init() {
	statusCmd.Flags().BoolVar(&statusJSON, "json", false, "Output raw JSON object")
}

func runStatus(_ *cobra.Command, _ []string) error {
	// --- healthz ---
	start := time.Now()
	healthResp, err := doRequest("GET", apiURL+"/healthz", nil)
	elapsed := time.Since(start)
	apiStatus := "healthy"
	apiStatusIcon := "✓"
	if err != nil || healthResp == nil {
		apiStatus = "unreachable"
		apiStatusIcon = "✗"
	} else {
		healthResp.Body.Close()
		if healthResp.StatusCode != http.StatusOK {
			apiStatus = fmt.Sprintf("status %d", healthResp.StatusCode)
			apiStatusIcon = "✗"
		}
	}

	// --- apps ---
	type appDep struct {
		Status       string `json:"status"`
		ReadyReplicas int32 `json:"ready_replicas"`
		Replicas     int32  `json:"replicas"`
	}
	type app struct {
		Name       string  `json:"name"`
		Deployment *appDep `json:"deployment"`
	}
	var apps []app
	appsResp, err := doRequest("GET", apiURL+"/api/v1/apps", nil)
	if err == nil {
		defer appsResp.Body.Close()
		json.NewDecoder(appsResp.Body).Decode(&apps)
	}

	running, deploying, failed := 0, 0, 0
	for _, a := range apps {
		if a.Deployment == nil {
			failed++
		} else if a.Deployment.Status == "running" {
			running++
		} else {
			deploying++
		}
	}

	// --- usage ---
	type usageEntry struct {
		AppName string  `json:"app_name"`
		CPU     float64 `json:"cpu_cores"`
		Memory  string  `json:"memory"`
	}
	var usage struct {
		Apps       []usageEntry `json:"apps"`
		BuildJobs  int          `json:"active_build_jobs"`
		Region     string       `json:"region"`
		RegionName string       `json:"region_name"`
	}
	usageResp, err := doRequest("GET", apiURL+"/api/v1/billing/usage/current", nil)
	if err == nil {
		defer usageResp.Body.Close()
		if usageResp.StatusCode == http.StatusOK {
			json.NewDecoder(usageResp.Body).Decode(&usage)
		} else {
			io.Copy(io.Discard, usageResp.Body)
		}
	}

	region := usage.Region
	if region == "" {
		region = "IN"
	}
	regionName := usage.RegionName
	if regionName == "" {
		regionName = "Delhi-NCR, E2E Networks"
	}

	// --- JSON output ---
	if statusJSON {
		out := map[string]interface{}{
			"api_status":       apiStatus,
			"api_latency_ms":   elapsed.Milliseconds(),
			"apps_running":     running,
			"apps_deploying":   deploying,
			"apps_failed":      failed,
			"active_build_jobs": usage.BuildJobs,
			"region":           region,
			"region_name":      regionName,
			"resource_usage":   usage.Apps,
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return nil
	}

	// --- human-readable output ---
	fmt.Println("TINAI PLATFORM STATUS")
	fmt.Println("=====================")
	fmt.Printf("API          %s %s    (%dms)\n", apiStatusIcon, apiStatus, elapsed.Milliseconds())
	fmt.Printf("Apps         %d running, %d deploying, %d failed\n", running, deploying, failed)
	fmt.Printf("Build Jobs   %d active\n", usage.BuildJobs)
	fmt.Printf("Region       %s (%s)\n", region, regionName)

	if len(usage.Apps) > 0 {
		fmt.Println()
		fmt.Println("RESOURCE USAGE (last 1h)")
		fmt.Printf("%-24s %-14s %s\n", "App", "CPU (cores)", "Memory")
		fmt.Printf("%-24s %-14s %s\n", "---", "----------", "------")
		for _, u := range usage.Apps {
			fmt.Printf("%-24s %-14.4f %s\n", u.AppName, u.CPU, u.Memory)
		}
	}

	return nil
}
