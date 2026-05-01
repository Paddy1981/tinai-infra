package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

var appsJSON bool

var appsCmd = &cobra.Command{
	Use:   "apps",
	Short: "List deployed apps",
	RunE:  runApps,
}

var promoteFrom string
var promoteTo string

var promoteCmd = &cobra.Command{
	Use:   "promote <app>",
	Short: "Promote app from one environment to another",
	Long: `Promote an app from one environment to another.

Examples:
  tinai apps promote myapp --from staging --to production
  tinai apps promote myapp --from development --to staging`,
	Args: cobra.ExactArgs(1),
	RunE: runPromote,
}

var rollbackCmd = &cobra.Command{
	Use:   "rollback <app>",
	Short: "Roll back app to previous image",
	Args:  cobra.ExactArgs(1),
	RunE:  runRollback,
}

var rollbackProd bool

// appsEnvCmd is a convenience alias: `tinai apps env <app>` shows env vars
// inline without having to remember `tinai env list`.
var appsEnvCmd = &cobra.Command{
	Use:   "env <app>",
	Short: "Show env vars for an app (alias for: tinai env list)",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(args[0])+"/env", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		var data map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if len(data) == 0 {
			fmt.Printf("No env vars set for %s.\n", args[0])
			return nil
		}
		fmt.Printf("Env vars for %s:\n", args[0])
		for k, v := range data {
			fmt.Printf("  %s=%s\n", k, strVal(v))
		}
		return nil
	},
}

var appStatusCmd = &cobra.Command{
	Use:   "status <app>",
	Short: "Show per-environment status for an app",
	Long: `Show the status of an app across all environments.

Example:
  tinai apps status sattrack`,
	Args: cobra.ExactArgs(1),
	RunE: runAppStatus,
}

func init() {
	appsCmd.Flags().BoolVar(&appsJSON, "json", false, "Output raw JSON")
	rollbackCmd.Flags().BoolVar(&rollbackProd, "prod", false, "Roll back prod instead of staging")
	promoteCmd.Flags().StringVar(&promoteFrom, "from", "staging", "Source environment")
	promoteCmd.Flags().StringVar(&promoteTo, "to", "production", "Target environment")
	appsCmd.AddCommand(promoteCmd, rollbackCmd, appsEnvCmd, appStatusCmd)
}

type deploymentInfo struct {
	Image         string `json:"image"`
	Replicas      int32  `json:"replicas"`
	ReadyReplicas int32  `json:"ready_replicas"`
	Status        string `json:"status"`
}

type appInfo struct {
	Name       string          `json:"name"`
	Owner      string          `json:"owner"`
	Region     string          `json:"region"`
	TenantID   string          `json:"tenant_id"`
	Deployment *deploymentInfo `json:"deployment"`
}

func runApps(_ *cobra.Command, _ []string) error {
	resp, err := doRequest("GET", apiURL+"/api/v1/apps", nil)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if appsJSON {
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("read response: %w", err)
		}
		fmt.Println(string(b))
		return nil
	}

	var apps []appInfo
	if err := json.NewDecoder(resp.Body).Decode(&apps); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if len(apps) == 0 {
		fmt.Println("No apps deployed yet.")
		return nil
	}

	fmt.Printf("%-20s %-12s %-8s %s\n", "NAME", "STATUS", "READY", "IMAGE")
	fmt.Printf("%-20s %-12s %-8s %s\n", "----", "------", "-----", "-----")
	for _, app := range apps {
		status := "-"
		ready := "-"
		image := "-"
		if app.Deployment != nil {
			status = app.Deployment.Status
			ready = fmt.Sprintf("%d/%d", app.Deployment.ReadyReplicas, app.Deployment.Replicas)
			image = app.Deployment.Image
		}
		fmt.Printf("%-20s %-12s %-8s %s\n", app.Name, status, ready, image)
	}
	return nil
}

func runPromote(_ *cobra.Command, args []string) error {
	name := args[0]

	// Validate environments
	if !validEnvironments[promoteFrom] {
		return fmt.Errorf("invalid source environment %q: must be one of production, staging, development", promoteFrom)
	}
	if !validEnvironments[promoteTo] {
		return fmt.Errorf("invalid target environment %q: must be one of production, staging, development", promoteTo)
	}
	if promoteFrom == promoteTo {
		return fmt.Errorf("source and target environments must be different")
	}

	fmt.Printf("Promoting %s: %s → %s\n\n", name, promoteFrom, promoteTo)

	// Fetch current images for both environments to show the diff
	srcImage, err := fetchEnvImage(name, promoteFrom)
	if err != nil {
		fmt.Printf("  Warning: could not fetch %s image: %v\n", promoteFrom, err)
	}
	dstImage, err := fetchEnvImage(name, promoteTo)
	if err != nil {
		fmt.Printf("  Warning: could not fetch %s image: %v\n", promoteTo, err)
	}

	if srcImage != "" || dstImage != "" {
		fmt.Println("Image diff:")
		fmt.Printf("  %s (current):  %s\n", promoteTo, valueOrDash(dstImage))
		fmt.Printf("  %s (incoming): %s\n", promoteFrom, valueOrDash(srcImage))
		fmt.Println()
	}

	// Ask for confirmation
	fmt.Printf("Promote %s from %s to %s? [y/N] ", name, promoteFrom, promoteTo)
	var answer string
	fmt.Scanln(&answer)
	answer = strings.TrimSpace(strings.ToLower(answer))
	if answer != "y" && answer != "yes" {
		fmt.Println("Aborted.")
		return nil
	}

	// Send promote request
	payload := map[string]string{
		"from": promoteFrom,
		"to":   promoteTo,
	}
	body, _ := json.Marshal(payload)

	resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(name)+"/promote", body)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("promote failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	fmt.Printf("✓ %s promoted from %s to %s\n", name, promoteFrom, promoteTo)
	return nil
}

