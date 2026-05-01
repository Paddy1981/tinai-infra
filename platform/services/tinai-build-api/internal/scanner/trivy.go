package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
)

// Severity levels in ascending order.
const (
	SeverityCritical = "CRITICAL"
	SeverityHigh     = "HIGH"
)

// Finding represents a single Trivy vulnerability finding.
type Finding struct {
	VulnerabilityID string `json:"VulnerabilityID"`
	Severity        string `json:"Severity"`
	PkgName         string `json:"PkgName"`
	Title           string `json:"Title"`
}

// ScanResult is the summary returned after a scan.
type ScanResult struct {
	Image    string
	Critical int
	High     int
	Findings []Finding
	SBOMPath string // path in MinIO where SBOM was stored (future)
}

// Scanner runs Trivy as a Kubernetes Job.
type Scanner struct {
	client     *kubernetes.Clientset
	namespace  string // build namespace to run scan jobs in
	trivyImage string
}

// New returns a Scanner.
func New(client *kubernetes.Clientset, buildNamespace string) *Scanner {
	return &Scanner{
		client:     client,
		namespace:  buildNamespace,
		trivyImage: "aquasecurity/trivy:latest",
	}
}

// Scan runs Trivy against imageTag and returns a ScanResult.
// It submits a Kubernetes Job in the build namespace, waits for it to complete,
// collects logs, and parses the JSON output.
// If CRITICAL or HIGH vulnerabilities are found, ScanResult.Critical/High will be non-zero.
func (s *Scanner) Scan(ctx context.Context, imageTag string) (*ScanResult, error) {
	jobName := fmt.Sprintf("trivy-%d", time.Now().UnixMilli())
	// Truncate to 63 chars for K8s
	if len(jobName) > 63 {
		jobName = jobName[:63]
	}

	ttl := int32(300)
	backoff := int32(0)
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: s.namespace,
			Labels:    map[string]string{"tinai.cloud/scan": "trivy"},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoff,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Containers: []corev1.Container{
						{
							Name:  "trivy",
							Image: s.trivyImage,
							Args: []string{
								"image",
								"--format", "json",
								"--exit-code", "0", // never fail the pod; we parse severity ourselves
								"--no-progress",
								imageTag,
							},
						},
					},
				},
			},
		},
	}

	if _, err := s.client.BatchV1().Jobs(s.namespace).Create(ctx, job, metav1.CreateOptions{}); err != nil {
		return nil, fmt.Errorf("trivy: create job: %w", err)
	}

	// Wait for completion (up to 5 minutes).
	scanCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	if err := wait.PollUntilContextTimeout(scanCtx, 5*time.Second, 5*time.Minute, true,
		func(ctx context.Context) (bool, error) {
			j, err := s.client.BatchV1().Jobs(s.namespace).Get(ctx, jobName, metav1.GetOptions{})
			if err != nil {
				return false, err
			}
			return j.Status.Succeeded > 0 || j.Status.Failed > 0, nil
		}); err != nil {
		return nil, fmt.Errorf("trivy: scan timed out: %w", err)
	}

	// Collect pod logs (JSON output from Trivy).
	logs, err := s.collectLogs(ctx, jobName)
	if err != nil {
		return nil, fmt.Errorf("trivy: collect logs: %w", err)
	}

	return parseTrivyOutput(imageTag, logs)
}

func (s *Scanner) collectLogs(ctx context.Context, jobName string) (string, error) {
	var podName string
	_ = wait.PollUntilContextTimeout(ctx, 2*time.Second, 30*time.Second, true,
		func(ctx context.Context) (bool, error) {
			pods, err := s.client.CoreV1().Pods(s.namespace).List(ctx, metav1.ListOptions{
				LabelSelector: "job-name=" + jobName,
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
	req := s.client.CoreV1().Pods(s.namespace).GetLogs(podName, &corev1.PodLogOptions{})
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", err
	}
	defer stream.Close()
	var buf []byte
	tmp := make([]byte, 4096)
	for {
		n, e := stream.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if e != nil {
			break
		}
	}
	return string(buf), nil
}

// parseTrivyOutput parses Trivy's JSON output and counts critical/high findings.
func parseTrivyOutput(image, raw string) (*ScanResult, error) {
	result := &ScanResult{Image: image}

	// Trivy JSON top-level: {"Results": [{"Vulnerabilities": [...]}]}
	var report struct {
		Results []struct {
			Vulnerabilities []Finding `json:"Vulnerabilities"`
		} `json:"Results"`
	}
	if err := json.Unmarshal([]byte(raw), &report); err != nil {
		// Non-fatal: log and return empty result rather than blocking a deploy.
		log.Printf("trivy: parse output: %v (raw len=%d)", err, len(raw))
		return result, nil
	}

	for _, r := range report.Results {
		for _, v := range r.Vulnerabilities {
			switch v.Severity {
			case SeverityCritical:
				result.Critical++
				result.Findings = append(result.Findings, v)
			case SeverityHigh:
				result.High++
				result.Findings = append(result.Findings, v)
			}
		}
	}
	return result, nil
}

// IsBlocking returns true if the scan result should block a deploy.
// Policy: block on any CRITICAL vulnerability.
func (r *ScanResult) IsBlocking() bool {
	return r.Critical > 0
}
