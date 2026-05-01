package cmd

// tinai forge — Admin commands for the TinAI Forge white-label pipeline.
//
// Usage:
//   tinai forge status                    — Show version matrix for all platform products
//   tinai forge check [product]           — Trigger upstream version check
//   tinai forge build <product>           — Trigger a brand+build for a product
//   tinai forge rollout start <product>   — Start rolling out a built version to tenants
//   tinai forge rollout status [id]       — Show rollout progress
//   tinai forge rollout pause <id>        — Pause a running rollout
//   tinai forge rollout rollback <id>     — Rollback a rollout
//
// These commands require admin role. Regular tenant users will get 403.

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"

	"tinai.cloud/cli/internal/api"
	"tinai.cloud/cli/internal/config"
)

// ─── tinai forge ─────────────────────────────────────────────────────────────

var forgeCmd = &cobra.Command{
	Use:   "forge",
	Short: "Manage TinAI Forge — the platform component pipeline (admin only)",
	Long: `TinAI Forge automates upgrades of platform components (TinAI Repos,
TinAI Pipelines, TinAI Insights, etc.) by watching upstream GitHub releases,
applying brand patches, running tests, and rolling out to tenants.

These commands are admin-only. They interact with the forge service via
the TinAI API (/api/forge/*).`,
}

// ─── tinai forge status ───────────────────────────────────────────────────────

var forgeStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show platform component version matrix",
	Long: `Show all tracked platform components, their current deployed version,
latest upstream version, and whether an update is available.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		// Overall forge status
		summary, err := client.ForgeStatus()
		if err != nil {
			return fmt.Errorf("failed to reach forge service: %w", err)
		}

		if summary.ForgeStatus == "not_deployed" {
			color.Yellow("⚠  Forge engine is not deployed yet.")
			color.White("   Deploy it with: tinai forge deploy")
			color.White("   Or view setup: https://app.tinai.cloud/admin/forge/setup")
			fmt.Println()
		} else {
			color.Green("● Forge engine: online")
		}

		fmt.Printf("  Products tracked:  %d\n", summary.Products)
		if summary.UpdatesAvailable > 0 {
			color.Yellow("  Updates available: %d", summary.UpdatesAvailable)
		} else {
			color.Green("  Updates available: 0")
		}
		fmt.Printf("  Builds today:      %d\n", summary.BuildsToday)
		fmt.Printf("  Active rollouts:   %d\n", summary.ActiveRollouts)
		fmt.Println()

		// Product version matrix
		products, err := client.ForgeListProducts()
		if err != nil {
			return fmt.Errorf("failed to list products: %w", err)
		}

		if len(products) == 0 {
			color.Yellow("No products registered in forge yet.")
			return nil
		}

		table := tablewriter.NewWriter(os.Stdout)
		table.SetHeader([]string{"TinAI Product", "Upstream", "Running", "Latest", "Patch", "Status"})
		table.SetBorder(false)
		table.SetHeaderColor(
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
		)

		tinaiNames := map[string]string{
			"forgejo":       "TinAI Repos",
			"woodpecker":    "TinAI Pipelines",
			"grafana":       "TinAI Insights",
			"prometheus":    "TinAI Metrics",
			"loki":          "TinAI Logs",
			"minio":         "TinAI Storage",
			"cloudnativepg": "TinAI Database",
			"cert-manager":  "TinAI Certs",
			"keda":          "TinAI Scale",
			"knative":       "TinAI Functions",
			"ingress-nginx": "TinAI Gateway",
		}

		for _, p := range products {
			tinaiName := tinaiNames[p.ID]
			if tinaiName == "" {
				tinaiName = p.Name
			}

			latest := p.LatestVersion
			if latest == "" {
				latest = p.CurrentVersion
			}

			statusColour := color.WhiteString(p.Status)
			switch p.Status {
			case "current":
				statusColour = color.GreenString("✓ current")
			case "update_available":
				statusColour = color.YellowString("↑ update")
			case "building":
				statusColour = color.CyanString("⚙ building")
			case "tested":
				statusColour = color.CyanString("✔ tested")
			case "staged":
				statusColour = color.MagentaString("⏳ staged")
			case "promoted":
				statusColour = color.GreenString("✓ promoted")
			}

			patchVer := p.PatchVersion
			if patchVer == "" {
				patchVer = "-"
			}

			table.Append([]string{
				tinaiName,
				p.Name,
				p.CurrentVersion,
				latest,
				patchVer,
				statusColour,
			})
		}
		table.Render()
		return nil
	},
}

// ─── tinai forge check ────────────────────────────────────────────────────────

var forgeCheckCmd = &cobra.Command{
	Use:   "check [product]",
	Short: "Trigger upstream version check (all products if no argument)",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		if len(args) == 0 {
			// Check all — list products and check each
			products, err := client.ForgeListProducts()
			if err != nil {
				return fmt.Errorf("failed to list products: %w", err)
			}
			color.Cyan("Triggering version check for %d products...", len(products))
			for _, p := range products {
				if err := client.ForgeCheckProduct(p.ID); err != nil {
					color.Yellow("  ⚠ %s: %v", p.ID, err)
				} else {
					fmt.Printf("  ✓ %s\n", p.ID)
				}
			}
			color.Green("Done. Run 'tinai forge status' to see results.")
			return nil
		}

		product := args[0]
		color.Cyan("Checking upstream for %s...", product)
		if err := client.ForgeCheckProduct(product); err != nil {
			return fmt.Errorf("check failed: %w", err)
		}
		color.Green("✓ Check queued for %s", product)
		color.White("  Run 'tinai forge status' in a few seconds to see the result.")
		return nil
	},
}

// ─── tinai forge build ────────────────────────────────────────────────────────

var forgeBuildCmd = &cobra.Command{
	Use:   "build <product>",
	Short: "Trigger a brand patch + Kaniko build for a product",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		product := args[0]
		color.Cyan("Triggering build for %s...", product)

		result, err := client.ForgeBuildProduct(product)
		if err != nil {
			return fmt.Errorf("build trigger failed: %w", err)
		}

		color.Green("✓ Build queued")
		fmt.Printf("  Product:  %s\n", result.ProductID)
		fmt.Printf("  Version:  %s\n", result.Version)
		fmt.Printf("  Status:   %s\n", result.Status)
		color.White("\n  Monitor: tinai forge builds")
		color.White("  Or visit: https://app.tinai.cloud/admin/forge/builds")
		return nil
	},
}

// ─── tinai forge builds ───────────────────────────────────────────────────────

var forgeBuildsCmd = &cobra.Command{
	Use:   "builds",
	Short: "List recent builds",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		builds, err := client.ForgeListBuilds()
		if err != nil {
			return fmt.Errorf("failed to list builds: %w", err)
		}

		if len(builds) == 0 {
			color.Yellow("No builds yet. Trigger one with: tinai forge build <product>")
			return nil
		}

		table := tablewriter.NewWriter(os.Stdout)
		table.SetHeader([]string{"ID", "Product", "Version", "Status", "Started"})
		table.SetBorder(false)
		table.SetHeaderColor(
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
		)

		for _, b := range builds {
			statusStr := b.Status
			switch b.Status {
			case "passed":
				statusStr = color.GreenString("✓ passed")
			case "failed":
				statusStr = color.RedString("✗ failed")
			case "building":
				statusStr = color.CyanString("⚙ building")
			case "testing":
				statusStr = color.CyanString("🧪 testing")
			}

			started := b.StartedAt
			if len(started) > 10 {
				started = started[:10]
			}
			table.Append([]string{
				fmt.Sprintf("%d", b.ID),
				b.ProductID,
				b.UpstreamVersion,
				statusStr,
				started,
			})
		}
		table.Render()
		return nil
	},
}

// ─── tinai forge rollout ──────────────────────────────────────────────────────

var forgeRolloutCmd = &cobra.Command{
	Use:   "rollout",
	Short: "Manage rollouts of platform components to tenants",
}

var forgeRolloutStartCmd = &cobra.Command{
	Use:   "start <product>",
	Short: "Start rolling out the latest built version of a product to all tenants",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		product := args[0]
		strategy, _ := cmd.Flags().GetString("strategy")
		from, _ := cmd.Flags().GetString("from")
		to, _ := cmd.Flags().GetString("to")

		// If versions not given, look up product to find current + latest
		if from == "" || to == "" {
			products, err := client.ForgeListProducts()
			if err != nil {
				return fmt.Errorf("failed to look up product: %w", err)
			}
			for _, p := range products {
				if p.ID == product {
					if from == "" {
						from = p.CurrentVersion
					}
					if to == "" {
						to = p.LatestVersion
						if to == "" {
							to = p.CurrentVersion
						}
					}
					break
				}
			}
		}

		if from == "" || to == "" {
			return fmt.Errorf("could not determine versions — specify with --from and --to")
		}

		if from == to {
			color.Yellow("Product %s is already at %s — nothing to roll out.", product, from)
			return nil
		}

		color.Cyan("Starting rollout: %s  %s → %s  (strategy: %s)", product, from, to, strategy)
		result, err := client.ForgeStartRollout(product, from, to, strategy)
		if err != nil {
			return fmt.Errorf("rollout failed to start: %w", err)
		}

		color.Green("✓ Rollout started (ID: %d)", result.ID)
		fmt.Printf("  Strategy: %s\n", result.Strategy)
		color.White("\n  Monitor: tinai forge rollout status %d", result.ID)
		return nil
	},
}

var forgeRolloutStatusCmd = &cobra.Command{
	Use:   "status [id]",
	Short: "Show rollout status (all active rollouts if no id given)",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, err := config.LoadCredentials()
		if err != nil {
			return fmt.Errorf("not logged in — run 'tinai login' first")
		}
		client := api.NewClient(cfg, cred)

		if len(args) > 0 {
			rollout, err := client.ForgeGetRollout(args[0])
			if err != nil {
				return fmt.Errorf("failed to get rollout: %w", err)
			}
			color.Cyan("Rollout #%d", rollout.ID)
			fmt.Printf("  Product:  %s\n", rollout.ProductID)
			fmt.Printf("  Version:  %s → %s\n", rollout.FromVersion, rollout.ToVersion)
			fmt.Printf("  Strategy: %s\n", rollout.Strategy)
			fmt.Printf("  Status:   %s\n", rollout.Status)
			fmt.Printf("  Tenants:  %d affected\n", rollout.AffectedTenants)
			fmt.Printf("  Errors:   %d\n", rollout.ErrorCount)
			return nil
		}

		rollouts, err := client.ForgeListRollouts()
		if err != nil {
			return fmt.Errorf("failed to list rollouts: %w", err)
		}

		if len(rollouts) == 0 {
			color.Yellow("No rollouts yet. Start one with: tinai forge rollout start <product>")
			return nil
		}

		table := tablewriter.NewWriter(os.Stdout)
		table.SetHeader([]string{"ID", "Product", "From", "To", "Strategy", "Status", "Tenants"})
		table.SetBorder(false)
		table.SetHeaderColor(
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
			tablewriter.Colors{tablewriter.FgCyanColor},
		)

		for _, r := range rollouts {
			statusStr := r.Status
			switch r.Status {
			case "in_progress":
				statusStr = color.CyanString("▶ in progress")
			case "completed":
				statusStr = color.GreenString("✓ completed")
			case "paused":
				statusStr = color.YellowString("⏸ paused")
			case "rolled_back":
				statusStr = color.RedString("↩ rolled back")
			}
			table.Append([]string{
				fmt.Sprintf("%d", r.ID),
				r.ProductID,
				r.FromVersion,
				r.ToVersion,
				r.Strategy,
				statusStr,
				fmt.Sprintf("%d", r.AffectedTenants),
			})
		}
		table.Render()
		return nil
	},
}

var forgeRolloutPauseCmd = &cobra.Command{
	Use:   "pause <id>",
	Short: "Pause a running rollout",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, _ := config.LoadCredentials()
		client := api.NewClient(cfg, cred)

		if err := client.ForgeRolloutAction(args[0], "pause"); err != nil {
			return fmt.Errorf("failed to pause rollout: %w", err)
		}
		color.Yellow("⏸  Rollout %s paused.", args[0])
		return nil
	},
}

var forgeRolloutRollbackCmd = &cobra.Command{
	Use:   "rollback <id>",
	Short: "Roll back a rollout",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, _ := config.Load()
		cred, _ := config.LoadCredentials()
		client := api.NewClient(cfg, cred)

		reason, _ := cmd.Flags().GetString("reason")
		if err := client.ForgeRolloutRollback(args[0], reason); err != nil {
			return fmt.Errorf("rollback failed: %w", err)
		}
		color.Red("↩  Rollout %s rolled back.", args[0])
		if reason != "" {
			fmt.Printf("   Reason: %s\n", reason)
		}
		return nil
	},
}

// ─── tinai forge deploy ───────────────────────────────────────────────────────
// Deploy the forge service itself to the cluster (admin op)

var forgeDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy the TinAI Forge engine to the cluster",
	Long: `Applies all forge K8s manifests from tinai-infra/k8s/forge/ in order.
