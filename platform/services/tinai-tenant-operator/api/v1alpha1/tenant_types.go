// Package v1alpha1 contains the Tenant CRD type definitions.
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TenantSpec defines the desired state of a Tenant.
type TenantSpec struct {
	// DisplayName is the human-readable tenant name shown in the dashboard.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	DisplayName string `json:"displayName"`

	// Plan controls resource quotas applied to the tenant namespace.
	// +kubebuilder:validation:Enum=free;starter;pro;enterprise
	// +kubebuilder:default=free
	Plan string `json:"plan,omitempty"`

	// Owner is the email of the tenant's primary admin.
	// +kubebuilder:validation:Format=email
	Owner string `json:"owner"`

	// NetworkPolicy controls whether inter-tenant traffic is blocked.
	// Defaults to true (deny-all between tenants).
	// +kubebuilder:default=true
	NetworkIsolation bool `json:"networkIsolation,omitempty"`
}

// TenantStatus describes the observed state of a Tenant.
type TenantStatus struct {
	// Phase is the current lifecycle state: Provisioning | Active | Suspended | Terminating
	// +kubebuilder:validation:Enum=Provisioning;Active;Suspended;Terminating
	Phase string `json:"phase,omitempty"`

	// NamespaceName is the Kubernetes namespace created for this tenant.
	NamespaceName string `json:"namespaceName,omitempty"`

	// ResourceQuotaName is the ResourceQuota applied in the tenant namespace.
	ResourceQuotaName string `json:"resourceQuotaName,omitempty"`

	// Conditions holds standard Kubernetes condition records.
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=tn
// +kubebuilder:printcolumn:name="Plan",type=string,JSONPath=`.spec.plan`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespaceName`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Tenant represents a tinai.cloud customer with an isolated namespace and quotas.
type Tenant struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   TenantSpec   `json:"spec,omitempty"`
	Status TenantStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// TenantList contains a list of Tenant resources.
type TenantList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Tenant `json:"items"`
}

// planQuotas maps plan name to the ResourceQuota limits applied per tenant.
var planQuotas = map[string]corev1.ResourceList{
	"free": {
		corev1.ResourceRequestsCPU:    resource.MustParse("500m"),
		corev1.ResourceRequestsMemory: resource.MustParse("256Mi"),
		corev1.ResourceLimitsCPU:      resource.MustParse("1"),
		corev1.ResourceLimitsMemory:   resource.MustParse("512Mi"),
		corev1.ResourcePods:           resource.MustParse("5"),
	},
	"starter": {
		corev1.ResourceRequestsCPU:    resource.MustParse("2"),
		corev1.ResourceRequestsMemory: resource.MustParse("1Gi"),
		corev1.ResourceLimitsCPU:      resource.MustParse("4"),
		corev1.ResourceLimitsMemory:   resource.MustParse("2Gi"),
		corev1.ResourcePods:           resource.MustParse("20"),
	},
	"pro": {
		corev1.ResourceRequestsCPU:    resource.MustParse("8"),
		corev1.ResourceRequestsMemory: resource.MustParse("4Gi"),
		corev1.ResourceLimitsCPU:      resource.MustParse("16"),
		corev1.ResourceLimitsMemory:   resource.MustParse("8Gi"),
		corev1.ResourcePods:           resource.MustParse("50"),
	},
	"enterprise": {
		corev1.ResourceRequestsCPU:    resource.MustParse("32"),
		corev1.ResourceRequestsMemory: resource.MustParse("16Gi"),
		corev1.ResourceLimitsCPU:      resource.MustParse("64"),
		corev1.ResourceLimitsMemory:   resource.MustParse("32Gi"),
		corev1.ResourcePods:           resource.MustParse("200"),
	},
}

// QuotaForPlan returns the ResourceList for the given plan name.
// Falls back to free-tier quotas for unknown plans.
func QuotaForPlan(plan string) corev1.ResourceList {
	if q, ok := planQuotas[plan]; ok {
		return q.DeepCopy()
	}
	return planQuotas["free"].DeepCopy()
}

func init() {
	SchemeBuilder.Register(&Tenant{}, &TenantList{})
}
