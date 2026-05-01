package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

var aiAppFlag string

var aiCmd = &cobra.Command{
	Use:   "ai <question>",
	Short: "Ask the platform copilot",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runAI,
}

func init() {
	aiCmd.Flags().StringVarP(&aiAppFlag, "app", "a", "", "Focus on a specific app")
}

func runAI(_ *cobra.Command, args []string) error {
	message := strings.Join(args, " ")

	reqBody := map[string]string{"message": message}
	if aiAppFlag != "" {
		reqBody["app"] = aiAppFlag
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	resp, err := doRequest("POST", apiURL+"/api/v1/ai/chat", body)
	if err != nil {
		return fmt.Errorf("failed to reach copilot: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("copilot error %d: %s", resp.StatusCode, b)
	}

	var result struct {
		Response string `json:"response"`
		Model    string `json:"model"`
		Active   bool   `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	fmt.Println()
	fmt.Println(result.Response)
	fmt.Println()

	if !result.Active {
		fmt.Println("\n[stub mode — set ANTHROPIC_API_KEY on the server to activate]")
	}

	return nil
}