Requires kubectl configured against the target cluster.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		color.Cyan("Deploying TinAI Forge engine to cluster...")
		fmt.Println()

		steps := []string{
			"00-namespace.yaml",
			"01-rbac.yaml",
			"02-secrets.yaml",
			"03-configmap.yaml",
			"09-postgres-db.yaml",
			"04-deployment.yaml",
			"05-service.yaml",
			"06-networkpolicy.yaml",
			"07-cronjob.yaml",
			"08-ingress.yaml",
		}

		manifestsDir, _ := cmd.Flags().GetString("manifests-dir")
		if manifestsDir == "" {
			manifestsDir = "tinai-infra/k8s/forge"
		}

		for _, file := range steps {
			path := manifestsDir + "/" + file
			fmt.Printf("  Applying %s...", file)

			// Run kubectl apply
			if err := runKubectl("apply", "-f", path); err != nil {
				fmt.Println()
				return fmt.Errorf("failed to apply %s: %w", file, err)
			}
			color.Green(" ✓")
		}

		fmt.Println()
		color.Green("✓ TinAI Forge deployed")
		fmt.Println()
		color.White("  Next steps:")
		fmt.Println("  1. Set FORGE_DB_URL and FORGE_API_KEY in the 02-secrets.yaml ConfigMap")
		fmt.Println("  2. Run: kubectl rollout status deploy/tinai-forge -n tinai-forge")
		fmt.Println("  3. Run: tinai forge status")
		return nil
	},
}

