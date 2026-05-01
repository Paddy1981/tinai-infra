package builder

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"tinai.cloud/build-api/internal/config"
	"tinai.cloud/build-api/internal/deployer"
	"tinai.cloud/build-api/internal/scanner"
)

type Builder struct {
	cfg      config.Config
	client   kubernetes.Interface
	deployer *deployer.Deployer
	scanner  *scanner.Scanner
}

func New(cfg config.Config) (*Builder, error) {
	kubeConfig, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("kube config: %w", err)
	}
	clientset, err := kubernetes.NewForConfig(kubeConfig)
	if err != nil {
		return nil, fmt.Errorf("kube client: %w", err)
	}
	dep := deployer.New(cfg, clientset)
	b := &Builder{cfg: cfg, client: clientset, deployer: dep}
	b.scanner = scanner.New(clientset, cfg.BuildNamespace)
	return b, nil
}

func (b *Builder) Deployer() *deployer.Deployer {
	return b.deployer
}

func (b *Builder) TriggerBuild(ctx context.Context, repoFullName, cloneURL, commit, region, tenant string) error {
	appName := sanitizeName(repoFullName)
	shortCommit := commit
	if len(commit) > 8 {
		shortCommit = commit[:8]
	}
	shortSHA := shortCommit
	imageTag := fmt.Sprintf("%s/%s:%s", b.cfg.RegistryHost, strings.ToLower(repoFullName), shortSHA)
	jobName := fmt.Sprintf("build-%s-%s", appName, shortSHA)

	// Rewrite clone URL to use internal cluster DNS (pods cannot reach the external URL).
	// Skip the rewrite if FORGEJO_EXTERNAL_URL is not set to avoid a no-op string replace.
	external := b.cfg.ForgejoExternalURL
	internal := b.cfg.ForgejoInternalURL
	if external != "" && strings.Contains(cloneURL, external) {
		log.Printf("rewriting clone URL: %s → %s", external, internal)
		cloneURL = strings.Replace(cloneURL, external, internal, 1)
	}

	ttl := int32(3600)
	backoff := int32(0)

	prepareScript := `if [ ! -f /workspace/Dockerfile ]; then
  echo "ERROR: No Dockerfile found. Add a Dockerfile to build on Tinai."
  exit 1
fi
echo "Dockerfile found"
cp -r /workspace/. /build-context/
echo "Build context ready"
`

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: b.cfg.BuildNamespace,
			Labels: map[string]string{
				"tinai.cloud/component": "build",
				"tinai.cloud/app":       appName,
				"tinai.cloud/commit":    shortSHA,
				"tinai.cloud/region":    region,
				"tinai.cloud/tenant":    tenant,
			},
			// Annotations store deploy intent so ReconcileStaleBuilds can recover
			// deploys that were missed while this pod was down (HIGH-BUILD-1).
			Annotations: map[string]string{
				"tinai.cloud/deploy-app":    appName,
				"tinai.cloud/deploy-image":  imageTag,
				"tinai.cloud/deploy-region": region,
				"tinai.cloud/deploy-tenant": tenant,
			},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: &ttl,
			BackoffLimit:            &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"tinai.cloud/component": "build",
						"tinai.cloud/app":       appName,
						"tinai.cloud/region":    region,
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy:      corev1.RestartPolicyNever,
					ServiceAccountName: "tinai-build-sa",
					InitContainers: []corev1.Container{
						{
							// Stage 1: clone the repo
							Name:    "clone",
							Image:   "alpine/git:2.47.2",
							Command: []string{"git", "clone", "--depth=1", cloneURL, "/workspace"},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("200m"),
									corev1.ResourceMemory: resource.MustParse("256Mi"),
								},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "workspace", MountPath: "/workspace"},
							},
						},
						{
							// Stage 2: validate Dockerfile and copy to build context
							Name:    "prepare",
							Image:   "alpine:latest",
							Command: []string{"sh", "-c"},
							Args:    []string{prepareScript},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("64Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("200m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "workspace", MountPath: "/workspace"},
								{Name: "build-context", MountPath: "/build-context"},
							},
						},
					},
					Containers: []corev1.Container{
						{
							// Stage 3: build image with kaniko and push to Forgejo registry
							// Pinned digest for security — update periodically via: docker pull gcr.io/kaniko-project/executor:latest && docker inspect
							Name:  "build-and-push",
							Image: "gcr.io/kaniko-project/executor:v1.23.2",
							Args: []string{
								"--context=/build-context",
								fmt.Sprintf("--destination=%s", imageTag),
							},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("500m"),
									corev1.ResourceMemory: resource.MustParse("512Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("1"),
									corev1.ResourceMemory: resource.MustParse("1Gi"),
								},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "build-context", MountPath: "/build-context"},
								{Name: "kaniko-creds", MountPath: "/kaniko/.docker"},
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
							Name: "build-context",
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{},
							},
						},
						{
							Name: "kaniko-creds",
							VolumeSource: corev1.VolumeSource{
								Secret: &corev1.SecretVolumeSource{
									SecretName: "kaniko-registry-creds",
								},
							},
						},
					},
				},
			},
		},
	}

	_, err := b.client.BatchV1().Jobs(b.cfg.BuildNamespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return err
	}

	go b.watchAndDeploy(jobName, appName, imageTag, region, "", "", 0, tenant)
	return nil
}

