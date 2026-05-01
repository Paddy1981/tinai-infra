package builder

import (
	"context"
	"fmt"
	"io"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"
)

// BuildJob represents a container image build job
type BuildJob struct {
	Product      string
	Version      string
	PatchVersion string
	Dockerfile   string
	Context      string
	Destination  string
}

// KanikoBuilder manages Kaniko build jobs in Kubernetes
type KanikoBuilder struct {
	kubeClient kubernetes.Interface
	namespace  string
	registry   string
	logger     *zap.Logger
}

// NewKanikoBuilder creates a new Kaniko builder
func NewKanikoBuilder(kubeClient kubernetes.Interface, namespace, registry string, logger *zap.Logger) *KanikoBuilder {
	return &KanikoBuilder{
		kubeClient: kubeClient,
		namespace:  namespace,
		registry:   registry,
		logger:     logger,
	}
}

// CreateBuildJob creates a Kubernetes Job for building a container image
func (kb *KanikoBuilder) CreateBuildJob(job BuildJob) (*batchv1.Job, error) {
	jobName := fmt.Sprintf("forge-build-%s-%s", job.Product, job.Version)

	// Kaniko arguments
	args := []string{
		"--dockerfile", "/workspace/Dockerfile",
		"--context", job.Context,
		"--destination", job.Destination,
		"--cache=true",
		"--cache-repo", fmt.Sprintf("%s/cache", kb.registry),
		"--snapshot-mode=redo",
	}

	// Create Job spec
	backoffLimit := int32(3)
	ttlSecondsAfterFinished := int32(3600) // Keep job for 1 hour for debugging

	kubeJob := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: kb.namespace,
			Labels: map[string]string{
				"app":     "tinai-forge",
				"product": job.Product,
				"version": job.Version,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			TTLSecondsAfterFinished: &ttlSecondsAfterFinished,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app":     "tinai-forge",
						"product": job.Product,
					},
				},
				Spec: corev1.PodSpec{
					ServiceAccountName: "tinai-forge-builder",
					RestartPolicy:      corev1.RestartPolicyNever,
					Containers: []corev1.Container{
						{
							Name:  "kaniko",
							Image: "gcr.io/kaniko-project/executor:latest",
							Args:  args,
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "workspace",
									MountPath: "/workspace",
								},
								{
									Name:      "kaniko-secret",
									MountPath: "/kaniko/.docker",
									ReadOnly:  true,
								},
							},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("500m"),
									corev1.ResourceMemory: resource.MustParse("1Gi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("2"),
									corev1.ResourceMemory: resource.MustParse("4Gi"),
								},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "workspace",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
						{
							Name: "kaniko-secret",
							VolumeSource: corev1.VolumeSource{
								Secret: &corev1.SecretVolumeSource{
									SecretName: "kaniko-registry-secret",
								},
							},
						},
					},
				},
			},
		},
	}

	// Create the job
	createdJob, err := kb.kubeClient.BatchV1().Jobs(kb.namespace).Create(context.Background(), kubeJob, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to create build job: %w", err)
	}

	kb.logger.Info("created build job", zap.String("job_name", jobName), zap.String("product", job.Product))
	return createdJob, nil
}

// WaitForJob waits for a job to complete
func (kb *KanikoBuilder) WaitForJob(jobName string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	startTime := time.Now()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("job did not complete within timeout: %w", ctx.Err())
		case <-ticker.C:
			job, err := kb.kubeClient.BatchV1().Jobs(kb.namespace).Get(context.Background(), jobName, metav1.GetOptions{})
			if err != nil {
				return fmt.Errorf("failed to get job status: %w", err)
			}

			if job.Status.Succeeded > 0 {
				kb.logger.Info("build job succeeded", zap.String("job_name", jobName), zap.Duration("duration", time.Since(startTime)))
				return nil
			}

			if job.Status.Failed > 0 {
				return fmt.Errorf("build job failed (failed pods: %d)", job.Status.Failed)
			}

			if job.Status.Active > 0 {
				kb.logger.Debug("job still running", zap.String("job_name", jobName), zap.Int32("active_pods", job.Status.Active))
			}
		}
	}
}

// GetJobLogs retrieves logs from a build job
func (kb *KanikoBuilder) GetJobLogs(jobName string) (string, error) {
	// Get the job to find associated pods
	job, err := kb.kubeClient.BatchV1().Jobs(kb.namespace).Get(context.Background(), jobName, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to get job: %w", err)
	}

	// List pods associated with this job
	selector := fmt.Sprintf("job-name=%s", jobName)
	pods, err := kb.kubeClient.CoreV1().Pods(kb.namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: selector,
	})
	if err != nil {
		return "", fmt.Errorf("failed to list pods: %w", err)
	}

	if len(pods.Items) == 0 {
		return "", fmt.Errorf("no pods found for job %s", jobName)
	}

	// Get logs from the first pod
	pod := pods.Items[0]
	req := kb.kubeClient.CoreV1().Pods(kb.namespace).GetLogs(pod.Name, &corev1.PodLogOptions{})

	logStream, err := req.Stream(context.Background())
	if err != nil {
		return "", fmt.Errorf("failed to open log stream: %w", err)
	}
	defer logStream.Close()

	logBytes, err := io.ReadAll(logStream)
	if err != nil {
		return "", fmt.Errorf("failed to read logs: %w", err)
	}

	kb.logger.Debug("retrieved job logs", zap.String("job_name", jobName), zap.String("pod_name", pod.Name))
	return string(logBytes), nil
}