// fetchEnvImage retrieves the current image for an app in a given environment.
func fetchEnvImage(app, env string) (string, error) {
	u := fmt.Sprintf("%s/api/v1/apps/%s?env=%s", apiURL, url.PathEscape(app), url.QueryEscape(env))
	resp, err := doRequest("GET", u, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, resp.Body)
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	var info struct {
		Deployment *struct {
			Image string `json:"image"`
		} `json:"deployment"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", err
	}
	if info.Deployment != nil {
		return info.Deployment.Image, nil
	}
	return "", nil
}

func runRollback(_ *cobra.Command, args []string) error {
	name := args[0]
	ns := "staging"
	if rollbackProd {
		ns = "prod"
	}
	body, _ := json.Marshal(map[string]string{"ns": ns})
	resp, err := doRequest("POST",
		fmt.Sprintf("%s/api/v1/apps/%s/rollback?ns=%s", apiURL, url.PathEscape(name), url.QueryEscape(ns)),
		body,
	)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var msg map[string]string
		json.NewDecoder(resp.Body).Decode(&msg)
		return fmt.Errorf("rollback failed: %v", msg)
	}
	fmt.Printf("✓ %s rolled back in %s\n", name, ns)
	return nil
}

// runAppStatus shows per-environment status for a single app.
func runAppStatus(_ *cobra.Command, args []string) error {
	app := args[0]

	// Fetch status for all environments
	type envStatus struct {
		Environment   string `json:"environment"`
		Status        string `json:"status"`
		Replicas      int32  `json:"replicas"`
		ReadyReplicas int32  `json:"ready_replicas"`
		Domain        string `json:"domain"`
	}

	u := fmt.Sprintf("%s/api/v1/apps/%s/status", apiURL, url.PathEscape(app))
	resp, err := doRequest("GET", u, nil)

	var envs []envStatus

	if err == nil && resp.StatusCode == http.StatusOK {
		// API returns per-environment data
		var result struct {
			Name         string      `json:"name"`
			Description  string      `json:"description"`
			Environments []envStatus `json:"environments"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err == nil && len(result.Environments) > 0 {
			envs = result.Environments
			if result.Description != "" {
				fmt.Printf("%s — %s\n", app, result.Description)
			} else {
				fmt.Println(app)
			}
		}
		resp.Body.Close()
	} else {
		if resp != nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}

	// If the dedicated endpoint did not return data, build it from
	// individual per-env queries as a fallback.
	if len(envs) == 0 {
		fmt.Println(app)
		for _, env := range []string{"production", "staging", "development"} {
			es := envStatus{
				Environment: env,
				Status:      "unknown",
				Domain:      defaultAppURL(app, env),
			}
			status, _, _, fetchErr := fetchDeployStatus(app, env)
			if fetchErr == nil && status != "" {
				es.Status = status
			}
			envs = append(envs, es)
		}
	}

	// Assign default domains where missing
	for i := range envs {
		if envs[i].Domain == "" {
			envs[i].Domain = defaultAppDomain(app, envs[i].Environment)
		}
	}

	// Render table
	//
	// ┌─────────────┬──────────┬───────┬─────────────────────────────────┐
	// │ Environment │ Status   │ Ready │ Domain                          │
	// ├─────────────┼──────────┼───────┼─────────────────────────────────┤
	// │ production  │ running  │ 1/1   │ sattrack.laruneng.com           │
	// └─────────────┴──────────┴───────┴─────────────────────────────────┘

	// Calculate column widths
	colEnv, colStatus, colReady, colDomain := 11, 8, 5, 6
	for _, e := range envs {
		if len(e.Environment) > colEnv {
			colEnv = len(e.Environment)
		}
		if len(e.Status) > colStatus {
			colStatus = len(e.Status)
		}
		ready := fmt.Sprintf("%d/%d", e.ReadyReplicas, e.Replicas)
		if len(ready) > colReady {
			colReady = len(ready)
		}
		if len(e.Domain) > colDomain {
			colDomain = len(e.Domain)
		}
	}

	hLine := func(left, mid, right, fill string) string {
		return left +
			strings.Repeat(fill, colEnv+2) + mid +
			strings.Repeat(fill, colStatus+2) + mid +
			strings.Repeat(fill, colReady+2) + mid +
			strings.Repeat(fill, colDomain+2) + right
	}

	fmt.Println(hLine("┌", "┬", "┐", "─"))
	fmt.Printf("│ %-*s │ %-*s │ %-*s │ %-*s │\n", colEnv, "Environment", colStatus, "Status", colReady, "Ready", colDomain, "Domain")
	fmt.Println(hLine("├", "┼", "┤", "─"))
	for _, e := range envs {
		ready := fmt.Sprintf("%d/%d", e.ReadyReplicas, e.Replicas)
		fmt.Printf("│ %-*s │ %-*s │ %-*s │ %-*s │\n", colEnv, e.Environment, colStatus, e.Status, colReady, ready, colDomain, e.Domain)
	}
	fmt.Println(hLine("└", "┴", "┘", "─"))

	return nil
}

// defaultAppDomain returns the conventional domain (no scheme) for an app
// in a given environment.
func defaultAppDomain(app, env string) string {
	switch env {
	case "production":
		return app + ".laruneng.com"
	case "staging":
		return "staging-" + app + ".tinai.cloud"
	case "development":
		return "dev-" + app + ".tinai.cloud"
	default:
		return env + "-" + app + ".tinai.cloud"
	}
}

func valueOrDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func strVal(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
