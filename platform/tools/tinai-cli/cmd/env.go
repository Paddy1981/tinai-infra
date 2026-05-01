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

var envTargetEnv string // shared --env flag for all env subcommands

var envCmd = &cobra.Command{
	Use:   "env",
	Short: "Manage app environment variables",
}

var envListCmd = &cobra.Command{
	Use:   "list <app>",
	Short: "List env vars for an app",
	Long: `List environment variables for an app in a specific environment.

Examples:
  tinai env list myapp --env production
  tinai env list myapp --env staging`,
	Args: cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		app := args[0]
		u := envVarsURL(app, envTargetEnv)

		resp, err := doRequest("GET", u, nil)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		var data map[string]string
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			return err
		}
		if len(data) == 0 {
			fmt.Printf("No env vars set for %s [%s].\n", app, envTargetEnv)
			return nil
		}
		fmt.Printf("Env vars for %s [%s]:\n", app, envTargetEnv)
		for k, v := range data {
			fmt.Printf("  %s=%s\n", k, v)
		}
		return nil
	},
}

var envSetCmd = &cobra.Command{
	Use:   "set <app> KEY=VALUE ...",
	Short: "Set env vars for an app",
	Long: `Set environment variables for an app in a specific environment.

Examples:
  tinai env set myapp DATABASE_URL=postgres://... --env production
  tinai env set myapp DEBUG=true --env staging`,
	Args: cobra.MinimumNArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app := args[0]
		data := make(map[string]string)
		for _, kv := range args[1:] {
			parts := strings.SplitN(kv, "=", 2)
			if len(parts) != 2 {
				return fmt.Errorf("invalid format %q, expected KEY=VALUE", kv)
			}
			data[parts[0]] = parts[1]
		}

		u := envVarsURL(app, envTargetEnv)
		body, _ := json.Marshal(data)
		resp, err := doRequest("POST", u, body)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}
		fmt.Printf("Set %d env var(s) for %s [%s]\n", len(data), app, envTargetEnv)
		return nil
	},
}

var envUnsetCmd = &cobra.Command{
	Use:   "unset <app> KEY ...",
	Short: "Remove env vars from an app",
	Long: `Remove environment variables from an app in a specific environment.

Examples:
  tinai env unset myapp DEBUG --env staging
  tinai env unset myapp SECRET_KEY --env development`,
	Args: cobra.MinimumNArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app := args[0]
		for _, key := range args[1:] {
			u := envVarsURL(app, envTargetEnv) + "/" + url.PathEscape(key)
			resp, err := doRequest("DELETE", u, nil)
			if err != nil {
				return err
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
				return fmt.Errorf("error deleting %s: status %d", key, resp.StatusCode)
			}
			fmt.Printf("Unset %s for %s [%s]\n", key, app, envTargetEnv)
		}
		return nil
	},
}

func init() {
	// Register --env on the parent so it propagates to all subcommands.
	envCmd.PersistentFlags().StringVar(&envTargetEnv, "env", "production", "Target environment (production, staging, development)")
	envCmd.AddCommand(envListCmd, envSetCmd, envUnsetCmd)
}

// envVarsURL builds the API URL for env-var operations, scoped by environment.
//
//	/api/v1/apps/:app/env?env=<environment>
func envVarsURL(app, env string) string {
	return fmt.Sprintf("%s/api/v1/apps/%s/env?env=%s",
		apiURL, url.PathEscape(app), url.QueryEscape(env))
}
