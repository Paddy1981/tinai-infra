package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/spf13/cobra"
)

var domainsCmd = &cobra.Command{
	Use:   "domains",
	Short: "Manage custom domains",
}

var domainsListCmd = &cobra.Command{
	Use:   "list <app>",
	Short: "List custom domains for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(args[0])+"/domains", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var domains []struct {
			Domain     string `json:"domain"`
			Verified   bool   `json:"verified"`
			CertStatus string `json:"cert_status"`
			AddedAt    string `json:"added_at"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&domains); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if len(domains) == 0 {
			fmt.Println("No custom domains configured.")
			return nil
		}

		fmt.Printf("%-40s %-10s %-14s %s\n", "DOMAIN", "VERIFIED", "CERT STATUS", "ADDED")
		fmt.Printf("%-40s %-10s %-14s %s\n", "------", "--------", "-----------", "-----")
		for _, d := range domains {
			verified := "✗"
			if d.Verified {
				verified = "✓"
			}
			added := d.AddedAt
			if len(added) >= 10 {
				added = added[:10]
			}
			fmt.Printf("%-40s %-10s %-14s %s\n", d.Domain, verified, d.CertStatus, added)
		}
		return nil
	},
}

var domainsAddCmd = &cobra.Command{
	Use:   "add <app> <domain>",
	Short: "Add a custom domain to an app",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, domain := args[0], args[1]
		body, _ := json.Marshal(map[string]string{"domain": domain})
		resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/domains", body)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var result struct {
			TxtValue string `json:"txt_value"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		fmt.Printf("Domain %s added.\n\n", domain)
		if result.TxtValue != "" {
			fmt.Printf("Add TXT record:\n  Name:  _tinai-verify.%s\n  Value: %s\n\nThen run: tinai domains verify %s %s\n",
				domain, result.TxtValue, app, domain)
		}
		return nil
	},
}

var domainsRemoveCmd = &cobra.Command{
	Use:   "remove <app> <domain>",
	Short: "Remove a custom domain from an app",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, domain := args[0], args[1]
		resp, err := doRequest("DELETE", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/domains/"+url.PathEscape(domain), nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}
		fmt.Printf("✓ Domain %s removed from %s\n", domain, app)
		return nil
	},
}

var domainsVerifyCmd = &cobra.Command{
	Use:   "verify <app> <domain>",
	Short: "Check verification status of a domain",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		app, domain := args[0], args[1]
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/domains/"+url.PathEscape(domain)+"/verify", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var result struct {
			Verified   bool   `json:"verified"`
			CertStatus string `json:"cert_status"`
			Message    string `json:"message"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		if result.Verified {
			fmt.Printf("✓ %s is verified (cert: %s)\n", domain, result.CertStatus)
		} else {
			fmt.Printf("✗ %s is not yet verified\n", domain)
			if result.Message != "" {
				fmt.Printf("  %s\n", result.Message)
			}
		}
		return nil
	},
}

func init() {
	domainsCmd.AddCommand(domainsListCmd, domainsAddCmd, domainsRemoveCmd, domainsVerifyCmd)
}
