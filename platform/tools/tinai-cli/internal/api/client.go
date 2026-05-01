package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"tinai.cloud/cli/internal/config"
)

// Client wraps HTTP calls to the TinAI API.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewClient(cfg *config.Config, cred *config.Credentials) *Client {
	return &Client{
		baseURL: cfg.APIURL,
		token:   cred.Token,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) do(method, path string, body interface{}) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "tinai-cli/0.1.0")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return data, resp.StatusCode, nil
}

// Apps

type App struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Owner        string `json:"owner"`
	RepoFullName string `json:"repo_full_name"`
	CreatedAt    string `json:"created_at"`
}

func (c *Client) ListApps() ([]App, error) {
	data, status, err := c.do("GET", "/api/v1/apps", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var apps []App
	return apps, json.Unmarshal(data, &apps)
}

func (c *Client) CreateApp(name string, createRepo bool) (*App, error) {
	body := map[string]interface{}{
		"name":       name,
		"createRepo": createRepo,
	}
	data, status, err := c.do("POST", "/api/v1/apps", body)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var app App
	return &app, json.Unmarshal(data, &app)
}

func (c *Client) GetApp(name string) (*App, error) {
	data, status, err := c.do("GET", "/api/v1/apps/"+name, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var app App
	return &app, json.Unmarshal(data, &app)
}

// Deployments

type DeployStatus struct {
	Image         string `json:"image"`
	Replicas      int    `json:"replicas"`
	ReadyReplicas int    `json:"ready_replicas"`
	Status        string `json:"status"`
}

func (c *Client) GetDeployStatus(appName string) (*DeployStatus, error) {
	data, status, err := c.do("GET", "/api/v1/apps/"+appName+"/status", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var ds DeployStatus
	return &ds, json.Unmarshal(data, &ds)
}

// Logs

func (c *Client) GetLogs(appName string, lines int) (string, error) {
	path := fmt.Sprintf("/api/v1/apps/%s/logs?lines=%d", appName, lines)
	data, status, err := c.do("GET", path, nil)
	if err != nil {
		return "", err
	}
	if status != 200 {
		return "", fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var result struct {
		Logs string `json:"logs"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return string(data), nil
	}
	return result.Logs, nil
}

// Env vars

func (c *Client) GetEnvVars(appName string) (map[string]string, error) {
	data, status, err := c.do("GET", "/api/v1/apps/"+appName+"/env", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var env map[string]string
	return env, json.Unmarshal(data, &env)
}

func (c *Client) SetEnvVars(appName string, env map[string]string) error {
	_, status, err := c.do("POST", "/api/v1/apps/"+appName+"/env", env)
	if err != nil {
		return err
	}
	if status != 200 && status != 204 {
		return fmt.Errorf("API error (status %d)", status)
	}
	return nil
}

// Auth

type LoginResponse struct {
	Token    string `json:"token"`
	TenantID string `json:"tenant_id"`
}

// ─── Forge API ───────────────────────────────────────────────────────────────
// All forge endpoints go through tinai-api (/api/v1/forge/*) which proxies
// to the tinai-forge service. The caller (CLI user) must have admin role.

// ForgeSummary is the aggregate status response from GET /api/v1/forge/status
type ForgeSummary struct {
	ForgeStatus      string `json:"forge_status"`      // "online" | "not_deployed"
	Products         int    `json:"products"`
	UpdatesAvailable int    `json:"updates_available"`
	BuildsToday      int    `json:"builds_today"`
	ActiveRollouts   int    `json:"active_rollouts"`
	LastCheck        string `json:"last_check"`
}

// ForgeProduct is one row in the version matrix
type ForgeProduct struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	PatchVersion   string `json:"patch_version"`
	Status         string `json:"status"`
	LastCheckedAt  string `json:"last_checked_at"`
}

// ForgeBuild is one build record
type ForgeBuild struct {
	ID              int    `json:"id"`
	ProductID       string `json:"product_id"`
	UpstreamVersion string `json:"upstream_version"`
	PatchVersion    string `json:"patch_version"`
	ImageTag        string `json:"image_tag"`
	Status          string `json:"status"`
	StartedAt       string `json:"started_at"`
}

// ForgeRollout is one rollout record
type ForgeRollout struct {
	ID              int    `json:"id"`
	ProductID       string `json:"product_id"`
	FromVersion     string `json:"from_version"`
	ToVersion       string `json:"to_version"`
	Strategy        string `json:"strategy"`
	Status          string `json:"status"`
	AffectedTenants int    `json:"affected_tenants"`
	ErrorCount      int    `json:"error_count"`
}

// ForgeBuildResult is the response from triggering a build
type ForgeBuildResult struct {
	Status    string `json:"status"`
	ProductID string `json:"product_id"`
	Version   string `json:"version"`
}

// ForgeRolloutResult is the response from starting a rollout
type ForgeRolloutResult struct {
	ID       int    `json:"id"`
	Status   string `json:"status"`
	Strategy string `json:"strategy"`
}

func (c *Client) ForgeStatus() (*ForgeSummary, error) {
	data, status, err := c.do("GET", "/api/v1/forge/status", nil)
	if err != nil {
		return nil, err
	}
	if status >= 500 {
		return nil, fmt.Errorf("forge service error (status %d): %s", status, string(data))
	}
	var s ForgeSummary
	return &s, json.Unmarshal(data, &s)
}

func (c *Client) ForgeListProducts() ([]ForgeProduct, error) {
	data, status, err := c.do("GET", "/api/v1/forge/products", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var products []ForgeProduct
	return products, json.Unmarshal(data, &products)
}

func (c *Client) ForgeCheckProduct(productID string) error {
	_, status, err := c.do("POST", "/api/v1/forge/products/"+productID+"/check", nil)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error (status %d)", status)
	}
	return nil
}

func (c *Client) ForgeBuildProduct(productID string) (*ForgeBuildResult, error) {
	data, status, err := c.do("POST", "/api/v1/forge/products/"+productID+"/build", nil)
	if err != nil {
		return nil, err
	}
	if status != 202 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var result ForgeBuildResult
	return &result, json.Unmarshal(data, &result)
}

func (c *Client) ForgeListBuilds() ([]ForgeBuild, error) {
	data, status, err := c.do("GET", "/api/v1/forge/builds", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var builds []ForgeBuild
	return builds, json.Unmarshal(data, &builds)
}

func (c *Client) ForgeListRollouts() ([]ForgeRollout, error) {
	data, status, err := c.do("GET", "/api/v1/forge/rollouts", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var rollouts []ForgeRollout
	return rollouts, json.Unmarshal(data, &rollouts)
}

func (c *Client) ForgeGetRollout(id string) (*ForgeRollout, error) {
	data, status, err := c.do("GET", "/api/v1/forge/rollouts/"+id, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var r ForgeRollout
	return &r, json.Unmarshal(data, &r)
}

func (c *Client) ForgeStartRollout(productID, from, to, strategy string) (*ForgeRolloutResult, error) {
	body := map[string]string{
		"product_id":   productID,
		"from_version": from,
		"to_version":   to,
		"strategy":     strategy,
	}
	data, status, err := c.do("POST", "/api/v1/forge/rollouts", body)
	if err != nil {
		return nil, err
	}
	if status != 202 {
		return nil, fmt.Errorf("API error (status %d): %s", status, string(data))
	}
	var r ForgeRolloutResult
	return &r, json.Unmarshal(data, &r)
}

func (c *Client) ForgeRolloutAction(id, action string) error {
	_, status, err := c.do("POST", "/api/v1/forge/rollouts/"+id+"/"+action, nil)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error (status %d)", status)
	}
	return nil
}

func (c *Client) ForgeRolloutRollback(id, reason string) error {
	body := map[string]string{"reason": reason}
	_, status, err := c.do("POST", "/api/v1/forge/rollouts/"+id+"/rollback", body)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error (status %d)", status)
	}
	return nil
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

func Login(apiURL, email, password string) (*LoginResponse, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	body, _ := json.Marshal(map[string]string{
		"email":    email,
		"password": password,
	})
	resp, err := client.Post(apiURL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("login failed (status %d): %s", resp.StatusCode, string(data))
	}
	var lr LoginResponse
	return &lr, json.Unmarshal(data, &lr)
}
