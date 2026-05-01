package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var deployBranch string
var deployRepo string
var deployEnv string

var appsDeployCmd = &cobra.Command{
	Use:   "deploy <app-name>",
	Short: "Deploy an app to a specific environment",
	Long: `Deploy an app to a specific environment.

Examples:
  tinai apps deploy myapp --env production --branch main
  tinai apps deploy myapp --env staging --branch staging
  tinai apps deploy myapp --env development --branch feature/xyz`,
	Args: cobra.ExactArgs(1),
	RunE: runDeploy,
}

func init() {
	appsDeployCmd.Flags().StringVar(&deployBranch, "branch", "main", "Branch to deploy")
	appsDeployCmd.Flags().StringVar(&deployRepo, "repo", "", "Repository URL (optional override)")
	appsDeployCmd.Flags().StringVar(&deployEnv, "env", "production", "Target environment (production, staging, development)")
	appsCmd.AddCommand(appsDeployCmd)
}

// validEnvironments is the set of recognised deployment targets.
var validEnvironments = map[string]bool{
	"production":  true,
	"staging":     true,
	"development": true,
}

func runDeploy(_ *cobra.Command, args []string) error {
	app := args[0]

	// Validate environment
	if !validEnvironments[deployEnv] {
		return fmt.Errorf("invalid environment %q: must be one of production, staging, development", deployEnv)
	}

	fmt.Printf("Deploying %s to %s (branch: %s)\n", app, deployEnv, deployBranch)

	// Build request payload
	payload := map[string]string{
		"branch":      deployBranch,
		"environment": deployEnv,
	}
	if deployRepo != "" {
		payload["repo"] = deployRepo
	}
	body, _ := json.Marshal(payload)

	// Phase 1: submit deploy request
	fmt.Print("  → Submitting deploy request...")
	resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/deploy", body)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("deploy request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	io.Copy(io.Discard, resp.Body)
	fmt.Println(" done")

	// Phase 2: poll for build & deploy completion
	start := time.Now()
	timeout := 5 * time.Minute
	interval := 3 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	phase := "building"
	fmt.Printf("  → Building...")

	for {
		select {
		case <-ticker.C:
			elapsed := time.Since(start).Round(time.Second)

			status, appURL, lastLog, err := fetchDeployStatus(app, deployEnv)
			if err != nil {
				// transient network error — keep waiting
				continue
			}

			switch status {
			case "building":
				if phase != "building" {
					phase = "building"
					fmt.Printf("\n  → Building...")
				}
				fmt.Printf("\r  → Building... %s", elapsed)

			case "deploying":
				if phase != "deploying" {
					if phase == "building" {
						fmt.Printf("\r  → Building... done (%s)\n", elapsed)
					}
					phase = "deploying"
					fmt.Printf("  → Deploying...")
				}
				fmt.Printf("\r  → Deploying... %s", elapsed)

			case "running":
				if phase == "building" {
					fmt.Printf("\r  → Building... done (%s)\n", elapsed)
					fmt.Printf("  → Deploying... done\n")
				} else if phase == "deploying" {
					fmt.Printf("\r  → Deploying... done (%s)\n", elapsed)
				}
				fmt.Printf("  → Live!\n\n")
				fmt.Printf("✓ Deployed %s to %s in %s\n", app, deployEnv, elapsed)
				if appURL != "" {
					fmt.Printf("  URL: %s\n", appURL)
				} else {
					fmt.Printf("  URL: %s\n", defaultAppURL(app, deployEnv))
				}
				return nil

			case "failed":
				fmt.Println()
				msg := fmt.Sprintf("✗ Deploy of %s to %s failed", app, deployEnv)
				if lastLog != "" {
					msg += ": " + lastLog
				}
				return fmt.Errorf("%s", msg)
			default:
				// unknown status, keep polling
				fmt.Printf("\r  → %s... %s", status, elapsed)
			}

			if time.Since(start) >= timeout {
				fmt.Println()
				return fmt.Errorf("deploy timed out after %s", timeout)
			}
		}
	}
}

// fetchDeployStatus polls GET /api/v1/apps/{app}?env={env} and returns
// (status, url, lastLog, err).
func fetchDeployStatus(app, env string) (status, appURL, lastLog string, err error) {
	u := fmt.Sprintf("%s/api/v1/apps/%s?env=%s", apiURL, url.PathEscape(app), url.QueryEscape(env))
	resp, err := doRequest("GET", u, nil)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", "", "", fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var info struct {
		Status  string `json:"status"`
		URL     string `json:"url"`
		LastLog string `json:"last_log"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", "", "", err
	}
	return info.Status, info.URL, info.LastLog, nil
}

// defaultAppURL returns the conventional URL for an app in a given environment
// when the API does not provide one.
func defaultAppURL(app, env string) string {
	switch env {
	case "production":
		return fmt.Sprintf("https://%s.laruneng.com", app)
	case "staging":
		return fmt.Sprintf("https://staging-%s.tinai.cloud", app)
	case "development":
		return fmt.Sprintf("https://dev-%s.tinai.cloud", app)
	default:
		return fmt.Sprintf("https://%s-%s.tinai.cloud", env, app)
	}
}
