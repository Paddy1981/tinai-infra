// Package controller implements the Tenant reconciler.
// It replaces the provision-tenant.sh shell script with a proper Kubebuilder
// controller that declaratively manages per-tenant Kubernetes resources.
package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	networkv1 "k8s.io/api/networking/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	tinaicloudv1alpha1 "tinai.cloud/tenant-operator/api/v1alpha1"
)

// TenantReconciler reconciles Tenant objects.
type TenantReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=tinai.cloud,resources=tenants,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=tinai.cloud,resources=tenants/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=tinai.cloud,resources=tenants/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=resourcequotas,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=limitranges,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch

const tenantFinalizer = "tinai.cloud/tenant-finalizer"

// Reconcile reads the cluster state and reconciles the desired state for the Tenant.
func (r *TenantReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var tenant tinaicloudv1alpha1.Tenant
	if err := r.Get(ctx, req.NamespacedName, &tenant); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Handle deletion
	if !tenant.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &tenant)
	}

	// Add finalizer
	if !containsString(tenant.Finalizers, tenantFinalizer) {
		tenant.Finalizers = append(tenant.Finalizers, tenantFinalizer)
		if err := r.Update(ctx, &tenant); err != nil {
			return ctrl.Result{}, err
		}
	}

	// Set phase to Provisioning on first reconcile
	if tenant.Status.Phase == "" {
		tenant.Status.Phase = "Provisioning"
		if err := r.Status().Update(ctx, &tenant); err != nil {
			return ctrl.Result{}, err
		}
	}

	nsName := tenantNamespace(tenant.Name)
	logger.Info("reconciling tenant", "tenant", tenant.Name, "namespace", nsName, "plan", tenant.Spec.Plan)

	// 1. Ensure Namespace
	if err := r.ensureNamespace(ctx, &tenant, nsName); err != nil {
		return ctrl.Result{}, fmt.Errorf("ensure namespace: %w", err)
	}

	// 2. Ensure ResourceQuota
	quotaName, err := r.ensureResourceQuota(ctx, &tenant, nsName)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("ensure resourcequota: %w", err)
	}

	// 3. Ensure LimitRange (default container limits)
	if err := r.ensureLimitRange(ctx, nsName); err != nil {
		return ctrl.Result{}, fmt.Errorf("ensure limitrange: %w", err)
	}

	// 4. Ensure NetworkPolicy (deny all inter-tenant traffic)
	if tenant.Spec.NetworkIsolation {
		if err := r.ensureNetworkPolicy(ctx, nsName); err != nil {
			return ctrl.Result{}, fmt.Errorf("ensure networkpolicy: %w", err)
		}
	}

	// 5. Update status
	tenant.Status.Phase = "Active"
	tenant.Status.NamespaceName = nsName
	tenant.Status.ResourceQuotaName = quotaName
	if err := r.Status().Update(ctx, &tenant); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("tenant reconciled successfully", "tenant", tenant.Name, "phase", "Active")
	return ctrl.Result{}, nil
}

func (r *TenantReconciler) reconcileDelete(ctx context.Context, tenant *tinaicloudv1alpha1.Tenant) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	logger.Info("tenant marked for deletion — removing finalizer", "tenant", tenant.Name)

	// We intentionally do NOT delete the namespace here: data inside it
	// (databases, uploads) must be explicitly purged by an admin. This
	// matches the CleanupPreview behaviour in the build-api.
	tenant.Finalizers = removeString(tenant.Finalizers, tenantFinalizer)
	if err := r.Update(ctx, tenant); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// ensureNamespace creates or updates the tenant namespace.
func (r *TenantReconciler) ensureNamespace(ctx context.Context, tenant *tinaicloudv1alpha1.Tenant, nsName string) error {
	ns := &corev1.Namespace{}
	err := r.Get(ctx, types.NamespacedName{Name: nsName}, ns)
	if k8serrors.IsNotFound(err) {
		ns = &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: nsName,
				Labels: map[string]string{
					"tinai.cloud/managed-by": "tenant-operator",
					"tinai.cloud/tenant":     tenant.Name,
					"tinai.cloud/plan":       tenant.Spec.Plan,
				},
			},
		}
		return r.Create(ctx, ns)
	}
	if err != nil {
		return err
	}
	// Update labels if plan changed
	if ns.Labels["tinai.cloud/plan"] != tenant.Spec.Plan {
		ns.Labels["tinai.cloud/plan"] = tenant.Spec.Plan
		return r.Update(ctx, ns)
	}
	return nil
}