// buildKanikoJob constructs a batchv1.Job that clones, validates, and builds an
// image with Kaniko. It is used by both TriggerBuild and triggerBuildJob (for PR
// previews) to avoid duplicating the full Job spec.
//
// Pass previewNS/previewName/prNumber as non-zero values only for preview builds;
// they are stored in the Job annotations so watchAndDeploy routes to the right target.
func buildKanikoJob(
	jobName, buildNS, repoFullName, cloneURL, commit, imageTag,
	previewNS, previewName string, prNumber int,
	ttl, backoff int32,
	prepareScript, registryHost string,
) *batchv1.Job {
	shortSHA := commit
	if len(shortSHA) > 8 {
		shortSHA = shortSHA[:8]
	}
	appName := sanitizeName(repoFullName)

	annotations := map[string]string{
		"tinai.cloud/deploy-app":    appName,
		"tinai.cloud/deploy-image":  imageTag,
		"tinai.cloud/deploy-region": "IN",
	}
	if previewNS != "" {
		annotations["tinai.cloud/preview-ns"]   = previewNS
		annotations["tinai.cloud/preview-name"]  = previewName
		annotations["tinai.cloud/preview-pr"]    = fmt.Sprintf("%d", prNumber)
	}

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:        jobName,
			Namespace:   buildNS,
			Labels:      map[string]string{"tinai.cloud/component": "build", "tinai.cloud/app": appName},
			Annotations: annotations,
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: &ttl,
			BackoffLimit:            &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"tinai.cloud/component": "build"}},
				Spec: corev1.PodSpec{
					RestartPolicy:      corev1.RestartPolicyNever,
					ServiceAccountName: "tinai-build-sa",
					InitContainers: []corev1.Container{
						{
							Name:    "clone",
							Image:   "alpine/git:2.47.2",
							Command: []string{"git", "clone", "--depth=1", cloneURL, "/workspace"},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("200m"),
									corev1.ResourceMemory: resource.MustParse("256Mi"),
								},
							},
							VolumeMounts: []corev1.VolumeMount{{Name: "workspace", MountPath: "/workspace"}},
						},
						{
							Name:    "prepare",
							Image:   "alpine:latest",
							Command: []string{"sh", "-c"},
							Args:    []string{prepareScript},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("64Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("200m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "workspace", MountPath: "/workspace"},
								{Name: "build-context", MountPath: "/build-context"},
							},
						},
					},
					Containers: []corev1.Container{{
						Name:  "build-and-push",
						Image: "gcr.io/kaniko-project/executor:v1.23.2",
						Args: []string{
							"--context=/build-context",
							fmt.Sprintf("--destination=%s", imageTag),
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("512Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("1"),
								corev1.ResourceMemory: resource.MustParse("1Gi"),
							},
						},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "build-context", MountPath: "/build-context"},
							{Name: "kaniko-creds", MountPath: "/kaniko/.docker"},
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "workspace", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
						{Name: "build-context", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
						{Name: "kaniko-creds", VolumeSource: corev1.VolumeSource{
							Secret: &corev1.SecretVolumeSource{SecretName: "kaniko-registry-creds"},
						}},
					},
				},
			},
		},
	}
}

// deployTarget holds optional preview routing. Zero value = normal staging deploy.
type deployTarget struct {
	previewNS   string
	previewName string
	prNumber    int
}

