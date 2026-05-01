package runner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
)

const (
	invokeTimeout   = 30 * time.Second
	pollInterval    = 500 * time.Millisecond
	fnImage         = "node:20-alpine"
	configMapSuffix = "-code"

	// maxFnNameInJobName is the maximum characters from the function name that
	// can be used in a Job name without exceeding the 63-char Kubernetes limit.
	// Budget: 63 − len("fn-") − len("-") − 13 digits (UnixMilli) = 46.
	maxFnNameInJobName = 46
)

// Runner executes tenant functions as Kubernetes Jobs.
type Runner struct {
	k8s *kubernetes.Clientset
}

// New returns a Runner. If k8s is nil, InvokeFunction will return an error.
func New(k8s *kubernetes.Clientset) *Runner {
	return &Runner{k8s: k8s}
}

// truncateName shortens s to at most max bytes, preserving valid characters.
func truncateName(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// namespace returns the per-tenant K8s namespace name.
func namespace(tenant string) string {
	// Sanitise: lowercase, replace non-alphanumeric (except -) with -
	safe := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			return r
		}
		if r >= 'A' && r <= 'Z' {
			return r + 32 // to lower
		}
		return '-'
	}, tenant)
	return "tinai-fn-" + safe
}

// ensureNamespace creates the namespace if it does not already exist.
func (r *Runner) ensureNamespace(ctx context.Context, ns string) error {
	_, err := r.k8s.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !k8serrors.IsNotFound(err) {
		return fmt.Errorf("get namespace: %w", err)
	}
	_, err = r.k8s.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: ns,
			Labels: map[string]string{
				"tinai.cloud/managed-by": "tinai-functions",
				"tinai.cloud/tenant":     ns,
			},
		},
	}, metav1.CreateOptions{})
	if err != nil && !k8serrors.IsAlreadyExists(err) {
		return fmt.Errorf("create namespace: %w", err)
	}
	return nil
}

// upsertConfigMap stores function code in a ConfigMap so the Job Pod can
// mount it without needing MinIO access.
func (r *Runner) upsertConfigMap(ctx context.Context, ns, name, code string) error {
	cmName := name + configMapSuffix
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cmName,
			Namespace: ns,
			Labels:    map[string]string{"tinai.cloud/function": name},
		},
		Data: map[string]string{"index.js": code},
	}
	_, err := r.k8s.CoreV1().ConfigMaps(ns).Get(ctx, cmName, metav1.GetOptions{})
	if k8serrors.IsNotFound(err) {
		_, err = r.k8s.CoreV1().ConfigMaps(ns).Create(ctx, cm, metav1.CreateOptions{})
	} else if err == nil {
		_, err = r.k8s.CoreV1().ConfigMaps(ns).Update(ctx, cm, metav1.UpdateOptions{})
	}
	if err != nil {
		return fmt.Errorf("upsert configmap: %w", err)
	}
	return nil
}

