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

var databaseCmd = &cobra.Command{
	Use:   "database",
	Short: "Manage app databases",
}

var databaseStatusCmd = &cobra.Command{
	Use:   "status <app>",
	Short: "Show database info for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		resp, err := doRequest("GET", apiURL+"/api/v1/apps/"+url.PathEscape(args[0])+"/database", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			fmt.Printf("No database provisioned for %s.\n", args[0])
			fmt.Printf("Run: tinai database provision %s\n", args[0])
			return nil
		}
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var db struct {
			Name      string `json:"name"`
			Host      string `json:"host"`
			Port      int    `json:"port"`
			Username  string `json:"username"`
			Status    string `json:"status"`
			Region    string `json:"region"`
			CreatedAt string `json:"created_at"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&db); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		host := db.Host
		if db.Port != 0 {
			host = fmt.Sprintf("%s:%d", db.Host, db.Port)
		}
		created := db.CreatedAt
		if len(created) >= 16 {
			created = created[:16]
		}

		fmt.Printf("Database: %s\n", db.Name)
		fmt.Printf("Host:     %s\n", host)
		fmt.Printf("Username: %s\n", db.Username)
		fmt.Printf("Status:   %s\n", db.Status)
		fmt.Printf("Region:   %s\n", db.Region)
		fmt.Printf("Created:  %s\n", created)
		return nil
	},
}

var databaseProvisionCmd = &cobra.Command{
	Use:   "provision <app>",
	Short: "Provision a new database for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		app := args[0]
		resp, err := doRequest("POST", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/database", []byte("{}"))
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}

		var db struct {
			Name     string `json:"name"`
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Username string `json:"username"`
			Password string `json:"password"`
			Region   string `json:"region"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&db); err != nil {
			return fmt.Errorf("decode: %w", err)
		}

		host := db.Host
		if db.Port != 0 {
			host = fmt.Sprintf("%s:%d", db.Host, db.Port)
		}

		fmt.Printf("✓ Database provisioned for %s\n\n", app)
		fmt.Printf("Database: %s\n", db.Name)
		fmt.Printf("Host:     %s\n", host)
		fmt.Printf("Username: %s\n", db.Username)
		fmt.Printf("Region:   %s\n", db.Region)
		if db.Password != "" {
			fmt.Printf("\nPassword: %s\n", db.Password)
			fmt.Println("\n[!] Save this password now — it will not be shown again.")
		}
		return nil
	},
}

var databaseDeleteCmd = &cobra.Command{
	Use:   "delete <app>",
	Short: "Delete the database for an app",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		app := args[0]

		fmt.Printf("Delete database for %s? All data will be permanently lost. [y/N] ", app)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Scan()
		answer := strings.TrimSpace(strings.ToLower(scanner.Text()))
		if answer != "y" && answer != "yes" {
			fmt.Println("Aborted.")
			return nil
		}

		resp, err := doRequest("DELETE", apiURL+"/api/v1/apps/"+url.PathEscape(app)+"/database", nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
			b, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("error %d: %s", resp.StatusCode, b)
		}
		fmt.Printf("✓ Database for %s deleted\n", app)
		return nil
	},
}

func init() {
	databaseCmd.AddCommand(databaseStatusCmd, databaseProvisionCmd, databaseDeleteCmd)
}