// ensureResourceQuota applies the plan's quota to the tenant namespace.
func (r *TenantReconciler) ensureResourceQuota(ctx context.Context, tenant *tinaicloudv1alpha1.Tenant, nsName string) (string, error) {
	quotaName := "tinai-quota"
	desired := &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{
			Name:      quotaName,
			Namespace: nsName,
			Labels:    map[string]string{"tinai.cloud/managed-by": "tenant-operator"},
		},
		Spec: corev1.ResourceQuotaSpec{
			Hard: tinaicloudv1alpha1.QuotaForPlan(tenant.Spec.Plan),
		},
	}

	existing := &corev1.ResourceQuota{}
	err := r.Get(ctx, types.NamespacedName{Name: quotaName, Namespace: nsName}, existing)
	if k8serrors.IsNotFound(err) {
		return quotaName, r.Create(ctx, desired)
	}
	if err != nil {
		return "", err
	}
	existing.Spec = desired.Spec
	return quotaName, r.Update(ctx, existing)
}

// ensureLimitRange sets sensible default request/limit ratios for containers.
func (r *TenantReconciler) ensureLimitRange(ctx context.Context, nsName string) error {
	lrName := "tinai-limits"
	desired := &corev1.LimitRange{
		ObjectMeta: metav1.ObjectMeta{
			Name:      lrName,
			Namespace: nsName,
			Labels:    map[string]string{"tinai.cloud/managed-by": "tenant-operator"},
		},
		Spec: corev1.LimitRangeSpec{
			Limits: []corev1.LimitRangeItem{
				{
					Type: corev1.LimitTypeContainer,
					Default: corev1.ResourceList{
						corev1.ResourceCPU:    mustParse("500m"),
						corev1.ResourceMemory: mustParse("256Mi"),
					},
					DefaultRequest: corev1.ResourceList{
						corev1.ResourceCPU:    mustParse("100m"),
						corev1.ResourceMemory: mustParse("64Mi"),
					},
				},
			},
		},
	}

	existing := &corev1.LimitRange{}
	err := r.Get(ctx, types.NamespacedName{Name: lrName, Namespace: nsName}, existing)
	if k8serrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	existing.Spec = desired.Spec
	return r.Update(ctx, existing)
}

// ensureNetworkPolicy creates a default-deny policy that blocks traffic between
// tenant namespaces while allowing intra-namespace and ingress-controller traffic.
func (r *TenantReconciler) ensureNetworkPolicy(ctx context.Context, nsName string) error {
	npName := "tinai-isolate"
	desired := &networkv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      npName,
			Namespace: nsName,
			Labels:    map[string]string{"tinai.cloud/managed-by": "tenant-operator"},
		},
		Spec: networkv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{}, // applies to all pods
			PolicyTypes: []networkv1.PolicyType{
				networkv1.PolicyTypeIngress,
				networkv1.PolicyTypeEgress,
			},
			Ingress: []networkv1.NetworkPolicyIngressRule{
				{
					// Allow traffic within the same namespace
					From: []networkv1.NetworkPolicyPeer{
						{
							PodSelector: &metav1.LabelSelector{},
						},
					},
				},
				{
					// Allow traffic from the ingress-controller namespace
					From: []networkv1.NetworkPolicyPeer{
						{
							NamespaceSelector: &metav1.LabelSelector{
								MatchLabels: map[string]string{
									"kubernetes.io/metadata.name": "ingress-nginx",
								},
							},
						},
					},
				},
			},
			Egress: []networkv1.NetworkPolicyEgressRule{
				{
					// Allow DNS resolution
					Ports: []networkv1.NetworkPolicyPort{
						{Port: portPtr(53), Protocol: protocolPtr(corev1.ProtocolUDP)},
						{Port: portPtr(53), Protocol: protocolPtr(corev1.ProtocolTCP)},
					},
				},
				{
					// Allow all egress within the same namespace
					To: []networkv1.NetworkPolicyPeer{
						{PodSelector: &metav1.LabelSelector{}},
					},
				},
				{
					// Allow egress to tinai-system (gateway, build-api, etc.)
					To: []networkv1.NetworkPolicyPeer{
						{
							NamespaceSelector: &metav1.LabelSelector{
								MatchLabels: map[string]string{
									"kubernetes.io/metadata.name": "tinai-system",
								},
							},
						},
					},
				},
			},
		},
	}

	existing := &networkv1.NetworkPolicy{}
	err := r.Get(ctx, types.NamespacedName{Name: npName, Namespace: nsName}, existing)
	if k8serrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	existing.Spec = desired.Spec
	return r.Update(ctx, existing)
}

// SetupWithManager registers the controller with the manager.
func (r *TenantReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&tinaicloudv1alpha1.Tenant{}).
		Complete(r)
}

// ─── helpers ────────────────────────────────────────────────────────────────

func tenantNamespace(tenantName string) string {
	return "tinai-tenant-" + tenantName
}

func containsString(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func removeString(slice []string, s string) []string {
	result := make([]string, 0, len(slice))
	for _, v := range slice {
		if v != s {
			result = append(result, v)
		}
	}
	return result
}

func mustParse(s string) resource.Quantity {
	return resource.MustParse(s)
}

func portPtr(p int32) *intstr.IntOrString {
	v := intstr.FromInt32(p)
	return &v
}

func protocolPtr(p corev1.Protocol) *corev1.Protocol {
	return &p
}
