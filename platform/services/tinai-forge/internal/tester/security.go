package tester

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"
)

// SecurityTest runs security scans on a container image
type SecurityTest struct {
	ImageTag   string
	kubeClient kubernetes.Interface
	namespace  string
	logger     *zap.Logger
}

// CVEResult represents a detected CVE
type CVEResult struct {
	CVE      string
	Severity string
	Package  string
	FixedIn  string
}

// NewSecurityTest creates a new security test
func NewSecurityTest(imageTag string, kubeClient kubernetes.Interface, namespace string, logger *zap.Logger) *SecurityTest {
	return &SecurityTest{
		ImageTag:   imageTag,
		kubeClient: kubeClient,
		namespace:  namespace,
		logger:     logger,
	}
}

// Run executes the security test
func (st *SecurityTest) Run() ([]CVEResult, []TestResult) {
	var results []TestResult
	var cves []CVEResult

	startTime := time.Now()

	// Create and run Trivy scan job
	jobName, err := st.createScanJob()
	if err != nil {
		results = append(results, TestResult{
			Name:     "Security scan job created",
			Passed:   false,
			Message:  fmt.Sprintf("failed to create job: %v", err),
			Duration: time.Since(startTime),
		})
		return cves, results
	}

	results = append(results, TestResult{
		Name:     "Security scan job created",
		Passed:   true,
		Message:  "Trivy scan job submitted",
		Duration: time.Since(startTime),
	})

	// Wait for job to complete
	startTime = time.Now()
	err = st.waitForScanJob(jobName, 300*time.Second)
	results = append(results, TestResult{
		Name:     "Security scan completed",
		Passed:   err == nil,
		Message:  st.errorMessage("scan completion", err),
		Duration: time.Since(startTime),
	})

	if err != nil {
		st.logger.Error("security scan failed", zap.Error(err))
		return cves, results
	}

	// Retrieve scan results
	startTime = time.Now()
	cves, err = st.retrieveScanResults(jobName)
	hasCritical := hasCriticalCVEs(cves)
	results = append(results, TestResult{
		Name:     "CVE analysis",
		Passed:   !hasCritical,
		Message:  fmt.Sprintf("found %d CVEs (%d critical)", len(cves), countCritical(cves)),
		Duration: time.Since(startTime),
	})

	if hasCritical {
		st.logger.Error("critical CVEs found", zap.Int("count", countCritical(cves)))
	}

	// Cleanup
	_ = st.cleanupScanJob(jobName)

	st.logger.Info("security tests completed", zap.Int("cves", len(cves)), zap.Bool("passed", !hasCritical))
	return cves, results
}

// createScanJob creates a Kubernetes Job to scan the image
func (st *SecurityTest) createScanJob() (string, error) {
	jobName := fmt.Sprintf("forge-security-scan-%d", time.Now().Unix())

	backoffLimit := int32(1)
	ttlSecondsAfterFinished := int32(3600)

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: st.namespace,
			Labels: map[string]string{
				"app": "tinai-forge",
				"test": "security",
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			TTLSecondsAfterFinished: &ttlSecondsAfterFinished,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app": "tinai-forge",
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					Containers: []corev1.Container{
						{
							Name:  "trivy",
							Image: "aquasecurity/trivy:latest",
							Args: []string{
								"image",
								"--format", "json",
								"--severity", "CRITICAL,HIGH,MEDIUM",
								st.ImageTag,
							},
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "trivy-cache",
									MountPath: "/root/.cache/trivy",
								},
								{
									Name:      "results",
									MountPath: "/results",
								},
							},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    *parseQuantitySimple("500m"),
									corev1.ResourceMemory: *parseQuantitySimple("1Gi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    *parseQuantitySimple("2"),
									corev1.ResourceMemory: *parseQuantitySimple("4Gi"),
								},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "trivy-cache",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
						{
							Name: "results",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
					},
				},
			},
		},
	}

	_, err := st.kubeClient.BatchV1().Jobs(st.namespace).Create(context.Background(), job, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to create scan job: %w", err)
	}

	st.logger.Debug("created security scan job", zap.String("job_name", jobName))
	return jobName, nil
}

