package provisioner

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// BuildInstancePod builds the K8s Pod manifest for a GPU instance.
// dockerImage: full image ref e.g. registry.tinai.cloud/tinai/instances/pytorch:v2.8
// instanceID: UUID, used as pod name and for labels
// gpuCount: 0 means CPU-only pod
// volumeSizeGB: size of the attached PVC
func BuildInstancePod(instanceID, tenantID, dockerImage string, gpuCount, volumeSizeGB int, instanceTypeName string) *corev1.Pod {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "instance-" + instanceID[:8],
			Namespace: "tinai-instances",
			Labels: map[string]string{
				"tinai.cloud/instance-id": instanceID,
				"tinai.cloud/tenant":      tenantID,
				"tinai.cloud/managed-by":  "tinai-instances",
			},
			Annotations: map[string]string{
				"tinai.cloud/instance-type": instanceTypeName,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{
				{
					Name:    "instance",
					Image:   dockerImage,
					Command: []string{"/bin/bash", "-c", "sleep infinity"},
					Ports: []corev1.ContainerPort{
						{Name: "ssh", ContainerPort: 22, Protocol: corev1.ProtocolTCP},
						{Name: "jupyter", ContainerPort: 8888, Protocol: corev1.ProtocolTCP},
					},
					Resources: buildResources(gpuCount, instanceTypeName),
					VolumeMounts: []corev1.VolumeMount{
						{Name: "workspace", MountPath: "/workspace"},
					},
				},
			},
			Volumes: []corev1.Volume{
				{
					Name: "workspace",
					VolumeSource: corev1.VolumeSource{
						PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
							ClaimName: "workspace-" + instanceID[:8],
						},
					},
				},
			},
		},
	}
	if gpuCount > 0 {
		pod.Spec.NodeSelector = map[string]string{
			"tinai.cloud/gpu": "true",
		}
	}
	return pod
}

func buildResources(gpuCount int, typeName string) corev1.ResourceRequirements {
	req := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("4"),
		corev1.ResourceMemory: resource.MustParse("16Gi"),
	}
	lim := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("16"),
		corev1.ResourceMemory: resource.MustParse("64Gi"),
	}
	if gpuCount > 0 {
		q := resource.MustParse(fmt.Sprintf("%d", gpuCount))
		req["nvidia.com/gpu"] = q
		lim["nvidia.com/gpu"] = q
	}
	return corev1.ResourceRequirements{Requests: req, Limits: lim}
}
