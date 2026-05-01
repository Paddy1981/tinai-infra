package cmd

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

var tenantCreatePlan string
var tenantCreateOwner string
var tenantUpgradePlan string

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

var dnsLabelRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$`)
var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

var validPlans = map[string]bool{
	"free":       true,
	"starter":    true,
	"pro":        true,
	"enterprise": true,
}

func validateTenantName(name string) error {
	if !dnsLabelRe.MatchString(name) {
		return fmt.Errorf("invalid tenant name %q: must be lowercase alphanumeric and hyphens (DNS label, 1–63 chars)", name)
	}
	return nil
}

func validatePlan(plan string) error {
	if !validPlans[plan] {
		return fmt.Errorf("invalid plan %q: must be one of free, starter, pro, enterprise", plan)
	}
	return nil
}

func validateEmail(email string) error {
	if !emailRe.MatchString(email) {
		return fmt.Errorf("invalid email address %q", email)
	}
	return nil
}

// ---------------------------------------------------------------------------
// kubectl helpers
// ---------------------------------------------------------------------------

// kubectlApply pipes yaml to `kubectl apply -f -`.
func kubectlApply(yaml string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(yaml)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// kubectlRun runs kubectl with the given args and returns combined output.
func kubectlRun(args ...string) (string, error) {
	cmd := exec.Command("kubectl", args...)
	var out bytes.Buffer
	var errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		if errBuf.Len() > 0 {
			return "", fmt.Errorf("%w\n%s", err, strings.TrimSpace(errBuf.String()))
		}
		return "", err
	}
	return out.String(), nil
}

// ---------------------------------------------------------------------------
// Root tenant command
// ---------------------------------------------------------------------------

var tenantCmd = &cobra.Command{
	Use:   "tenant",
	Short: "Manage Tinai Cloud tenants (Tenant CRD)",
}

// ---------------------------------------------------------------------------
// tenant create
// ---------------------------------------------------------------------------

var tenantCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a new Tenant CR",
	Long: `Creates a Tenant custom resource via kubectl apply.

Examples:
  tinai tenant create acme-corp --plan=starter --owner=admin@acme.com
  tinai tenant create my-tenant --plan=pro    --owner=ops@example.com`,
	Args: cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		name := args[0]

		if err := validateTenantName(name); err != nil {
			return err
		}
		if err := validatePlan(tenantCreatePlan); err != nil {
			return err
		}
		if err := validateEmail(tenantCreateOwner); err != nil {
			return err
		}

		yaml := fmt.Sprintf(`apiVersion: tinai.cloud/v1alpha1
kind: Tenant
metadata:
  name: %s
spec:
  displayName: "%s"
  owner: "%s"
  plan: %s
`, name, name, tenantCreateOwner, tenantCreatePlan)

		fmt.Printf("Creating tenant %q (plan=%s, owner=%s)...\n", name, tenantCreatePlan, tenantCreateOwner)
		if err := kubectlApply(yaml); err != nil {
			return fmt.Errorf("kubectl apply failed: %w", err)
		}
		fmt.Printf("Tenant %q created.\n", name)
		return nil
	},
}

// ---------------------------------------------------------------------------
// tenant list
// ---------------------------------------------------------------------------

var tenantListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all Tenant CRs",
	Long:  `Fetches all Tenant custom resources and prints a formatted table.`,
	Args:  cobra.NoArgs,
	RunE: func(_ *cobra.Command, _ []string) error {
		// Use custom-columns to get a machine-readable multi-column output.
		// Columns: NAME | PLAN | PHASE | NAMESPACE | AGE
		out, err := kubectlRun(
			"get", "tenants",
			"-o", "custom-columns=NAME:.metadata.name,PLAN:.spec.plan,PHASE:.status.phase,NAMESPACE:.status.namespace,CREATED:.metadata.creationTimestamp",
			"--no-headers",
		)
		if err != nil {
			return fmt.Errorf("kubectl get tenants: %w", err)
		}

		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) == 0 || (len(lines) == 1 && lines[0] == "") {
			fmt.Println("No tenants found.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "NAME\tPLAN\tPHASE\tNAMESPACE\tAGE")
		fmt.Fprintln(w, "----\t----\t-----\t---------\t---")

		for _, line := range lines {
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			for len(fields) < 5 {
				fields = append(fields, "<none>")
			}
			name := fields[0]
			plan := fields[1]
			phase := fields[2]
			ns := fields[3]
			created := fields[4]

			age := humanAge(created)
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", name, plan, phase, ns, age)
		}
		return w.Flush()
	},
}

// humanAge converts an RFC3339 timestamp to a human-readable age string.
// Returns the raw value unchanged if it cannot be parsed.
func humanAge(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// ---------------------------------------------------------------------------
// tenant delete
// ---------------------------------------------------------------------------

var tenantDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete a Tenant CR (does NOT remove the namespace)",
	Long: `Deletes the named Tenant custom resource after interactive confirmation.

