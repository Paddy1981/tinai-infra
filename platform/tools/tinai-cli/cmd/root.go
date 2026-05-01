package cmd

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var apiURL string

// authToken holds the Bearer token loaded from ~/.tinai/config.yaml.
// auth.go can also update this at runtime after a successful login/logout.
var authToken string

var rootCmd = &cobra.Command{
	Use:   "tinai",
	Short: "Tinai Cloud CLI",
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

type cliConfig struct {
	APIURL string `yaml:"api_url"`
	Token  string `yaml:"token"`
}

func init() {
	cobra.OnInitialize(initConfig)
	rootCmd.PersistentFlags().StringVar(&apiURL, "api-url", "", "API URL (overrides ~/.tinai/config.yaml)")
	rootCmd.AddCommand(appsCmd)
	rootCmd.AddCommand(logsCmd)
	rootCmd.AddCommand(envCmd)
	rootCmd.AddCommand(aiCmd)
	rootCmd.AddCommand(domainsCmd)
	rootCmd.AddCommand(volumesCmd)
	rootCmd.AddCommand(storageCmd)
	rootCmd.AddCommand(templatesCmd)
	rootCmd.AddCommand(databaseCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(tenantCmd)
}

func initConfig() {
	home, err := os.UserHomeDir()
	if err != nil {
		if apiURL == "" {
			apiURL = "https://tinai-build-api.localhost"
		}
		return
	}

	data, err := os.ReadFile(filepath.Join(home, ".tinai", "config.yaml"))
	if err != nil {
		if apiURL == "" {
			apiURL = "https://tinai-api.localhost"
		}
		return
	}

	var cfg cliConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		if apiURL == "" {
			apiURL = "https://tinai-build-api.localhost"
		}
		return
	}

	if apiURL == "" {
		if cfg.APIURL != "" {
			apiURL = cfg.APIURL
		} else {
			apiURL = "https://tinai-build-api.localhost"
		}
	}

	if cfg.Token != "" {
		authToken = cfg.Token
	}

	warnIfInsecureURL(apiURL)
}

// warnIfInsecureURL prints a warning when an http:// URL is used with a
// non-localhost host, as credentials will be transmitted in plaintext.
func warnIfInsecureURL(rawURL string) {
	if !strings.HasPrefix(rawURL, "http://") {
		return
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return
	}
	host := parsed.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" ||
		strings.HasSuffix(host, ".localhost") {
		return
	}
	fmt.Fprintf(os.Stderr, "Warning: API URL uses http:// (%s) — credentials will be sent in plaintext. Use https:// instead.\n", rawURL)
}

// bearerHeader returns a map containing the Authorization header if a token
// is available, otherwise an empty map.
func bearerHeader() map[string]string {
	if authToken == "" {
		return map[string]string{}
	}
	return map[string]string{"Authorization": "Bearer " + authToken}
}

// doRequest is a shared HTTP helper that automatically attaches the Bearer
// token (when available) to every outgoing request.
//
//   - method: "GET", "POST", "PUT", "DELETE", etc.
//   - url:    full URL including scheme and path
//   - body:   raw JSON body (may be nil for GET / DELETE)
//
// The caller is responsible for closing resp.Body.
func doRequest(method, url string, body []byte) (*http.Response, error) {
	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return nil, err
	}

	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	if authToken != "" {
		req.Header.Set("Authorization", "Bearer "+authToken)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}
