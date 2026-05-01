package cmd

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"

	"github.com/spf13/cobra"
)

var (
	followLogs bool
	tailLines  int
)

var logsCmd = &cobra.Command{
	Use:   "logs <app>",
	Short: "Stream app logs",
	Args:  cobra.ExactArgs(1),
	RunE:  runLogs,
}

func init() {
	logsCmd.Flags().BoolVarP(&followLogs, "follow", "f", false, "Follow log output")
	logsCmd.Flags().IntVar(&tailLines, "tail", 100, "Number of recent log lines to show")
}

func runLogs(_ *cobra.Command, args []string) error {
	name := args[0]
	reqURL := fmt.Sprintf("%s/api/v1/apps/%s/logs?follow=%s&tail=%s",
		apiURL, url.PathEscape(name), strconv.FormatBool(followLogs), strconv.Itoa(tailLines))

	resp, err := doRequest("GET", reqURL, nil)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("error %d: %s", resp.StatusCode, string(body))
	}

	_, err = io.Copy(os.Stdout, resp.Body)
	return err
}