The tenant namespace is NOT deleted — only the CRD object is removed.`,
	Args: cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		name := args[0]

		if err := validateTenantName(name); err != nil {
			return err
		}

		fmt.Printf("Delete tenant %q? This removes the CRD but NOT the namespace.\nType the tenant name to confirm: ", name)

		scanner := bufio.NewScanner(os.Stdin)
		scanner.Scan()
		input := strings.TrimSpace(scanner.Text())

		if input != name {
			return fmt.Errorf("confirmation failed: typed %q, expected %q — aborting", input, name)
		}

		fmt.Printf("Deleting tenant %q...\n", name)
		out, err := kubectlRun("delete", "tenant", name)
		if err != nil {
			return fmt.Errorf("kubectl delete tenant: %w", err)
		}
		if out != "" {
			fmt.Print(out)
		}
		fmt.Printf("Tenant %q deleted.\n", name)
		return nil
	},
}

// ---------------------------------------------------------------------------
// tenant status
// ---------------------------------------------------------------------------

var tenantStatusCmd = &cobra.Command{
	Use:   "status <name>",
	Short: "Show detailed status of a Tenant CR",
	Long:  `Retrieves the Tenant CR and pretty-prints the status section.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		name := args[0]

		if err := validateTenantName(name); err != nil {
			return err
		}

		// Fetch core fields via custom-columns for the summary header.
		summary, err := kubectlRun(
			"get", "tenant", name,
			"-o", "custom-columns=PLAN:.spec.plan,PHASE:.status.phase,NAMESPACE:.status.namespace,OWNER:.spec.owner,CREATED:.metadata.creationTimestamp",
			"--no-headers",
		)
		if err != nil {
			return fmt.Errorf("kubectl get tenant %s: %w", name, err)
		}

		// Fetch full YAML for the status section.
		fullYAML, err := kubectlRun("get", "tenant", name, "-o", "yaml")
		if err != nil {
			return fmt.Errorf("kubectl get tenant %s -o yaml: %w", name, err)
		}

		fields := strings.Fields(strings.TrimSpace(summary))
		for len(fields) < 5 {
			fields = append(fields, "<none>")
		}
		plan, phase, ns, owner, created := fields[0], fields[1], fields[2], fields[3], fields[4]
		age := humanAge(created)

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintf(w, "Tenant:\t%s\n", name)
		fmt.Fprintf(w, "Plan:\t%s\n", plan)
		fmt.Fprintf(w, "Phase:\t%s\n", phase)
		fmt.Fprintf(w, "Namespace:\t%s\n", ns)
		fmt.Fprintf(w, "Owner:\t%s\n", owner)
		fmt.Fprintf(w, "Age:\t%s\n", age)
		w.Flush()

		// Extract and print the status: block from the YAML.
		fmt.Println()
		fmt.Println("--- status ---")
		inStatus := false
		for _, line := range strings.Split(fullYAML, "\n") {
			if line == "status:" {
				inStatus = true
			}
			if inStatus {
				// Stop when we hit a new top-level key (non-indented, non-empty, not "status:").
				if line != "status:" && len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
					break
				}
				fmt.Println(line)
			}
		}

		return nil
	},
}

// ---------------------------------------------------------------------------
// tenant upgrade
// ---------------------------------------------------------------------------

var tenantUpgradeCmd = &cobra.Command{
	Use:   "upgrade <name>",
	Short: "Change the plan of a Tenant CR",
	Long: `Patches spec.plan on the named Tenant CR.

Examples:
  tinai tenant upgrade acme-corp --plan=pro
  tinai tenant upgrade my-tenant --plan=enterprise`,
	Args: cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		name := args[0]

		if err := validateTenantName(name); err != nil {
			return err
		}
		if err := validatePlan(tenantUpgradePlan); err != nil {
			return err
		}

		patch := fmt.Sprintf(`{"spec":{"plan":"%s"}}`, tenantUpgradePlan)
		fmt.Printf("Upgrading tenant %q to plan %q...\n", name, tenantUpgradePlan)

		out, err := kubectlRun("patch", "tenant", name, "--type=merge", "-p", patch)
		if err != nil {
			return fmt.Errorf("kubectl patch tenant: %w", err)
		}
		if out != "" {
			fmt.Print(out)
		}
		fmt.Printf("Tenant %q plan updated to %q.\n", name, tenantUpgradePlan)
		return nil
	},
}

// ---------------------------------------------------------------------------
// init — wire flags and subcommands
// ---------------------------------------------------------------------------

func init() {
	// tenant create flags
	tenantCreateCmd.Flags().StringVar(&tenantCreatePlan, "plan", "free", "Plan: free|starter|pro|enterprise")
	tenantCreateCmd.Flags().StringVar(&tenantCreateOwner, "owner", "", "Owner email address (required)")
	_ = tenantCreateCmd.MarkFlagRequired("owner")

	// tenant upgrade flags
	tenantUpgradeCmd.Flags().StringVar(&tenantUpgradePlan, "plan", "", "New plan: free|starter|pro|enterprise (required)")
	_ = tenantUpgradeCmd.MarkFlagRequired("plan")

	// Attach subcommands to tenant
	tenantCmd.AddCommand(tenantCreateCmd)
	tenantCmd.AddCommand(tenantListCmd)
	tenantCmd.AddCommand(tenantDeleteCmd)
	tenantCmd.AddCommand(tenantStatusCmd)
	tenantCmd.AddCommand(tenantUpgradeCmd)
}
