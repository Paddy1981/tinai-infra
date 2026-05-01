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

var volumesCmd = &cobra.Command{
	Use:   "volumes",
	Short: "Manage persistent volumes",
}

var volumesListCmd = &cobra.Command{
	Use:   "list <app>",
	Short: "List volumes for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(args[0])+"/volumes", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var volumes []struct {
			Name      string `json:"name"`
			MountPath string `json:"mount_path"`
			Size      string `json:"size"`
			Status    string `json:"status"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&volumes); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if len(volumes) == 0 {
			fmt.Println("No volumes attached.")
			return nil
		}

		fmt.Printf("%-28s %-14s %-7s %-10s %s\n", "NAME", "MOUNT PATH", "SIZE", "STATUS", "CREATED")
		fmt.Printf("%-28s %-14s %-7s %-10s %s\n", "----", "----------", "----", "------", "-------")
		for _, v := range volumes {
			created := v.CreatedAt
			if len(created) >= 10 {
				created = created[:10]
			}
			fmt.Printf("%-28s %-14s %-7s %-10s %s\n", v.Name, v.MountPath, v.Size, v.Status, created)
		}
		return nil
	},
}

var volumeSize int

var volumesAddCmd = &cobra.Command{
	Use:   "add <app> <mount-path>",
	Short: "Attach a new persistent volume to an app",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, mountPath := args[0], args[1]
		payload := map[string]interface{}{
			"mount_path": mountPath,
			"size_gi":    volumeSize,
		}
		body, _ := json.Marshal(payload)
		resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/volumes", body)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var result struct {
			Name string `json:"name"`
			Size string `json:"size"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		fmt.Printf("✓ Volume %s (%dGi) attached at %s\n", result.Name, volumeSize, mountPath)
		return nil
	},
}

var volumesRemoveCmd = &cobra.Command{
	Use:   "remove <app> <name>",
	Short: "Remove a volume from an app",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, name := args[0], args[1]

		fmt.Printf("Remove volume %s from %s? This will permanently delete all data. [y/N] ", name, app)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Scan()
		answer := strings.TrimSpace(strings.ToLower(scanner.Text()))
		if answer != "y" && answer != "yes" {
			fmt.Println("Aborted.")
			return nil
		}

		resp, err := doRequest("DELETE", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/volumes/"+url.PathEscape(name), nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}
		fmt.Printf("✓ Volume %s removed from %s\n", name, app)
		return nil
	},
}

func init() {
	volumesAddCmd.Flags().IntVar(&volumeSize, "size", 5, "Volume size in Gi")
	volumesCmd.AddCommand(volumesListCmd, volumesAddCmd, volumesRemoveCmd)
}
