package forgejo_test

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const forgejoURL = "http://forgejo-test.tinai-forge-test.svc.cluster.local:3000"

// TestForgejoContainerStarts verifies the container starts and health endpoint responds
func TestForgejoContainerStarts(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping container start test in short mode")
	}

	client := getKubeClient(t)
	namespace := "tinai-forge-test"

	// Deploy test pod with the new image
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "forgejo-smoke-test",
			Namespace: namespace,
			Labels: map[string]string{
				"app":         "forgejo",
				"tinai-forge": "test",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:            "forgejo",
					Image:           getTestImage(t),
					ImagePullPolicy: corev1.PullAlways,
					Ports: []corev1.ContainerPort{
						{
							Name:          "http",
							ContainerPort: 3000,
						},
					},
					ReadinessProbe: &corev1.Probe{
						ProbeHandler: corev1.ProbeHandler{
							HTTPGet: &corev1.HTTPGetAction{
								Path: "/api/healthz",
								Port: intstr.FromInt(3000),
							},
						},
						InitialDelaySeconds: 10,
						TimeoutSeconds:      5,
						PeriodSeconds:       5,
					},
				},
			},
			RestartPolicy: corev1.RestartPolicyNever,
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	createdPod, err := client.CoreV1().Pods(namespace).Create(ctx, pod, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create pod: %v", err)
	}
	defer cleanupPod(t, client, namespace, createdPod.Name)

	// Wait up to 60s for Ready state
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		p, err := client.CoreV1().Pods(namespace).Get(ctx, createdPod.Name, metav1.GetOptions{})
		if err != nil {
			t.Logf("Error fetching pod: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}

		// Check if pod is in Failed state
		if p.Status.Phase == corev1.PodFailed {
			t.Fatalf("Pod failed to start. Phase: %s", p.Status.Phase)
		}

		// Check for Ready condition
		for _, condition := range p.Status.Conditions {
			if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
				t.Logf("Pod reached Ready state after %v", time.Since(deadline.Add(-60 * time.Second)))
				return
			}
		}

		time.Sleep(2 * time.Second)
	}

	t.Fatal("Pod did not reach Ready state within 60 seconds")
}

// TestForgejoHealthEndpoint verifies /api/healthz returns 200
func TestForgejoHealthEndpoint(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	deadline := time.Now().Add(30 * time.Second)
	var lastErr error

	for time.Now().Before(deadline) {
		resp, err := client.Get(forgejoURL + "/api/healthz")
		if err != nil {
			lastErr = err
			time.Sleep(2 * time.Second)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			t.Logf("Health endpoint returned 200")
			return
		}

		lastErr = nil
		time.Sleep(2 * time.Second)
	}

	if lastErr != nil {
		t.Fatalf("Health endpoint failed: %v", lastErr)
	}
	t.Fatal("Health endpoint did not return 200 within timeout")
}

// TestForgejoLoginPageLoads verifies the login page renders (200 response, HTML body)
func TestForgejoLoginPageLoads(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(forgejoURL + "/user/login")
	if err != nil {
		t.Fatalf("Failed to fetch login page: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected 200, got %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" || !isHTMLContentType(contentType) {
		t.Errorf("Expected text/html content type, got %s", contentType)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	if len(body) < 1000 {
		t.Errorf("Response body too small (empty page?): %d bytes", len(body))
	}

	t.Logf("Login page loaded successfully: %d bytes", len(body))
}

// TestForgejoDatabaseMigrations verifies DB migrations ran successfully
func TestForgejoDatabaseMigrations(t *testing.T) {
	client := getKubeClient(t)
	namespace := "tinai-forge-test"

	// Get the forgejo pod logs to check for migration messages
	pods, err := client.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: "app=forgejo,tinai-forge=test",
	})

	if err != nil {
		t.Fatalf("Failed to list pods: %v", err)
	}

	if len(pods.Items) == 0 {
		t.Skip("No forgejo test pod found - test environment not ready")
	}

	pod := pods.Items[0]
	logOptions := &corev1.PodLogOptions{
		TailLines: int64Ptr(100),
	}

	req := client.CoreV1().Pods(namespace).GetLogs(pod.Name, logOptions)
	reader, err := req.Stream(context.Background())
	if err != nil {
		t.Fatalf("Failed to read pod logs: %v", err)
	}
	defer reader.Close()

	logs, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("Failed to read log stream: %v", err)
	}

	logStr := string(logs)

	// Check for migration success indicators or errors
	if contains(logStr, "error") || contains(logStr, "migration failed") {
		t.Errorf("Migration errors found in logs")
	}

	// Check for successful migration indicators
	if !contains(logStr, "migration") && !contains(logStr, "Started") {
		t.Logf("No migration messages in logs - assuming success")
	}
}

// TestForgejoAPIResponds verifies the API base responds
func TestForgejoAPIResponds(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(forgejoURL + "/api/v1/version")
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer resp.Body.Close()

	// Accept 200 or 401 (both mean API is up, 401 means auth is enforced)
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized {
		body, _ := io.ReadAll(resp.Body)
		if len(body) > 0 {
			t.Logf("API responded with %d: %s", resp.StatusCode, string(body)[:100])
		}
		return
	}

	t.Errorf("Expected 200 or 401, got %d", resp.StatusCode)
}

// Helper functions

func getTestImage(t *testing.T) string {
	// In real usage, this would come from test flags or environment
	// For now, return a placeholder that tests should override
	image := "localhost:5000/forgejo:latest"
	t.Logf("Using test image: %s", image)
	return image
}

func getKubeClient(t *testing.T) kubernetes.Interface {
	// In real usage, this would be initialized from kubeconfig
	// For testing, this is a placeholder
	t.Skip("Kubernetes client initialization skipped - requires real cluster")
	return nil
}

func cleanupPod(t *testing.T, client kubernetes.Interface, namespace, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	err := client.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil {
		t.Logf("Warning: failed to delete test pod: %v", err)
	}
}

func isHTMLContentType(contentType string) bool {
	return contains(contentType, "text/html") || contains(contentType, "application/xhtml")
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[len(s)-len(substr):] == substr || len(s) > len(substr) && s[:len(s)-len(substr)+1] == substr
}

func int64Ptr(i int64) *int64 {
	return &i
}
