package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/cobra"
	"golang.org/x/term"
	"gopkg.in/yaml.v3"
)

// authCmd is the top-level `tinai auth` group.
var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authenticate with Tinai Cloud",
}

// --email and --mobile flags for loginCmd.
var loginEmail string
var loginMobile string

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Tinai Cloud",
	RunE:  runLogin,
}

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out of Tinai Cloud",
	RunE:  runLogout,
}

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show currently authenticated user",
	RunE:  runWhoami,
}

func init() {
	loginCmd.Flags().StringVar(&loginEmail, "email", "", "Email address")
	loginCmd.Flags().StringVar(&loginMobile, "mobile", "", "Mobile number (triggers SMS OTP flow)")
	authCmd.AddCommand(loginCmd, logoutCmd, whoamiCmd)
}

// readLine reads a line from stdin, trimming whitespace.
func readLine() (string, error) {
	var buf strings.Builder
	b := make([]byte, 1)
	for {
		n, err := os.Stdin.Read(b)
		if n > 0 {
			ch := b[0]
			if ch == '\n' {
				break
			}
			if ch != '\r' {
				buf.WriteByte(ch)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	return strings.TrimSpace(buf.String()), nil
}

// configPath returns the path to ~/.tinai/config.yaml.
func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot locate home directory: %w", err)
	}
	return filepath.Join(home, ".tinai", "config.yaml"), nil
}

// loadConfigMap reads ~/.tinai/config.yaml into a generic map.
// Returns an empty map (not an error) if the file does not exist.
func loadConfigMap() (map[string]interface{}, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return make(map[string]interface{}), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if m == nil {
		m = make(map[string]interface{})
	}
	return m, nil
}

// saveConfigMap writes a map back to ~/.tinai/config.yaml, creating the
// directory if needed.
func saveConfigMap(m map[string]interface{}) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// saveToken writes the given token into config, then updates the
// package-level authToken so subsequent requests in the same session
// use it immediately.
func saveToken(token string) error {
	m, err := loadConfigMap()
	if err != nil {
		return err
	}
	m["token"] = token
	if err := saveConfigMap(m); err != nil {
		return err
	}
	authToken = token
	return nil
}

// runLogin handles both email/password and mobile OTP flows.
func runLogin(_ *cobra.Command, _ []string) error {
	// --- Mobile / SMS-OTP flow ---
	if loginMobile != "" {
		return runLoginSMS(loginMobile)
	}

	// --- Email / password flow ---
	email := loginEmail
	if email == "" {
		fmt.Print("Email: ")
		var err error
		email, err = readLine()
		if err != nil || email == "" {
			return fmt.Errorf("email is required")
		}
	}

	fmt.Print("Password: ")
	passwordBytes, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}
	password := strings.TrimSpace(string(passwordBytes))
	if password == "" {
		return fmt.Errorf("password is required")
	}

	payload := map[string]string{"email": email, "password": password}
	body, _ := json.Marshal(payload)
	resp, err := doRequest("POST", apiURL+"/api/v1/auth/login", body)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("login failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if result.Token == "" {
		return fmt.Errorf("server returned empty token")
	}

	if err := saveToken(result.Token); err != nil {
		return err
	}
	fmt.Printf("Logged in as %s\n", email)
	return nil
}

// runLoginSMS handles the SMS OTP authentication flow.
func runLoginSMS(mobile string) error {
	// Step 1: request OTP
	payload := map[string]string{"mobile": mobile}
	body, _ := json.Marshal(payload)
	resp, err := doRequest("POST", apiURL+"/api/v1/auth/sms-otp", body)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("failed to send OTP (status %d)", resp.StatusCode)
	}
	fmt.Printf("OTP sent to %s\n", mobile)

	// Step 2: prompt for OTP
	fmt.Print("Enter 6-digit OTP: ")
	otpBytes, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		return fmt.Errorf("read OTP: %w", err)
	}
	otp := strings.TrimSpace(string(otpBytes))
	if otp == "" {
		return fmt.Errorf("OTP is required")
	}

	// Step 3: verify
	verifyPayload := map[string]string{"mobile": mobile, "otp": otp}
	verifyBody, _ := json.Marshal(verifyPayload)
	verifyResp, err := doRequest("POST", apiURL+"/api/v1/auth/verify-sms", verifyBody)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer verifyResp.Body.Close()

	if verifyResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(verifyResp.Body)
		return fmt.Errorf("OTP verification failed (%d): %s", verifyResp.StatusCode, strings.TrimSpace(string(b)))
	}

	var result struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(verifyResp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if result.Token == "" {
		return fmt.Errorf("server returned empty token")
	}

	if err := saveToken(result.Token); err != nil {
		return err
	}
	fmt.Printf("Logged in via SMS as %s\n", mobile)
	return nil
}

// runLogout removes the token from ~/.tinai/config.yaml.
func runLogout(_ *cobra.Command, _ []string) error {
	m, err := loadConfigMap()
	if err != nil {
		return err
	}
	delete(m, "token")
	if err := saveConfigMap(m); err != nil {
		return err
	}
	authToken = ""
	fmt.Println("Logged out")
	return nil
}

// runWhoami fetches the current user's profile from the API.
func runWhoami(_ *cobra.Command, _ []string) error {
	if authToken == "" {
		return fmt.Errorf("not logged in — run: tinai auth login")
	}
	resp, err := doRequest("GET", apiURL+"/api/v1/auth/me", nil)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("token is invalid or expired — run: tinai auth login")
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("error %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var user struct {
		ID     string `json:"id"`
		Email  string `json:"email"`
		Mobile string `json:"mobile"`
		Role   string `json:"role"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	fmt.Printf("ID:     %s\n", user.ID)
	if user.Email != "" {
		fmt.Printf("Email:  %s\n", user.Email)
	}
	if user.Mobile != "" {
		fmt.Printf("Mobile: %s\n", user.Mobile)
	}
	fmt.Printf("Role:   %s\n", user.Role)
	return nil
}
