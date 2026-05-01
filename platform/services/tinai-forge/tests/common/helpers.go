package common

import (
	"context"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// DeployTestPod deploys a single-container pod for testing
func DeployTestPod(ctx context.Context, client kubernetes.Interface, namespace, name, image string, port int32) error {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app":         name,
				"tinai-forge": "test",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: image,
					Ports: []corev1.ContainerPort{
						{ContainerPort: port},
					},
				},
			},
			RestartPolicy: corev1.RestartPolicyNever,
		},
	}

	_, err := client.CoreV1().Pods(namespace).Create(ctx, pod, metav1.CreateOptions{})
	return err
}

// WaitForPodReady waits until pod reaches Running/Ready state
func WaitForPodReady(ctx context.Context, client kubernetes.Interface, namespace, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}

		// Check for Ready condition
		for _, cond := range pod.Status.Conditions {
			if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
				return nil
			}
		}

		// Check if pod has failed
		if pod.Status.Phase == corev1.PodFailed {
			return fmt.Errorf("pod %s failed", name)
		}

		// Check if container is in CrashLoopBackOff
		for _, containerStatus := range pod.Status.ContainerStatuses {
			if containerStatus.State.Waiting != nil {
				if containerStatus.State.Waiting.Reason == "CrashLoopBackOff" {
					return fmt.Errorf("pod %s in CrashLoopBackOff", name)
				}
			}
		}

		time.Sleep(2 * time.Second)
	}

	return fmt.Errorf("pod %s not ready after %v", name, timeout)
}

// WaitForPodHealthy waits for pod health endpoint to respond
func WaitForPodHealthy(ctx context.Context, client kubernetes.Interface, namespace, name string, healthEndpoint string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	httpClient := &http.Client{Timeout: 5 * time.Second}

	for time.Now().Before(deadline) {
		resp, err := httpClient.Get(healthEndpoint)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			return nil
		}

		if err == nil {
			resp.Body.Close()
		}

		time.Sleep(2 * time.Second)
	}

	return fmt.Errorf("pod %s health endpoint not responding after %v", name, timeout)
}

// DeletePod removes a test pod
func DeletePod(ctx context.Context, client kubernetes.Interface, namespace, name string) error {
	return client.CoreV1().Pods(namespace).Delete(
		ctx, name,
		metav1.DeleteOptions{},
	)
}

// DeletePodForce removes a test pod immediately
func DeletePodForce(ctx context.Context, client kubernetes.Interface, namespace, name string) error {
	gracePeriod := int64(0)
	return client.CoreV1().Pods(namespace).Delete(
		ctx, name,
		metav1.DeleteOptions{
			GracePeriodSeconds: &gracePeriod,
		},
	)
}

// WaitForHTTP polls a URL until it returns the expected status or timeout
func WaitForHTTP(url string, expectedStatus int, timeout time.Duration) error {
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()

			if resp.StatusCode == expectedStatus {
				return nil
			}
		}

		time.Sleep(3 * time.Second)
	}

	return fmt.Errorf("URL %s did not return %d within %v", url, expectedStatus, timeout)
}

// WaitForHTTPAny polls a URL until it returns one of the expected statuses or timeout
func WaitForHTTPAny(url string, expectedStatuses []int, timeout time.Duration) error {
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()

			for _, expected := range expectedStatuses {
				if resp.StatusCode == expected {
					return nil
				}
			}
		}

		time.Sleep(3 * time.Second)
	}

	return fmt.Errorf("URL %s did not return any of %v within %v", url, expectedStatuses, timeout)
}

// CreateNamespace creates a test namespace
func CreateNamespace(ctx context.Context, client kubernetes.Interface, name string) error {
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				"tinai-forge": "test",
			},
		},
	}

	_, err := client.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{})
	return err
}

// DeleteNamespace deletes a test namespace (cascades to all resources)
func DeleteNamespace(ctx context.Context, client kubernetes.Interface, name string) error {
	return client.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{})
}

// GetPodLogs retrieves logs from a pod
func GetPodLogs(ctx context.Context, client kubernetes.Interface, namespace, name string, lines int64) (string, error) {
	options := &corev1.PodLogOptions{
		TailLines: &lines,
	}

	req := client.CoreV1().Pods(namespace).GetLogs(name, options)
	reader, err := req.Stream(ctx)
	if err != nil {
		return "", err
	}
	defer reader.Close()

	buf := make([]byte, 8192)
	n, err := reader.Read(buf)
	if err != nil && err.Error() != "EOF" {
		return "", err
	}

	return string(buf[:n]), nil
}

// GetPodEvents retrieves events for a pod
func GetPodEvents(ctx context.Context, client kubernetes.Interface, namespace, name string) ([]corev1.Event, error) {
	events, err := client.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Pod", name),
	})

	if err != nil {
		return nil, err
	}

	return events.Items, nil
}

// ServiceEndpoint returns the endpoint for a service in the cluster
func ServiceEndpoint(namespace, serviceName string, port int32) string {
	return fmt.Sprintf("http://%s.%s.svc.cluster.local:%d", serviceName, namespace, port)
}

// GetPodStatus returns the status of a pod
func GetPodStatus(ctx context.Context, client kubernetes.Interface, namespace, name string) (string, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}

	return string(pod.Status.Phase), nil
}

// IsPodReady checks if a pod is in Ready condition
func IsPodReady(ctx context.Context, client kubernetes.Interface, namespace, name string) (bool, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, err
	}

	for _, cond := range pod.Status.Conditions {
		if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
			return true, nil
		}
	}

	return false, nil
}

// WaitForPodPhase waits until pod reaches a specific phase
func WaitForPodPhase(ctx context.Context, client kubernetes.Interface, namespace, name string, phase corev1.PodPhase, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}

		if pod.Status.Phase == phase {
			return nil
		}

		time.Sleep(2 * time.Second)
	}

	return fmt.Errorf("pod %s did not reach phase %s within %v", name, phase, timeout)
}

// ListPods returns all pods matching a label selector
func ListPods(ctx context.Context, client kubernetes.Interface, namespace, labelSelector string) ([]corev1.Pod, error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})

	if err != nil {
		return nil, err
	}

	return pods.Items, nil
}

// GetPodRestartCount returns the number of restarts for a pod container
func GetPodRestartCount(ctx context.Context, client kubernetes.Interface, namespace, name, container string) (int32, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return 0, err
	}

	for _, containerStatus := range pod.Status.ContainerStatuses {
		if containerStatus.Name == container {
			return containerStatus.RestartCount, nil
		}
	}

	return 0, fmt.Errorf("container %s not found in pod %s", container, name)
}

// ExecuteCommand runs a command in a pod (requires shell in container)
// This is a placeholder - actual implementation would use exec API
func ExecuteCommand(ctx context.Context, client kubernetes.Interface, namespace, name, container string, command []string) (string, error) {
	// In real implementation, use Kubernetes exec API
	// For now, just return placeholder
	return "", fmt.Errorf("exec not implemented - use kubectl exec instead")
}
