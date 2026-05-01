// Package oidc implements OIDC provider discovery and the authorization-code
// exchange flow used by tinai-auth's SSO endpoints.
//
// OIDC providers are configured via environment variables:
//
//	OIDC_AZURE_CLIENT_ID,  OIDC_AZURE_CLIENT_SECRET,  OIDC_AZURE_ISSUER,  OIDC_AZURE_REDIRECT_URL
//	OIDC_GOOGLE_CLIENT_ID, OIDC_GOOGLE_CLIENT_SECRET, OIDC_GOOGLE_ISSUER, OIDC_GOOGLE_REDIRECT_URL
//	OIDC_OKTA_CLIENT_ID,   OIDC_OKTA_CLIENT_SECRET,   OIDC_OKTA_ISSUER,   OIDC_OKTA_REDIRECT_URL
//
// Providers with no CLIENT_ID set are silently skipped.
//
// Typical issuer values:
//
//	Azure AD:        https://login.microsoftonline.com/{tenant-id}/v2.0
//	Google Workspace: https://accounts.google.com
//	Okta:            https://{your-domain}.okta.com
package oidc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Provider holds OIDC configuration for a single identity provider.
type Provider struct {
	Name         string // "azure", "google", "okta"
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// Discovered from /.well-known/openid-configuration
	AuthURL     string
	TokenURL    string
	UserinfoURL string
	Issuer      string
}

// IDToken contains the claims we care about from an OIDC id_token or userinfo response.
type IDToken struct {
	Sub   string `json:"sub"`   // provider user ID
	Email string `json:"email"`
	Name  string `json:"name"`
}

// Config holds all configured OIDC providers (loaded from env at startup).
type Config struct {
	Providers map[string]*Provider
}

// LoadFromEnv reads OIDC provider config from environment variables.
// Each provider is configured via:
//
//	OIDC_{NAME}_CLIENT_ID
//	OIDC_{NAME}_CLIENT_SECRET
//	OIDC_{NAME}_ISSUER      (e.g. https://login.microsoftonline.com/{tenant}/v2.0)
//	OIDC_{NAME}_REDIRECT_URL
//
// Example for Azure: OIDC_AZURE_CLIENT_ID, OIDC_AZURE_CLIENT_SECRET, etc.
func LoadFromEnv() *Config {
	cfg := &Config{Providers: make(map[string]*Provider)}
	names := []string{"azure", "google", "okta"}
	for _, name := range names {
		upper := strings.ToUpper(name)
		clientID := os.Getenv("OIDC_" + upper + "_CLIENT_ID")
		if clientID == "" {
			continue // provider not configured
		}
		p := &Provider{
			Name:         name,
			ClientID:     clientID,
			ClientSecret: os.Getenv("OIDC_" + upper + "_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("OIDC_" + upper + "_REDIRECT_URL"),
		}
		issuer := os.Getenv("OIDC_" + upper + "_ISSUER")
		if err := p.Discover(context.Background(), issuer); err != nil {
			fmt.Printf("oidc: discover %s: %v (skipping)\n", name, err)
			continue
		}
		cfg.Providers[name] = p
	}
	return cfg
}

// Discover populates AuthURL, TokenURL, UserinfoURL from the OIDC discovery document.
func (p *Provider) Discover(ctx context.Context, issuer string) error {
	if issuer == "" {
		return fmt.Errorf("issuer is required")
	}
	p.Issuer = issuer
	discoveryURL := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var doc struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	p.AuthURL = doc.AuthorizationEndpoint
	p.TokenURL = doc.TokenEndpoint
	p.UserinfoURL = doc.UserinfoEndpoint
	return nil
}

// AuthCodeURL returns the redirect URL to send the user to.
func (p *Provider) AuthCodeURL(state string) string {
	v := url.Values{
		"client_id":     {p.ClientID},
		"response_type": {"code"},
		"redirect_uri":  {p.RedirectURL},
		"scope":         {"openid email profile"},
		"state":         {state},
	}
	return p.AuthURL + "?" + v.Encode()
}

// Exchange exchanges an authorization code for an access token, then fetches
// the userinfo endpoint to return an IDToken.
func (p *Provider) Exchange(ctx context.Context, code string) (*IDToken, error) {
	// Exchange code for token.
	resp, err := http.PostForm(p.TokenURL, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {p.RedirectURL},
		"client_id":     {p.ClientID},
		"client_secret": {p.ClientSecret},
	})
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.Error != "" {
		return nil, fmt.Errorf("token error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	// Fetch userinfo.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.UserinfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tokenResp.AccessToken)
	client := &http.Client{Timeout: 10 * time.Second}
	uiResp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("userinfo: %w", err)
	}
	defer uiResp.Body.Close()

	var idToken IDToken
	if err := json.NewDecoder(uiResp.Body).Decode(&idToken); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	return &idToken, nil
}