// InvokeFunction executes the named function code as a K8s Job and returns stdout.
// code is the raw JavaScript source; payload is passed as the first CLI argument.
func (r *Runner) InvokeFunction(ctx context.Context, tenant, name, code, payload string) (string, error) {
	if r.k8s == nil {
		return "", fmt.Errorf("kubernetes client not initialised")
	}

	ns := namespace(tenant)
	jobName := fmt.Sprintf("fn-%s-%d", truncateName(name, maxFnNameInJobName), time.Now().UnixMilli())

	invokeCtx, cancel := context.WithTimeout(ctx, invokeTimeout)
	defer cancel()

	// 1. Ensure namespace
	if err := r.ensureNamespace(invokeCtx, ns); err != nil {
		return "", err
	}

	// 2. Store code in a ConfigMap
	if err := r.upsertConfigMap(invokeCtx, ns, name, code); err != nil {
		return "", err
	}

	// 3. Build the Job spec
	ttl := int32(60) // auto-cleanup after 60s
	backoff := int32(0)
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: ns,
			Labels: map[string]string{
				"tinai.cloud/function": name,
				"tinai.cloud/tenant":   tenant,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoff,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{"tinai.cloud/job": jobName},
				},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptr(true),
						RunAsUser:    ptr(int64(1000)),
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{
						{
							Name:  "runner",
							Image: fnImage,
							Command: []string{
								"node", "/fn/index.js",
							},
							Args: []string{payload},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: ptr(false),
								ReadOnlyRootFilesystem:   ptr(true),
								Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
							},
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "fn-code",
									MountPath: "/fn",
								},
							},
							Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("100m"),
								corev1.ResourceMemory: resource.MustParse("128Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("256Mi"),
							},
						},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "fn-code",
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{
									LocalObjectReference: corev1.LocalObjectReference{
										Name: name + configMapSuffix,
									},
								},
							},
						},
					},
				},
			},
		},
	}

	// 4. Submit Job
	createdJob, err := r.k8s.BatchV1().Jobs(ns).Create(invokeCtx, job, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("create job: %w", err)
	}

	// 5. Poll until complete or timeout
	var finalJob *batchv1.Job
	pollErr := wait.PollUntilContextTimeout(invokeCtx, pollInterval, invokeTimeout, true,
		func(ctx context.Context) (bool, error) {
			j, err := r.k8s.BatchV1().Jobs(ns).Get(ctx, createdJob.Name, metav1.GetOptions{})
			if err != nil {
				return false, err
			}
			finalJob = j
			if j.Status.Succeeded > 0 || j.Status.Failed > 0 {
				return true, nil
			}
			return false, nil
		})

	// 6. Collect Pod logs regardless of poll result
	logs, logErr := r.collectPodLogs(invokeCtx, ns, jobName)

	// 7. Cleanup Job (best-effort) — use a fresh context so cleanup isn't
	// cancelled if the HTTP request context has already expired (e.g. on timeout).
	delPol := metav1.DeletePropagationForeground
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cleanupCancel()
	_ = r.k8s.BatchV1().Jobs(ns).Delete(cleanupCtx, jobName, metav1.DeleteOptions{
		PropagationPolicy: &delPol,
	})

	if pollErr != nil {
		return logs, fmt.Errorf("job poll timeout: %w", pollErr)
	}
	if finalJob != nil && finalJob.Status.Failed > 0 {
		if logErr != nil {
			return "", fmt.Errorf("function failed (no logs: %v)", logErr)
		}
		return "", fmt.Errorf("function exited with error:\n%s", logs)
	}
	if logErr != nil {
		return "", fmt.Errorf("collect logs: %w", logErr)
	}
	return logs, nil
}

// collectPodLogs waits for a Pod associated with the Job to appear, then
// streams its logs.
func (r *Runner) collectPodLogs(ctx context.Context, ns, jobName string) (string, error) {
	// Find Pod by label selector
	var podName string
	_ = wait.PollUntilContextTimeout(ctx, pollInterval, 10*time.Second, true,
		func(ctx context.Context) (bool, error) {
			pods, err := r.k8s.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
				LabelSelector: "tinai.cloud/job=" + jobName,
			})
			if err != nil || len(pods.Items) == 0 {
				return false, nil
			}
			podName = pods.Items[0].Name
			return true, nil
		})

	if podName == "" {
		return "", fmt.Errorf("no pod found for job %s", jobName)
	}

	req := r.k8s.CoreV1().Pods(ns).GetLogs(podName, &corev1.PodLogOptions{})
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", fmt.Errorf("log stream: %w", err)
	}
	defer stream.Close()

	var buf bytes.Buffer
	if _, err := io.Copy(&buf, stream); err != nil {
		return "", fmt.Errorf("read logs: %w", err)
	}
	return buf.String(), nil
}

// ptr returns a pointer to v, for use in Kubernetes API structs that require
// pointer fields (e.g. SecurityContext booleans and integers).
func ptr[T any](v T) *T { return &v }
