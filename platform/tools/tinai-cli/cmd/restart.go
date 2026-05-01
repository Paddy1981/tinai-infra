package cmd

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var appsRestartCmd = &cobra.Command{
	Use:   "restart <app-name>",
	Short: "Restart a deployed app",
	Args:  cobra.ExactArgs(1),
	RunE:  runRestart,
}

func init() {
	appsCmd.AddCommand(appsRestartCmd)
}

func runRestart(_ *cobra.Command, args []string) error {
	app := args[0]

	resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/restart", []byte("{}"))
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("restart request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	io.Copy(io.Discard, resp.Body)

	// Poll for completion (same pattern as deploy)
	start := time.Now()
	timeout := 5 * time.Minute
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			elapsed := time.Since(start).Round(time.Second)
			fmt.Printf("\rRestarting... %s", elapsed)

			status, _, _, err := fetchDeployStatus(app, "production")
			if err != nil {
				continue
			}

			switch status {
			case "running":
				fmt.Printf("\r✓ Restarted %s in %s\n", app, elapsed)
				return nil
			case "failed":
				fmt.Println()
				return fmt.Errorf("✗ Restart failed for %s", app)
			}

			if time.Since(start) >= timeout {
				fmt.Println()
				return fmt.Errorf("restart timed out after %s", timeout)
			}
		}
	}
}