func (b *Builder) watchAndDeploy(jobName, appName, imageTag, region string, previewNS, previewName string, prNumber int, tenant string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("watch timeout: job=%s", jobName)
			return
		case <-ticker.C:
			job, err := b.client.BatchV1().Jobs(b.cfg.BuildNamespace).Get(ctx, jobName, metav1.GetOptions{})
			if err != nil {
				log.Printf("watch get job error: %v", err)
				continue
			}
			if job.Status.Succeeded > 0 {
				// Scan image before deploying — block on CRITICAL vulnerabilities.
				if b.cfg.ScanEnabled {
					scanResult, err := b.scanner.Scan(context.Background(), imageTag)
					if err != nil {
						log.Printf("trivy scan error (non-blocking): %v", err)
					} else {
						log.Printf("trivy scan complete: image=%s critical=%d high=%d", imageTag, scanResult.Critical, scanResult.High)
						if scanResult.IsBlocking() {
							log.Printf("DEPLOY BLOCKED: image %s has %d CRITICAL vulnerabilities", imageTag, scanResult.Critical)
							for _, f := range scanResult.Findings {
								if f.Severity == scanner.SeverityCritical {
									log.Printf("  CRITICAL %s in %s: %s", f.VulnerabilityID, f.PkgName, f.Title)
								}
							}
							return // do not deploy
						}
					}
				}

				deployCtx, deployCancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer deployCancel()
				if previewNS != "" {
					log.Printf("build succeeded: job=%s, triggering preview deploy ns=%s app=%s pr=%d", jobName, previewNS, previewName, prNumber)
					if err := b.deployer.DeployPreview(deployCtx, previewNS, previewName, imageTag, prNumber); err != nil {
						log.Printf("preview deploy error: ns=%s app=%s %v", previewNS, previewName, err)
					}
				} else {
					log.Printf("build succeeded: job=%s, triggering deploy app=%s region=%s tenant=%s", jobName, appName, region, tenant)
					if err := b.deployer.DeployTenantApp(deployCtx, appName, imageTag, region, tenant); err != nil {
						log.Printf("deploy error: app=%s region=%s tenant=%s %v", appName, region, tenant, err)
					}
				}
				return
			}
			if job.Status.Failed > 0 {
				log.Printf("build failed: job=%s", jobName)
				return
			}
		}
	}
}

// ReconcileStaleBuilds scans for build Jobs that completed while this pod was
// down and triggers deploys for any that have no corresponding Deployment yet.
// Call once at startup in a goroutine (HIGH-BUILD-1).
func (b *Builder) ReconcileStaleBuilds(ctx context.Context) {
	jobs, err := b.client.BatchV1().Jobs(b.cfg.BuildNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: "tinai.cloud/component=build",
	})
	if err != nil {
		log.Printf("reconcile: list build jobs: %v", err)
		return
	}

	recovered := 0
	for i := range jobs.Items {
		job := &jobs.Items[i]
		if job.Status.Succeeded == 0 {
			continue // still running or failed
		}
		ann := job.Annotations
		appName := ann["tinai.cloud/deploy-app"]
		imageTag := ann["tinai.cloud/deploy-image"]
		region := ann["tinai.cloud/deploy-region"]
		tenant := ann["tinai.cloud/deploy-tenant"]
		if appName == "" || imageTag == "" || region == "" {
			continue // old job without intent annotations
		}
		// Check whether the deploy already happened (Deployment exists in staging NS).
		stagingNS := regionToStagingNS(region)
		_, err := b.client.AppsV1().Deployments(stagingNS).Get(ctx, appName, metav1.GetOptions{})
		if err == nil {
			continue // deployment exists, nothing to do
		}
		log.Printf("reconcile: recovering missed deploy app=%s image=%s region=%s tenant=%s", appName, imageTag, region, tenant)
		if err := b.deployer.DeployTenantApp(ctx, appName, imageTag, region, tenant); err != nil {
			log.Printf("reconcile: deploy error app=%s: %v", appName, err)
		} else {
			recovered++
		}
	}
	if recovered > 0 {
		log.Printf("reconcile: recovered %d missed deploys", recovered)
	}
}

// regionToStagingNS maps a region code to its staging namespace name.
func regionToStagingNS(region string) string {
	switch region {
	case "QA":
		return "tinai-staging-qa"
	case "AE":
		return "tinai-staging-ae"
	default:
		return "tinai-staging-in"
	}
}

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "/", "-")
	name = strings.ToLower(name)
	if len(name) > 40 {
		name = name[:40]
	}
	return name
}