// helper: run kubectl command and stream output to stdout/stderr
func runKubectl(args ...string) error {
	cmd := exec.Command("kubectl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func init() {
	// forge rollout subcommands
	forgeRolloutStartCmd.Flags().String("strategy", "auto", "Rollout strategy: auto, bigbang, rolling, canary")
	forgeRolloutStartCmd.Flags().String("from", "", "Current version (auto-detected if omitted)")
	forgeRolloutStartCmd.Flags().String("to", "", "Target version (auto-detected if omitted)")
	forgeRolloutRollbackCmd.Flags().String("reason", "", "Reason for rollback")

	forgeRolloutCmd.AddCommand(forgeRolloutStartCmd)
	forgeRolloutCmd.AddCommand(forgeRolloutStatusCmd)
	forgeRolloutCmd.AddCommand(forgeRolloutPauseCmd)
	forgeRolloutCmd.AddCommand(forgeRolloutRollbackCmd)

	// forge deploy flags
	forgeDeployCmd.Flags().String("manifests-dir", "", "Path to tinai-infra/k8s/forge directory")

	// attach all forge subcommands
	forgeCmd.AddCommand(forgeStatusCmd)
	forgeCmd.AddCommand(forgeCheckCmd)
	forgeCmd.AddCommand(forgeBuildCmd)
	forgeCmd.AddCommand(forgeBuildsCmd)
	forgeCmd.AddCommand(forgeRolloutCmd)
	forgeCmd.AddCommand(forgeDeployCmd)

	// attach forge to root
	rootCmd.AddCommand(forgeCmd)
}
