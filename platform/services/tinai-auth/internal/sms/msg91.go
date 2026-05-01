package sms

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	msg91BaseURL    = "https://api.msg91.com/api/v5"
	msg91OTPPath    = "/otp"
	msg91VerifyPath = "/otp/verify"
	msg91RetryPath  = "/otp/retry"
)

// Client is a Msg91 SMS OTP client that uses only stdlib net/http.
type Client struct {
	authKey    string
	templateID string
	senderID   string
	httpClient *http.Client
}

// NewClient constructs a Client from environment variables.
//
//	MSG91_AUTH_KEY     – required; disables SMS if absent
//	MSG91_TEMPLATE_ID  – OTP template registered in Msg91 console
//	MSG91_SENDER_ID    – 6-char sender header (default: TINAI)
func NewClient() *Client {
	return &Client{
		authKey:    os.Getenv("MSG91_AUTH_KEY"),
		templateID: os.Getenv("MSG91_TEMPLATE_ID"),
		senderID:   getEnv("MSG91_SENDER_ID", "TINAI"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Enabled reports whether the client has been configured with an auth key.
// All Send/Verify/Resend calls are no-ops (returning an error) when false.
func (c *Client) Enabled() bool { return c.authKey != "" }

// SendOTP sends a 6-digit OTP to mobile (must include country code, e.g.
// "919876543210" for an Indian number). The OTP expires after 10 minutes.
func (c *Client) SendOTP(ctx context.Context, mobile string) error {
	if !c.Enabled() {
		return fmt.Errorf("sms: MSG91_AUTH_KEY not set")
	}

	params := url.Values{}
	params.Set("authkey", c.authKey)
	params.Set("mobile", mobile)
	params.Set("otp_length", "6")
	params.Set("otp_expiry", "10")
	if c.templateID != "" {
		params.Set("template_id", c.templateID)
	}

	endpoint := msg91BaseURL + msg91OTPPath + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(""))
	if err != nil {
		return fmt.Errorf("sms: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("sms: send otp: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	return checkMsg91Response(body)
}

// VerifyOTP verifies the OTP that the user entered against Msg91.
// Returns (true, nil) on success, (false, nil) when the OTP is wrong/expired,
// and (false, err) on transport or unexpected errors.
func (c *Client) VerifyOTP(ctx context.Context, mobile string, otp string) (bool, error) {
	if !c.Enabled() {
		return false, fmt.Errorf("sms: MSG91_AUTH_KEY not set")
	}

	params := url.Values{}
	params.Set("authkey", c.authKey)
	params.Set("mobile", mobile)
	params.Set("otp", otp)

	endpoint := msg91BaseURL + msg91VerifyPath + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, fmt.Errorf("sms: build verify request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, fmt.Errorf("sms: verify otp: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return false, fmt.Errorf("sms: parse verify response: %w", err)
	}

	// Msg91 returns {"type":"success","message":"OTP verified successfully"} on match.
	return result.Type == "success", nil
}

// ResendOTP triggers a resend of the OTP via a voice call fallback.
func (c *Client) ResendOTP(ctx context.Context, mobile string) error {
	if !c.Enabled() {
		return fmt.Errorf("sms: MSG91_AUTH_KEY not set")
	}

	params := url.Values{}
	params.Set("authkey", c.authKey)
	params.Set("mobile", mobile)
	params.Set("retrytype", "voice")

	endpoint := msg91BaseURL + msg91RetryPath + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("sms: build resend request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("sms: resend otp: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	return checkMsg91Response(body)
}

// checkMsg91Response parses a Msg91 JSON response body and returns nil when
// type == "success", otherwise an error containing the API message field.
func checkMsg91Response(body []byte) error {
	var result struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("sms: parse response: %w (raw: %s)", err, string(body))
	}
	if result.Type != "success" {
		msg := result.Message
		if msg == "" {
			msg = string(body)
		}
		return fmt.Errorf("sms: msg91 error: %s", msg)
	}
	return nil
}

// getEnv returns the value of key from the environment, falling back to
// fallback when the variable is unset or empty.
func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
