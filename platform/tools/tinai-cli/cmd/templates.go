package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var templatesCmd = &cobra.Command{
	Use:   "templates",
	Short: "Browse and deploy app templates",
}

var templatesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available deployment templates",
	Args:  cobra.NoArgs,
	RunE: func(_ *cobra.Command, _ []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/templates", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var templates []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&templates); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if len(templates) == 0 {
			fmt.Println("No templates available.")
			return nil
		}

		// Group by category
		byCategory := make(map[string][]struct {
			ID          string
			Name        string
			Description string
		})
		var order []string
		seen := make(map[string]bool)
		for _, t := range templates {
			cat := strings.ToUpper(t.Category)
			if !seen[cat] {
				order = append(order, cat)
				seen[cat] = true
			}
			byCategory[cat] = append(byCategory[cat], struct {
				ID          string
				Name        string
				Description string
			}{t.ID, t.Name, t.Description})
		}

		for _, cat := range order {
			fmt.Printf("%s\n", cat)
			for _, t := range byCategory[cat] {
				fmt.Printf("  %-14s %s\n", t.ID, t.Description)
			}
			fmt.Println()
		}
		return nil
	},
}

var templatesDeployCmd = &cobra.Command{
	Use:   "deploy <id>",
	Short: "Deploy an app from a template",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		templateID := args[0]
		scanner := bufio.NewScanner(os.Stdin)

		// Fetch template details to get required env vars
		resp, err := doRequest("GET", apiURL+"/api/v1/templates/"+url.PathEscape(templateID), nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			return fmt.Errorf("template %q not found", templateID)
		}
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var tmpl struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			EnvVars     []struct {
				Key         string `json:"key"`
				Default     string `json:"default"`
				Description string `json:"description"`
				Required    bool   `json:"required"`
			} `json:"env_vars"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&tmpl); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		fmt.Printf("Deploying template: %s — %s\n\n", tmpl.Name, tmpl.Description)

		// Prompt for app name
		fmt.Print("App name: ")
		scanner.Scan()
		appName := strings.TrimSpace(scanner.Text())
		if appName == "" {
			return fmt.Errorf("app name is required")
		}

		// Prompt for each env var
		envOverrides := make(map[string]string)
		if len(tmpl.EnvVars) > 0 {
			fmt.Println("\nEnvironment variables (press Enter to accept default):")
			for _, ev := range tmpl.EnvVars {
				if ev.Default != "" {
					fmt.Printf("  %s [%s]: ", ev.Key, ev.Default)
				} else {
					fmt.Printf("  %s: ", ev.Key)
				}
				scanner.Scan()
				val := strings.TrimSpace(scanner.Text())
				if val == "" {
					val = ev.Default
				}
				if ev.Required && val == "" {
					return fmt.Errorf("%s is required", ev.Key)
				}
				if val != "" {
					envOverrides[ev.Key] = val
				}
			}
		}

		fmt.Printf("\nDeploy %s as %q? [y/N] ", templateID, appName)
		scanner.Scan()
		answer := strings.TrimSpace(strings.ToLower(scanner.Text()))
		if answer != "y" && answer != "yes" {
			fmt.Println("Aborted.")
			return nil
		}

		payload := map[string]interface{}{
			"template_id": templateID,
			"app_name":    appName,
			"env":         envOverrides,
		}
		body, _ := json.Marshal(payload)
		deployResp, err := doRequest("POST", apiURL+"/api/v1/apps/from-template", body)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer deployResp.Body.Close()

		if deployResp.StatusCode != http.StatusOK && deployResp.StatusCode != http.StatusCreated {
			b, _ := io.ReadAll(deployResp.Body)
			return fmt.Errorf("deploy error %d: %s", deployResp.StatusCode, b)
		}

		var result struct {
			AppName string `json:"app_name"`
			URL     string `json:"url"`
		}
		if err := json.NewDecoder(deployResp.Body).Decode(&result); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		fmt.Printf("\n✓ %s deployed from template %s\n", result.AppName, templateID)
		if result.URL != "" {
			fmt.Printf("  URL: %s\n", result.URL)
		}
		return nil
	},
}

func init() {
	templatesCmd.AddCommand(templatesListCmd, templatesDeployCmd)
}
