package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/spf13/cobra"
)

var storageCmd = &cobra.Command{
	Use:   "storage",
	Short: "Manage object storage buckets",
}

var storageListCmd = &cobra.Command{
	Use:   "list <app>",
	Short: "List storage buckets for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(args[0])+"/storage", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var buckets []struct {
			Name      string `json:"name"`
			Public    bool   `json:"public"`
			SizeLimit string `json:"size_limit"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&buckets); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if len(buckets) == 0 {
			fmt.Println("No storage buckets found.")
			return nil
		}

		fmt.Printf("%-20s %-12s %-12s %s\n", "BUCKET NAME", "VISIBILITY", "SIZE LIMIT", "CREATED")
		fmt.Printf("%-20s %-12s %-12s %s\n", "-----------", "----------", "----------", "-------")
		for _, b := range buckets {
			visibility := "private"
			if b.Public {
				visibility = "public"
			}
			created := b.CreatedAt
			if len(created) >= 10 {
				created = created[:10]
			}
			sizeLimit := b.SizeLimit
			if sizeLimit == "" {
				sizeLimit = "1000MB"
			}
			fmt.Printf("%-20s %-12s %-12s %s\n", b.Name, visibility, sizeLimit, created)
		}
		return nil
	},
}

var storagePublic bool

var storageCreateCmd = &cobra.Command{
	Use:   "create <app> <bucket-name>",
	Short: "Create a storage bucket for an app",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, bucket := args[0], args[1]
		payload := map[string]interface{}{
			"name":   bucket,
			"public": storagePublic,
		}
		body, _ := json.Marshal(payload)
		resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/storage", body)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		visibility := "private"
		if storagePublic {
			visibility = "public"
		}
		fmt.Printf("✓ Bucket %s created (%s)\n", bucket, visibility)
		return nil
	},
}

var storageDeleteCmd = &cobra.Command{
	Use:   "delete <app> <bucket-name>",
	Short: "Delete a storage bucket",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, bucket := args[0], args[1]
		resp, err := doRequest("DELETE", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/storage/"+url.PathEscape(bucket), nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}
		fmt.Printf("✓ Bucket %s deleted from %s\n", bucket, app)
		return nil
	},
}

func init() {
	storageCreateCmd.Flags().BoolVar(&storagePublic, "public", false, "Make bucket publicly accessible")
	storageCmd.AddCommand(storageListCmd, storageCreateCmd, storageDeleteCmd)
}
