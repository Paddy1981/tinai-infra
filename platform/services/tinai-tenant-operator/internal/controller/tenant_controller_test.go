package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	tinaicloudv1alpha1 "tinai.cloud/tenant-operator/api/v1alpha1"
)

func TestQuotaForPlan(t *testing.T) {
	tests := []struct {
		plan    string
		wantCPU string
	}{
		{"free", "500m"},
		{"starter", "2"},
		{"pro", "8"},
		{"enterprise", "32"},
		{"unknown", "500m"}, // unknown falls back to free
	}
	for _, tc := range tests {
		quota := tinaicloudv1alpha1.QuotaForPlan(tc.plan)
		if quota == nil {
			t.Errorf("QuotaForPlan(%q) returned nil", tc.plan)
			continue
		}
		cpu, ok := quota[corev1.ResourceRequestsCPU]
		if !ok {
			t.Errorf("QuotaForPlan(%q) missing requests.cpu", tc.plan)
			continue
		}
		if cpu.String() != tc.wantCPU {
			t.Errorf("QuotaForPlan(%q) requests.cpu = %q, want %q", tc.plan, cpu.String(), tc.wantCPU)
		}
	}
}

func TestTenantNamespace(t *testing.T) {
	got := tenantNamespace("acme")
	want := "tinai-tenant-acme"
	if got != want {
		t.Errorf("tenantNamespace(%q) = %q, want %q", "acme", got, want)
	}
}

func TestContainsString(t *testing.T) {
	slice := []string{"a", "b", "c"}
	if !containsString(slice, "b") {
		t.Error("containsString: expected true for element 'b' in slice")
	}
	if containsString(slice, "z") {
		t.Error("containsString: expected false for element 'z' not in slice")
	}
	if containsString(nil, "a") {
		t.Error("containsString: expected false for nil slice")
	}
}

func TestRemoveString(t *testing.T) {
	slice := []string{"a", "b", "c"}
	result := removeString(slice, "b")
	if len(result) != 2 {
		t.Errorf("removeString: expected length 2, got %d", len(result))
	}
	for _, v := range result {
		if v == "b" {
			t.Error("removeString: 'b' should have been removed")
		}
	}

	// Removing non-existent element should leave slice unchanged.
	result2 := removeString(slice, "z")
	if len(result2) != len(slice) {
		t.Errorf("removeString: removing absent element changed length: got %d, want %d", len(result2), len(slice))
	}
}

func TestReconcile_CreatesNamespace(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := tinaicloudv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme (tinai): %v", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme (corev1): %v", err)
	}
	if err := networkv1.AddToScheme(scheme); err != nil {
		t.Fatalf("AddToScheme (networkv1): %v", err)
	}

	tenant := &tinaicloudv1alpha1.Tenant{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: tinaicloudv1alpha1.TenantSpec{
			DisplayName: "Test",
			Owner:       "test@example.com",
			Plan:        "free",
		},
	}

	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(tenant).
		WithStatusSubresource(tenant).
		Build()

	r := &TenantReconciler{Client: fakeClient, Scheme: scheme}

	ctx := context.Background()
	_, err := r.Reconcile(ctx, ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "test"},
	})
	if err != nil {
		t.Fatalf("Reconcile returned unexpected error: %v", err)
	}

	// Verify the namespace "tinai-tenant-test" was created.
	ns := &corev1.Namespace{}
	if err := fakeClient.Get(ctx, types.NamespacedName{Name: "tinai-tenant-test"}, ns); err != nil {
		t.Errorf("expected namespace 'tinai-tenant-test' to exist after reconcile, got error: %v", err)
	}
}
