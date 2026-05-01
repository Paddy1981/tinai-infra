package builder

import (
	"context"
	"fmt"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// BuildStrategy determines how to build the application.
type BuildStrategy string

const (
	// StrategyDockerfile uses the Dockerfile already present in the repository.
	StrategyDockerfile BuildStrategy = "dockerfile"
	// StrategyGenerated uses an auto-generated Dockerfile based on detected app type.
	StrategyGenerated BuildStrategy = "generated"
	// StrategyNixpacks is reserved for future use with the nixpacks binary.
	StrategyNixpacks BuildStrategy = "nixpacks"
)

// NixpacksBuildParams holds all parameters needed to create a Nixpacks-style build Job.
type NixpacksBuildParams struct {
	AppName             string
	RepoURL             string
	Commit              string
	ImageTag            string
	JobName             string
	BuildNamespace      string
	Strategy            BuildStrategy
	GeneratedDockerfile string // populated when Strategy == StrategyGenerated
	Region              string
}

// CreateNixpacksJob creates a Kubernetes Job that clones the repository and builds the
// container image with Kaniko.  When Strategy is StrategyGenerated and no Dockerfile
// exists in the repo, an init container writes the generated Dockerfile before Kaniko
// runs.  When Strategy is StrategyDockerfile the job fails fast if no Dockerfile is found.
func CreateNixpacksJob(ctx context.Context, client kubernetes.Interface, params NixpacksBuildParams) error {
	ttl := int32(3600)
	backoff := int32(0)

	// Stage 1 is always a git clone.
	cloneContainer := corev1.Container{
		Name:    "clone",
		Image:   "alpine/git:latest",
		Command: []string{"git", "clone", "--depth=1", params.RepoURL, "/workspace"},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("128Mi"),
			},
		},
	}

	initContainers := []corev1.Container{cloneContainer}

	// Stage 2 depends on the chosen strategy.
	if params.Strategy == StrategyGenerated && params.GeneratedDockerfile != "" {
		// Escape single quotes inside the Dockerfile so the heredoc shell injection is safe.
		escapedDockerfile := strings.ReplaceAll(params.GeneratedDockerfile, "'", `'"'"'`)
		generateScript := fmt.Sprintf(`if [ ! -f /workspace/Dockerfile ]; then
  echo 'No Dockerfile found — using auto-generated one based on detected app type'
  cat > /workspace/Dockerfile << 'DOCKERFILE_EOF'
%s
DOCKERFILE_EOF
  echo 'Generated Dockerfile written'
else
  echo 'Dockerfile found — using existing'
fi
cp -r /workspace/. /build-context/`, escapedDockerfile)

		initContainers = append(initContainers, corev1.Container{
			Name:    "generate-dockerfile",
			Image:   "alpine:latest",
			Command: []string{"sh", "-c"},
			Args:    []string{generateScript},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "workspace", MountPath: "/workspace"},
				{Name: "build-context", MountPath: "/build-context"},
			},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("100m"),
					corev1.ResourceMemory: resource.MustParse("64Mi"),
				},
			},
		})
	} else {
		// Dockerfile strategy: fail fast if Dockerfile is absent.
		initContainers = append(initContainers, corev1.Container{
			Name:    "prepare",
			Image:   "alpine:latest",
			Command: []string{"sh", "-c"},
			Args: []string{
				`if [ ! -f /workspace/Dockerfile ]; then echo "ERROR: No Dockerfile found"; exit 1; fi; cp -r /workspace/. /build-context/`,
			},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "workspace", MountPath: "/workspace"},
				{Name: "build-context", MountPath: "/build-context"},
			},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceCPU:    resource.MustParse("100m"),
					corev1.ResourceMemory: resource.MustParse("64Mi"),
				},
			},
		})
	}

	// Truncate commit label to 8 chars to stay within K8s label value limits.
	commitLabel := params.Commit
	if len(commitLabel) > 8 {
		commitLabel = commitLabel[:8]
	}

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      params.JobName,
			Namespace: params.BuildNamespace,
			Labels: map[string]string{
				"tinai.cloud/component": "build",
				"tinai.cloud/app":       params.AppName,
				"tinai.cloud/commit":    commitLabel,
				"tinai.cloud/strategy":  string(params.Strategy),
				"tinai.cloud/region":    params.Region,
			},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: &ttl,
			BackoffLimit:            &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"tinai.cloud/component": "build",
						"tinai.cloud/app":       params.AppName,
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy:      corev1.RestartPolicyNever,
					ServiceAccountName: "tinai-build-sa",
					InitContainers:     initContainers,
					Containers: []corev1.Container{
						{
							Name:  "build-and-push",
							Image: "gcr.io/kaniko-project/executor:v1.23.2",
							Args: []string{
								"--context=/build-context",
								fmt.Sprintf("--destination=%s", params.ImageTag),
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
							Name:         "workspace",
							VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
						},
						{
							Name:         "build-context",
							VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
						},
						{
							Name: "kaniko-creds",
							VolumeSource: corev1.VolumeSource{
								Secret: &corev1.SecretVolumeSource{SecretName: "kaniko-registry-creds"},
							},
						},
					},
				},
			},
		},
	}

	_, err := client.BatchV1().Jobs(params.BuildNamespace).Create(ctx, job, metav1.CreateOptions{})
	return err
}
