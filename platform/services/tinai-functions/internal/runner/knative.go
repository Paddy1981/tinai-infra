package runner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var knativeServiceGVR = schema.GroupVersionResource{
	Group:    "serving.knative.dev",
	Version:  "v1",
	Resource: "services",
}

// classifyFunction inspects JavaScript source code and returns a workload class:
//   - "io"      — code contains network/filesystem I/O markers
//   - "cpu"     — code contains compute-intensive markers (and no I/O markers)
//   - "default" — everything else
func classifyFunction(code string) string {
	ioMarkers := []string{
		"fetch(", "http.", "axios", "request(", "XMLHttpRequest",
		"WebSocket", "fs.", "readFile", "writeFile",
	}
	for _, m := range ioMarkers {
		if strings.Contains(code, m) {
			return "io"
		}
	}
	cpuMarkers := []string{
		"for (", "while (", "Math.", "crypto.", "Buffer.",
		"btoa", "atob", "JSON.parse", "JSON.stringify",
	}
	for _, m := range cpuMarkers {
		if strings.Contains(code, m) {
			return "cpu"
		}
	}
	return "default"
}

// autoscalerAnnotations maps function class to the Knative autoscaler
// annotations that should be applied to the Service template metadata.
var autoscalerAnnotations = map[string]map[string]string{
	"io": {
		"autoscaling.knative.dev/class":                          "kpa.autoscaling.knative.dev",
		"autoscaling.knative.dev/metric":                         "concurrency",
		"autoscaling.knative.dev/target":                         "100",
		"autoscaling.knative.dev/scale-to-zero-pod-retention-period": "2m",
		"autoscaling.knative.dev/initial-scale":                  "1",
	},
	"cpu": {
		"autoscaling.knative.dev/class":                          "kpa.autoscaling.knative.dev",
		"autoscaling.knative.dev/metric":                         "cpu",
		"autoscaling.knative.dev/target":                         "70",
		"autoscaling.knative.dev/scale-to-zero-pod-retention-period": "30s",
		"autoscaling.knative.dev/initial-scale":                  "1",
	},
	"default": {
		"autoscaling.knative.dev/class":                          "kpa.autoscaling.knative.dev",
		"autoscaling.knative.dev/metric":                         "concurrency",
		"autoscaling.knative.dev/target":                         "50",
		"autoscaling.knative.dev/scale-to-zero-pod-retention-period": "1m",
		"autoscaling.knative.dev/initial-scale":                  "0",
	},
}

// KnativeRunner executes tenant functions as Knative Services.
// It creates or updates a Knative Service for the function, then invokes
// it via HTTP POST (the Knative Service URL).
//
// The `code` parameter received by InvokeFunction is treated as the OCI
// image tag for the Knative Service container.
type KnativeRunner struct {
	dynamic    dynamic.Interface
	httpClient *http.Client
	domain     string // e.g. fn.tinai.cloud
}

// NewKnative returns a KnativeRunner backed by a dynamic Kubernetes client.
func NewKnative(dyn dynamic.Interface) *KnativeRunner {
	domain := os.Getenv("KNATIVE_DOMAIN")
	if domain == "" {
		domain = "fn.tinai.cloud"
	}
	return &KnativeRunner{
		dynamic:    dyn,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		domain:     domain,
	}
}

// InvokeFunction satisfies the FunctionRunner interface.
// `code` is interpreted as the OCI image tag for the Knative Service container.
// It upserts the Knative Service, then invokes it via HTTP POST with payload as the body.
func (r *KnativeRunner) InvokeFunction(ctx context.Context, tenant, name, code, payload string) (string, error) {
	ns := namespace(tenant) // namespace helper defined in k8s.go (same package)

	if err := r.upsertKnativeService(ctx, ns, name, code); err != nil {
		return "", fmt.Errorf("knative upsert service: %w", err)
	}

	// Invoke via HTTP — Knative routes to the correct revision.
	// URL pattern: http://{name}.{ns}.{domain}
	invokeURL := fmt.Sprintf("http://%s.%s.%s", name, ns, r.domain)
	resp, err := r.httpClient.Post(invokeURL, "application/json", bytes.NewBufferString(payload))
	if err != nil {
		return "", fmt.Errorf("knative invoke: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MB limit
	if err != nil {
		return "", fmt.Errorf("knative read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("function returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	return string(body), nil
}

// upsertKnativeService creates or updates the Knative Service via server-side apply.
// imageTag is the OCI image used for the container; it is also used to classify
// the workload type so that appropriate autoscaler annotations are applied.
func (r *KnativeRunner) upsertKnativeService(ctx context.Context, ns, name, imageTag string) error {
	// Classify by image tag (which carries the code identifier in Knative mode).
	class := classifyFunction(imageTag)
	tmplAnnotations := map[string]interface{}{}
	for k, v := range autoscalerAnnotations[class] {
		tmplAnnotations[k] = v
	}

	svc := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "serving.knative.dev/v1",
			"kind":       "Service",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": ns,
				"labels": map[string]interface{}{
					"tinai.cloud/managed-by": "tinai-functions",
					"tinai.cloud/function":   name,
				},
				"annotations": map[string]interface{}{
					"autoscaling.knative.dev/min-scale": "0",
					"autoscaling.knative.dev/max-scale": "5",
				},
			},
			"spec": map[string]interface{}{
				"template": map[string]interface{}{
					"metadata": map[string]interface{}{
						"annotations": tmplAnnotations,
					},
					"spec": map[string]interface{}{
						"containerConcurrency": int64(10),
						"timeoutSeconds":       int64(60),
						"containers": []interface{}{
							map[string]interface{}{
								"image": imageTag,
								"resources": map[string]interface{}{
									"requests": map[string]interface{}{
										"cpu":    "100m",
										"memory": "128Mi",
									},
									"limits": map[string]interface{}{
										"cpu":    "500m",
										"memory": "256Mi",
									},
								},
							},
						},
					},
				},
			},
		},
	}

	_, err := r.dynamic.Resource(knativeServiceGVR).Namespace(ns).
		Apply(ctx, name, svc, metav1.ApplyOptions{FieldManager: "tinai-functions", Force: true})
	return err
}
