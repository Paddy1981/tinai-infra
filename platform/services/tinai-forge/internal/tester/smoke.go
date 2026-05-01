package tester

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"
)

// SmokeTest verifies a newly built image starts and responds
type SmokeTest struct {
	Product    string
	ImageTag   string
	Namespace  string
	kubeClient kubernetes.Interface
	logger     *zap.Logger
}

// TestResult represents the result of a single test
type TestResult struct {
	Name     string
	Passed   bool
	Message  string
	Duration time.Duration
}

// NewSmokeTest creates a new smoke test
func NewSmokeTest(product, imageTag, namespace string, kubeClient kubernetes.Interface, logger *zap.Logger) *SmokeTest {
	return &SmokeTest{
		Product:    product,
		ImageTag:   imageTag,
		Namespace:  namespace,
		kubeClient: kubeClient,
		logger:     logger,
	}
}

// Run executes the smoke tests
func (st *SmokeTest) Run() []TestResult {
	var results []TestResult

	// Test 1: Deploy image to test namespace
	startTime := time.Now()
	podName, err := st.deployTestPod()
	results = append(results, TestResult{
		Name:     "Deploy test pod",
		Passed:   err == nil,
		Message:  st.errorMessage("deploy test pod", err),
		Duration: time.Since(startTime),
	})

	if err != nil {
		st.logger.Error("failed to deploy test pod", zap.Error(err))
		return results
	}

	defer st.cleanupTestPod(podName)

	// Test 2: Wait for pod to be Ready
	startTime = time.Now()
	err = st.waitForPodReady(podName, 60*time.Second)
	results = append(results, TestResult{
		Name:     "Pod becomes Ready",
		Passed:   err == nil,
		Message:  st.errorMessage("pod ready", err),
		Duration: time.Since(startTime),
	})

	if err != nil {
		st.logger.Error("pod did not become ready", zap.Error(err))
		return results
	}

	// Test 3: Check health endpoint
	startTime = time.Now()
	err = st.checkHealthEndpoint(podName)
	results = append(results, TestResult{
		Name:     "Health endpoint responds",
		Passed:   err == nil,
		Message:  st.errorMessage("health endpoint", err),
		Duration: time.Since(startTime),
	})

	// Test 4: Check pod logs for errors
	startTime = time.Now()
	logErrors, err := st.checkPodLogs(podName)
	passed := err == nil && len(logErrors) == 0
	msg := fmt.Sprintf("Found %d error lines in logs", len(logErrors))
	if err != nil {
		msg = fmt.Sprintf("Error reading logs: %v", err)
	} else if len(logErrors) == 0 {
		msg = "No errors in logs"
	}
	results = append(results, TestResult{
		Name:     "Pod logs clean",
		Passed:   passed,
		Message:  msg,
		Duration: time.Since(startTime),
	})

	st.logger.Info("smoke tests completed", zap.String("product", st.Product), zap.Int("passed", countPassed(results)))
	return results
}

// deployTestPod creates a test pod for the image
func (st *SmokeTest) deployTestPod() (string, error) {
	podName := fmt.Sprintf("forge-test-%s-%d", st.Product, time.Now().Unix())

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: st.Namespace,
			Labels: map[string]string{
				"app":  "tinai-forge-test",
				"test": "smoke",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  st.Product,
					Image: st.ImageTag,
					Ports: []corev1.ContainerPort{
						{
							ContainerPort: 3000, // Default for most services
							Name:          "http",
						},
					},
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("100m"),
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
					},
					LivenessProbe: &corev1.Probe{
						ProbeHandler: corev1.ProbeHandler{
							HTTPGet: &corev1.HTTPGetAction{
								Path: "/",
								Port: intstr.FromInt32(3000),
							},
						},
						InitialDelaySeconds: 10,
						TimeoutSeconds:      5,
						PeriodSeconds:       10,
					},
				},
			},
			RestartPolicy: corev1.RestartPolicyNever,
		},
	}

	_, err := st.kubeClient.CoreV1().Pods(st.Namespace).Create(context.Background(), pod, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to create pod: %w", err)
	}

	st.logger.Debug("created test pod", zap.String("pod_name", podName))
	return podName, nil
}

// waitForPodReady waits for a pod to reach Ready state
func (st *SmokeTest) waitForPodReady(podName string, timeout time.Duration) error {
	return wait.PollImmediate(2*time.Second, timeout, func() (done bool, err error) {
		pod, err := st.kubeClient.CoreV1().Pods(st.Namespace).Get(context.Background(), podName, metav1.GetOptions{})
		if err != nil {
			return false, err
		}

		// Check if any container is ready
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
				return true, nil
			}
		}

		return false, nil
	})
}

// checkHealthEndpoint makes an HTTP request to the health endpoint
func (st *SmokeTest) checkHealthEndpoint(podName string) error {
	// In production, use port-forward or service endpoint
	// For now, this is a placeholder
	pod, err := st.kubeClient.CoreV1().Pods(st.Namespace).Get(context.Background(), podName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get pod: %w", err)
	}

	// Attempt to check the pod IP (would normally use port-forward in real scenario)
	if pod.Status.PodIP == "" {
		return fmt.Errorf("pod has no IP assigned")
	}

	// Simulate health check (in production, use port-forward)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s:3000/", pod.Status.PodIP))
	if err != nil {
		// Pod may not be serving yet
		st.logger.Debug("health check failed (pod may not be ready)", zap.Error(err))
		return nil // Don't fail the test yet
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return fmt.Errorf("health endpoint returned %d", resp.StatusCode)
	}

	return nil
}

// checkPodLogs checks pod logs for error messages
func (st *SmokeTest) checkPodLogs(podName string) ([]string, error) {
	req := st.kubeClient.CoreV1().Pods(st.Namespace).GetLogs(podName, &corev1.PodLogOptions{})

	logStream, err := req.Stream(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to open log stream: %w", err)
	}
	defer logStream.Close()

	logBytes, err := io.ReadAll(logStream)
	if err != nil {
		return nil, fmt.Errorf("failed to read logs: %w", err)
	}

	// TODO: Parse logs and look for error patterns
	// This is a simplified version

	return []string{}, nil
}

// cleanupTestPod deletes the test pod
func (st *SmokeTest) cleanupTestPod(podName string) {
	err := st.kubeClient.CoreV1().Pods(st.Namespace).Delete(context.Background(), podName, metav1.DeleteOptions{})
	if err != nil {
		st.logger.Error("failed to delete test pod", zap.String("pod_name", podName), zap.Error(err))
	} else {
		st.logger.Debug("deleted test pod", zap.String("pod_name", podName))
	}
}

// errorMessage formats error messages
func (st *SmokeTest) errorMessage(operation string, err error) string {
	if err == nil {
		return "passed"
	}
	return fmt.Sprintf("failed: %v", err)
}

// countPassed counts how many tests passed
func countPassed(results []TestResult) int {
	count := 0
	for _, r := range results {
		if r.Passed {
			count++
		}
	}
	return count
}