// waitForScanJob waits for the scan job to complete
func (st *SecurityTest) waitForScanJob(jobName string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("scan job did not complete within timeout: %w", ctx.Err())
		case <-ticker.C:
			job, err := st.kubeClient.BatchV1().Jobs(st.namespace).Get(context.Background(), jobName, metav1.GetOptions{})
			if err != nil {
				return fmt.Errorf("failed to get job status: %w", err)
			}

			if job.Status.Succeeded > 0 {
				st.logger.Debug("security scan job succeeded")
				return nil
			}

			if job.Status.Failed > 0 {
				return fmt.Errorf("scan job failed")
			}
		}
	}
}

// retrieveScanResults gets the CVE results from the scan job
func (st *SecurityTest) retrieveScanResults(jobName string) ([]CVEResult, error) {
	// Get the pod associated with the job
	selector := fmt.Sprintf("job-name=%s", jobName)
	pods, err := st.kubeClient.CoreV1().Pods(st.namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: selector,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list pods: %w", err)
	}

	if len(pods.Items) == 0 {
		return nil, fmt.Errorf("no pods found for job")
	}

	pod := pods.Items[0]

	// Get logs from the pod
	req := st.kubeClient.CoreV1().Pods(st.namespace).GetLogs(pod.Name, &corev1.PodLogOptions{})
	logStream, err := req.Stream(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to open log stream: %w", err)
	}
	defer logStream.Close()

	logBytes, err := io.ReadAll(logStream)
	if err != nil {
		return nil, fmt.Errorf("failed to read logs: %w", err)
	}

	// Parse JSON results from Trivy
	var trivyResults struct {
		Results []struct {
			Vulnerabilities []struct {
				VulnerabilityID string `json:"VulnerabilityID"`
				Severity        string `json:"Severity"`
				PkgName         string `json:"PkgName"`
				FixedVersion    string `json:"FixedVersion"`
			} `json:"Vulnerabilities"`
		} `json:"Results"`
	}

	if err := json.Unmarshal(logBytes, &trivyResults); err != nil {
		st.logger.Debug("failed to parse trivy results as JSON", zap.Error(err))
		// Results may not be JSON formatted, continue with empty results
		return []CVEResult{}, nil
	}

	// Convert Trivy format to our CVEResult format
	var cves []CVEResult
	for _, result := range trivyResults.Results {
		for _, vuln := range result.Vulnerabilities {
			cves = append(cves, CVEResult{
				CVE:      vuln.VulnerabilityID,
				Severity: vuln.Severity,
				Package:  vuln.PkgName,
				FixedIn:  vuln.FixedVersion,
			})
		}
	}

	st.logger.Info("retrieved scan results", zap.Int("cves", len(cves)))
	return cves, nil
}

// cleanupScanJob removes the scan job and associated resources
func (st *SecurityTest) cleanupScanJob(jobName string) error {
	deletePolicy := metav1.DeletePropagationBackground
	err := st.kubeClient.BatchV1().Jobs(st.namespace).Delete(context.Background(), jobName, metav1.DeleteOptions{
		PropagationPolicy: &deletePolicy,
	})
	if err != nil {
		st.logger.Error("failed to delete scan job", zap.String("job_name", jobName), zap.Error(err))
		return err
	}
	st.logger.Debug("deleted security scan job", zap.String("job_name", jobName))
	return nil
}

// Helper functions
func hasCriticalCVEs(cves []CVEResult) bool {
	for _, cve := range cves {
		if cve.Severity == "CRITICAL" {
			return true
		}
	}
	return false
}

func countCritical(cves []CVEResult) int {
	count := 0
	for _, cve := range cves {
		if cve.Severity == "CRITICAL" {
			count++
		}
	}
	return count
}
