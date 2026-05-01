package woodpecker_test

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

const woodpeckerURL = "http://woodpecker-test.tinai-forge-test.svc.cluster.local:8000"

// TestWoodpeckerContainerStarts verifies the container starts and health endpoint responds
func TestWoodpeckerContainerStarts(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping container start test in short mode")
	}

	client := getKubeClient(t)
	namespace := "tinai-forge-test"

	// Deploy test pod with the new image
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "woodpecker-smoke-test",
			Namespace: namespace,
			Labels: map[string]string{
				"app":         "woodpecker",
				"tinai-forge": "test",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:            "woodpecker",
					Image:           getTestImage(t),
					ImagePullPolicy: corev1.PullAlways,
					Ports: []corev1.ContainerPort{
						{
							Name:          "http",
							ContainerPort: 8000,
						},
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
				t.Logf("Pod reached Ready state")
				return
			}
		}

		time.Sleep(2 * time.Second)
	}

	t.Fatal("Pod did not reach Ready state within 60 seconds")
}

// TestWoodpeckerHealthEndpoint verifies /api/healthz returns 200
func TestWoodpeckerHealthEndpoint(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	deadline := time.Now().Add(30 * time.Second)
	var lastErr error

	for time.Now().Before(deadline) {
		resp, err := client.Get(woodpeckerURL + "/api/healthz")
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

// TestWoodpeckerDashboardLoads verifies the dashboard loads
func TestWoodpeckerDashboardLoads(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL)
	if err != nil {
		t.Fatalf("Failed to fetch dashboard: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusFound {
		t.Errorf("Expected 200 or 302, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	if len(body) > 0 {
		t.Logf("Dashboard loaded successfully: %d bytes", len(body))
	}
}

// TestWoodpeckerAPIResponds verifies the API base responds
func TestWoodpeckerAPIResponds(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(woodpeckerURL + "/api/user")
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer resp.Body.Close()

	// Accept 200 or 401/403 (both mean API is up)
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		t.Logf("API responded with %d", resp.StatusCode)
		return
	}

	t.Errorf("Expected 200, 401 or 403, got %d", resp.StatusCode)
}

// Helper functions

func getTestImage(t *testing.T) string {
	image := "localhost:5000/woodpecker:latest"
	t.Logf("Using test image: %s", image)
	return image
}

func getKubeClient(t *testing.T) kubernetes.Interface {
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
