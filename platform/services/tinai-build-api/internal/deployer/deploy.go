package deployer

import (
	"context"
	"fmt"
	"log"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"

	"tinai.cloud/build-api/internal/config"
)

const annotPrevImage = "deployment.tinai.cloud/previous-image"

type Deployer struct {
	cfg    config.Config
	client kubernetes.Interface
}

type AppInfo struct {
	Name    string   `json:"name"`
	Region  string   `json:"region"`
	Staging *EnvInfo `json:"staging"`
	Prod    *EnvInfo `json:"prod"`
}

type EnvInfo struct {
	Image   string `json:"image"`
	Tag     string `json:"tag"`
	Ready   int32  `json:"ready"`
	Desired int32  `json:"desired"`
	URL     string `json:"url"`
}

func New(cfg config.Config, client kubernetes.Interface) *Deployer {
	return &Deployer{cfg: cfg, client: client}
}

// namespacesForRegion returns the staging and prod namespace names for a given region.
// Falls back to India namespaces if region is unknown.
func (d *Deployer) namespacesForRegion(region string) (staging, prod string) {
	switch strings.ToUpper(region) {
	case "QA":
		return d.cfg.QatarStagingNS, d.cfg.QatarProdNS
	case "AE":
		return d.cfg.UAEStagingNS, d.cfg.UAEProdNS
	default: // "IN" or unknown
		return d.cfg.StagingNamespace, d.cfg.ProdNamespace
	}
}

func (d *Deployer) DeployApp(ctx context.Context, appName, imageTag, region string) error {
	stagingNS, _ := d.namespacesForRegion(region)
	return d.deployToNamespace(ctx, appName, imageTag, stagingNS, region)
}

// DeployTenantApp routes the deploy based on the tenant ID.
// If tenantId is empty or "tinai-admin", it delegates to DeployApp (shared staging).
// Otherwise it deploys to the tenant-scoped namespace using TenantNamespaceTemplate,
// auto-provisioning the namespace and security boundaries on first use.
func (d *Deployer) DeployTenantApp(ctx context.Context, appName, imageTag, region, tenantId string) error {
	if tenantId == "" || tenantId == "tinai-admin" {
		return d.DeployApp(ctx, appName, imageTag, region)
	}
	if err := d.ensureTenantNamespace(ctx, tenantId); err != nil {
		return fmt.Errorf("ensure tenant namespace: %w", err)
	}
	nsName := fmt.Sprintf(d.cfg.TenantNamespaceTemplate, tenantId)
	return d.deployToTenantNamespace(ctx, appName, imageTag, nsName, tenantId)
}

// deployToTenantNamespace deploys an app into a tenant-scoped namespace with
// tenant labels and a tenant-scoped ingress hostname.
func (d *Deployer) deployToTenantNamespace(ctx context.Context, appName, imageTag, ns, tenantId string) error {
	port := int32(8080)
	labels := map[string]string{
		"tinai.cloud/app":    appName,
		"tinai.cloud/tenant": tenantId,
	}

	if err := d.applyDeployment(ctx, ns, appName, imageTag, labels, port, "tenant"); err != nil {
		return err
	}
	if err := d.ensureService(ctx, ns, appName, labels); err != nil {
		return err
	}
	if err := d.ensureTenantIngress(ctx, ns, appName, tenantId); err != nil {
		return err
	}
	log.Printf("tenant deploy complete: app=%s image=%s ns=%s tenant=%s", appName, imageTag, ns, tenantId)
	return nil
}

// ensureTenantIngress creates a TLS Ingress for a tenant app at {appName}.{tenantId}.{AppsDomain}.
func (d *Deployer) ensureTenantIngress(ctx context.Context, ns, appName, tenantId string) error {
	_, err := d.client.NetworkingV1().Ingresses(ns).Get(ctx, appName, metav1.GetOptions{})
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get tenant ingress: %w", err)
	}
	pathType := networkingv1.PathTypePrefix
	ingressClass := "traefik"
	host := fmt.Sprintf("%s.%s.%s", appName, tenantId, d.cfg.AppsDomain)
	annotations := map[string]string{
		"cert-manager.io/cluster-issuer":           d.cfg.CertIssuer,
		"traefik.ingress.kubernetes.io/router.tls": "true",
	}
	ingress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName,
			Namespace: ns,
			Labels: map[string]string{
				"tinai.cloud/app":    appName,
				"tinai.cloud/tenant": tenantId,
			},
			Annotations: annotations,
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: &ingressClass,
			TLS: []networkingv1.IngressTLS{{
				Hosts:      []string{host},
				SecretName: fmt.Sprintf("%s-tls", appName),
			}},
			Rules: []networkingv1.IngressRule{{
				Host: host,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						Paths: []networkingv1.HTTPIngressPath{{
							Path:     "/",
							PathType: &pathType,
							Backend: networkingv1.IngressBackend{
								Service: &networkingv1.IngressServiceBackend{
									Name: appName,
									Port: networkingv1.ServiceBackendPort{Number: 80},
								},
							},
						}},
					},
				},
			}},
		},
	}
	_, err = d.client.NetworkingV1().Ingresses(ns).Create(ctx, ingress, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create tenant ingress: %w", err)
	}
	log.Printf("created tenant ingress %s/%s host=%s tenant=%s", ns, appName, host, tenantId)
	return nil
}

// ensureTenantNamespace creates a tenant namespace with ResourceQuota,
// LimitRange, NetworkPolicy, and imagePullSecret if it does not already exist.
func (d *Deployer) ensureTenantNamespace(ctx context.Context, tenantId string) error {
	nsName := fmt.Sprintf(d.cfg.TenantNamespaceTemplate, tenantId)
	coreClient := d.client.CoreV1()

	// 1. Create namespace if not exists
	_, err := coreClient.Namespaces().Get(ctx, nsName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		ns := &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: nsName,
				Labels: map[string]string{
					"tinai.cloud/tenant":    tenantId,
					"tinai.cloud/managed-by": "build-api",
				},
			},
		}
		if _, err := coreClient.Namespaces().Create(ctx, ns, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create namespace %s: %w", nsName, err)
		}
		log.Printf("created tenant namespace %s", nsName)
	} else if err != nil {
		return fmt.Errorf("get namespace %s: %w", nsName, err)
	}

	// 2. Apply ResourceQuota
	if err := d.ensureTenantResourceQuota(ctx, nsName); err != nil {
		return err
	}

	// 3. Apply LimitRange
	if err := d.ensureTenantLimitRange(ctx, nsName); err != nil {
		return err
	}

	// 4. Apply NetworkPolicy
	if err := d.ensureTenantNetworkPolicy(ctx, nsName); err != nil {
		return err
	}

	// 5. Copy imagePullSecret from tinai-build namespace
	if err := d.ensureTenantImagePullSecret(ctx, nsName); err != nil {
		return err
	}

	return nil
}

func (d *Deployer) ensureTenantResourceQuota(ctx context.Context, nsName string) error {
	quotaName := "tenant-quota"
	quota := &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{
			Name:      quotaName,
			Namespace: nsName,
		},
		Spec: corev1.ResourceQuotaSpec{
			Hard: corev1.ResourceList{
				corev1.ResourceCPU:      resource.MustParse("4"),
				corev1.ResourceMemory:   resource.MustParse("8Gi"),
				corev1.ResourcePods:     resource.MustParse("10"),
				corev1.ResourceServices: resource.MustParse("10"),
			},
		},
	}

	existing, err := d.client.CoreV1().ResourceQuotas(nsName).Get(ctx, quotaName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		if _, err := d.client.CoreV1().ResourceQuotas(nsName).Create(ctx, quota, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create resource quota in %s: %w", nsName, err)
		}
		log.Printf("created resource quota in %s", nsName)
		return nil
	}
	if err != nil {
		return fmt.Errorf("get resource quota in %s: %w", nsName, err)
	}

	existing.Spec.Hard = quota.Spec.Hard
	if _, err := d.client.CoreV1().ResourceQuotas(nsName).Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update resource quota in %s: %w", nsName, err)
	}
	return nil
}

func (d *Deployer) ensureTenantLimitRange(ctx context.Context, nsName string) error {
	lrName := "tenant-limits"
	lr := &corev1.LimitRange{
		ObjectMeta: metav1.ObjectMeta{
			Name:      lrName,
			Namespace: nsName,
		},
		Spec: corev1.LimitRangeSpec{
			Limits: []corev1.LimitRangeItem{
				{
					Type: corev1.LimitTypeContainer,
					Default: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("500m"),
						corev1.ResourceMemory: resource.MustParse("256Mi"),
					},
					DefaultRequest: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("100m"),
						corev1.ResourceMemory: resource.MustParse("128Mi"),
					},
				},
			},
		},
	}

	existing, err := d.client.CoreV1().LimitRanges(nsName).Get(ctx, lrName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		if _, err := d.client.CoreV1().LimitRanges(nsName).Create(ctx, lr, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create limit range in %s: %w", nsName, err)
		}
		log.Printf("created limit range in %s", nsName)
		return nil
	}
	if err != nil {
		return fmt.Errorf("get limit range in %s: %w", nsName, err)
	}

	existing.Spec = lr.Spec
	if _, err := d.client.CoreV1().LimitRanges(nsName).Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update limit range in %s: %w", nsName, err)
	}
	return nil
}

func (d *Deployer) ensureTenantNetworkPolicy(ctx context.Context, nsName string) error {
	policyName := "tenant-isolation"
	protocolTCP := corev1.ProtocolTCP
	protocolUDP := corev1.ProtocolUDP
	dnsPort := intstr.FromInt32(53)

	policy := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      policyName,
			Namespace: nsName,
		},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{}, // select all pods in namespace
			PolicyTypes: []networkingv1.PolicyType{
				networkingv1.PolicyTypeIngress,
				networkingv1.PolicyTypeEgress,
			},
			Ingress: []networkingv1.NetworkPolicyIngressRule{
				{
					// Allow ingress from kube-system (traefik)
					From: []networkingv1.NetworkPolicyPeer{
						{
							NamespaceSelector: &metav1.LabelSelector{
								MatchLabels: map[string]string{
									"kubernetes.io/metadata.name": "kube-system",
								},
							},
						},
					},
				},
				{
					// Allow ingress from tinai-system
					From: []networkingv1.NetworkPolicyPeer{
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
			Egress: []networkingv1.NetworkPolicyEgressRule{
				{
					// Allow DNS egress (kube-system, port 53 UDP+TCP)
					To: []networkingv1.NetworkPolicyPeer{
						{
							NamespaceSelector: &metav1.LabelSelector{
								MatchLabels: map[string]string{
									"kubernetes.io/metadata.name": "kube-system",
								},
							},
						},
					},
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &protocolUDP, Port: &dnsPort},
						{Protocol: &protocolTCP, Port: &dnsPort},
					},
				},
				{
					// Allow egress to tinai-system (for API calls)
					To: []networkingv1.NetworkPolicyPeer{
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

	existing, err := d.client.NetworkingV1().NetworkPolicies(nsName).Get(ctx, policyName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		if _, err := d.client.NetworkingV1().NetworkPolicies(nsName).Create(ctx, policy, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create network policy in %s: %w", nsName, err)
		}
		log.Printf("created network policy in %s", nsName)
		return nil
	}
	if err != nil {
		return fmt.Errorf("get network policy in %s: %w", nsName, err)
	}

	existing.Spec = policy.Spec
	if _, err := d.client.NetworkingV1().NetworkPolicies(nsName).Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update network policy in %s: %w", nsName, err)
	}
	return nil
}

func (d *Deployer) ensureTenantImagePullSecret(ctx context.Context, nsName string) error {
	secretName := "kaniko-registry-creds"
	srcNamespace := d.cfg.BuildNamespace

	// Check if it already exists in tenant namespace
	_, err := d.client.CoreV1().Secrets(nsName).Get(ctx, secretName, metav1.GetOptions{})
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get secret %s in %s: %w", secretName, nsName, err)
	}

	// Read from source namespace
	srcSecret, err := d.client.CoreV1().Secrets(srcNamespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get source secret %s/%s: %w", srcNamespace, secretName, err)
	}

	// Recreate in tenant namespace
	newSecret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: nsName,
		},
		Type: srcSecret.Type,
		Data: srcSecret.Data,
	}
	if _, err := d.client.CoreV1().Secrets(nsName).Create(ctx, newSecret, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create secret %s in %s: %w", secretName, nsName, err)
	}
	log.Printf("copied secret %s to %s", secretName, nsName)
	return nil
}

// DeployPreview deploys a PR preview build into its isolated namespace.
// The Ingress hostname is pr{N}-{appName}.{AppsDomain} so it never conflicts
// with the staging or production URLs.
func (d *Deployer) DeployPreview(ctx context.Context, previewNS, previewName, imageTag string, prNumber int) error {
	port := int32(8080)
	labels := map[string]string{
		"tinai.cloud/app":     previewName,
		"tinai.cloud/tier":    "preview",
		"tinai.cloud/preview": "true",
	}
	if err := d.applyDeployment(ctx, previewNS, previewName, imageTag, labels, port, "preview"); err != nil {
		return err
	}
	if err := d.ensureService(ctx, previewNS, previewName, labels); err != nil {
		return err
	}
	if err := d.ensurePreviewIngress(ctx, previewNS, previewName, prNumber); err != nil {
		return err
	}
	log.Printf("preview deploy complete: ns=%s app=%s image=%s", previewNS, previewName, imageTag)
	return nil
}

// ensurePreviewIngress creates a TLS Ingress for a PR preview at pr{N}-{appName}.{AppsDomain}.
func (d *Deployer) ensurePreviewIngress(ctx context.Context, ns, previewName string, prNumber int) error {
	_, err := d.client.NetworkingV1().Ingresses(ns).Get(ctx, previewName, metav1.GetOptions{})
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get preview ingress: %w", err)
	}

	pathType := networkingv1.PathTypePrefix
	ingressClass := "traefik"
	host := fmt.Sprintf("pr%d-%s.%s", prNumber, previewName, d.cfg.AppsDomain)
	annotations := map[string]string{
		"cert-manager.io/cluster-issuer":           d.cfg.CertIssuer,
		"traefik.ingress.kubernetes.io/router.tls": "true",
	}
	ingress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:        previewName,
			Namespace:   ns,
			Labels:      map[string]string{"tinai.cloud/preview": "true"},
			Annotations: annotations,
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: &ingressClass,
			TLS: []networkingv1.IngressTLS{{
				Hosts:      []string{host},
				SecretName: fmt.Sprintf("%s-tls", previewName),
			}},
			Rules: []networkingv1.IngressRule{{
				Host: host,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						Paths: []networkingv1.HTTPIngressPath{{
							Path:     "/",
							PathType: &pathType,
							Backend: networkingv1.IngressBackend{
								Service: &networkingv1.IngressServiceBackend{
									Name: previewName,
									Port: networkingv1.ServiceBackendPort{Number: 80},
								},
							},
						}},
					},
				},
			}},
		},
	}
	_, err = d.client.NetworkingV1().Ingresses(ns).Create(ctx, ingress, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create preview ingress: %w", err)
	}
	log.Printf("created preview ingress %s/%s host=%s", ns, previewName, host)
	return nil
}

func (d *Deployer) PromoteApp(ctx context.Context, appName, region string) error {
	stagingNS, prodNS := d.namespacesForRegion(region)
	dep, err := d.client.AppsV1().Deployments(stagingNS).Get(ctx, appName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("staging deployment not found: %w", err)
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return fmt.Errorf("staging deployment %s has no containers", appName)
	}
	image := dep.Spec.Template.Spec.Containers[0].Image
	return d.deployToNamespace(ctx, appName, image, prodNS, region)
}

func (d *Deployer) RollbackApp(ctx context.Context, appName, region, ns string) error {
	dep, err := d.client.AppsV1().Deployments(ns).Get(ctx, appName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("deployment not found: %w", err)
	}
	prevImage := dep.Annotations[annotPrevImage]
	if prevImage == "" {
		return fmt.Errorf("no previous image recorded for %s in %s", appName, ns)
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return fmt.Errorf("deployment %s in %s has no containers", appName, ns)
	}
	curImage := dep.Spec.Template.Spec.Containers[0].Image
	if dep.Annotations == nil {
		dep.Annotations = map[string]string{}
	}
	dep.Annotations[annotPrevImage] = curImage
	dep.Spec.Template.Spec.Containers[0].Image = prevImage
	if _, err := d.client.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("rollback update: %w", err)
	}
	log.Printf("rolled back %s/%s to %s (region=%s)", ns, appName, prevImage, region)
	return nil
}

func (d *Deployer) ListApps(ctx context.Context) ([]AppInfo, error) {
	// Collect apps keyed by "region/name" to support same app name in multiple regions.
	type appKey struct{ region, name string }
	apps := map[appKey]*AppInfo{}

	regionEntries := []struct {
		region, staging, prod string
	}{
		{"IN", d.cfg.IndiaStagingNS, d.cfg.IndiaProdNS},
		{"QA", d.cfg.QatarStagingNS, d.cfg.QatarProdNS},
		{"AE", d.cfg.UAEStagingNS, d.cfg.UAEProdNS},
	}

	for _, re := range regionEntries {
		for _, entry := range []struct{ ns, env string }{
			{re.staging, "staging"},
			{re.prod, "prod"},
		} {
			deps, err := d.client.AppsV1().Deployments(entry.ns).List(ctx, metav1.ListOptions{
				LabelSelector: "tinai.cloud/app",
			})
			if err != nil {
				continue
			}
			for i := range deps.Items {
				dep := &deps.Items[i]
				if len(dep.Spec.Template.Spec.Containers) == 0 {
					continue
				}
				appName := dep.Labels["tinai.cloud/app"]
				key := appKey{re.region, appName}
				if apps[key] == nil {
					apps[key] = &AppInfo{Name: appName, Region: re.region}
				}
				image := dep.Spec.Template.Spec.Containers[0].Image
				desired := int32(1)
				if dep.Spec.Replicas != nil {
					desired = *dep.Spec.Replicas
				}
				info := &EnvInfo{
					Image:   image,
					Tag:     imageTag(image),
					Ready:   dep.Status.ReadyReplicas,
					Desired: desired,
					URL:     fmt.Sprintf("https://%s.%s", appName, d.cfg.AppsDomain),
				}
				if entry.env == "staging" {
					apps[key].Staging = info
				} else {
					apps[key].Prod = info
				}
			}
		}
	}

	result := make([]AppInfo, 0, len(apps))
	for _, a := range apps {
		result = append(result, *a)
	}
	return result, nil
}

func (d *Deployer) GetApp(ctx context.Context, appName string) (*AppInfo, error) {
	apps, err := d.ListApps(ctx)
	if err != nil {
		return nil, err
	}
	for i := range apps {
		if apps[i].Name == appName {
			return &apps[i], nil
		}
	}
	return nil, fmt.Errorf("app not found: %s", appName)
}

func (d *Deployer) GetLogs(ctx context.Context, appName, ns string, tailLines int64) (string, error) {
	pods, err := d.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("tinai.cloud/app=%s", appName),
	})
	if err != nil || len(pods.Items) == 0 {
		return "", fmt.Errorf("no pods found for %s in %s", appName, ns)
	}
	pod := pods.Items[0]
	req := d.client.CoreV1().Pods(ns).GetLogs(pod.Name, &corev1.PodLogOptions{
		TailLines: &tailLines,
	})
	result, err := req.DoRaw(ctx)
	if err != nil {
		return "", err
	}
	return string(result), nil
}

// deployToNamespace deploys an app to the given namespace.
func (d *Deployer) deployToNamespace(ctx context.Context, appName, imageTag, ns, region string) error {
	port := int32(8080)
	labels := map[string]string{
		"tinai.cloud/app":    appName,
		"tinai.cloud/region": region,
	}

	if err := d.applyDeployment(ctx, ns, appName, imageTag, labels, port, region); err != nil {
		return err
	}
	if err := d.ensureService(ctx, ns, appName, labels); err != nil {
		return err
	}
	if err := d.ensureIngress(ctx, ns, appName, region); err != nil {
		return err
	}
	log.Printf("deploy complete: app=%s image=%s ns=%s region=%s", appName, imageTag, ns, region)
	return nil
}

func (d *Deployer) applyDeployment(ctx context.Context, ns, appName, image string, labels map[string]string, port int32, region string) error {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName,
			Namespace: ns,
			Labels:    labels,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: int32Ptr(1),
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"tinai.cloud/app": appName}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					ImagePullSecrets: []corev1.LocalObjectReference{{Name: "forgejo-pull-secret"}},
					Containers: []corev1.Container{{
						Name:            appName,
						Image:           image,
						ImagePullPolicy: corev1.PullAlways,
						Ports:           []corev1.ContainerPort{{ContainerPort: port}},
						Env: []corev1.EnvVar{{
							Name:  "PORT",
							Value: fmt.Sprintf("%d", port),
						}},
						EnvFrom: []corev1.EnvFromSource{{
							ConfigMapRef: &corev1.ConfigMapEnvSource{
								LocalObjectReference: corev1.LocalObjectReference{Name: appName + "-env"},
								Optional:             boolPtr(true),
							},
						}},
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
					}},
				},
			},
		},
	}

	existing, err := d.client.AppsV1().Deployments(ns).Get(ctx, appName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		_, err = d.client.AppsV1().Deployments(ns).Create(ctx, dep, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("create deployment: %w", err)
		}
		log.Printf("created deployment %s/%s (region=%s)", ns, appName, region)
		return nil
	}
	if err != nil {
		return fmt.Errorf("get deployment: %w", err)
	}

	if len(existing.Spec.Template.Spec.Containers) == 0 {
		return fmt.Errorf("existing deployment %s/%s has no containers", ns, appName)
	}
	// Track previous image for rollback
	curImage := existing.Spec.Template.Spec.Containers[0].Image
	if curImage != image {
		if existing.Annotations == nil {
			existing.Annotations = map[string]string{}
		}
		existing.Annotations[annotPrevImage] = curImage
	}
	// Propagate region label onto existing resource
	if existing.Labels == nil {
		existing.Labels = map[string]string{}
	}
	existing.Labels["tinai.cloud/region"] = region
	existing.Spec.Template.Spec.Containers[0].Image = image
	_, err = d.client.AppsV1().Deployments(ns).Update(ctx, existing, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("update deployment: %w", err)
	}
	log.Printf("updated deployment %s/%s image=%s region=%s", ns, appName, image, region)
	return nil
}

func (d *Deployer) ensureService(ctx context.Context, ns, appName string, labels map[string]string) error {
	_, err := d.client.CoreV1().Services(ns).Get(ctx, appName, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get service: %w", err)
	}
	port := int32(8080)
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: ns, Labels: labels},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"tinai.cloud/app": appName},
			Ports:    []corev1.ServicePort{{Port: 80, TargetPort: intstr.FromInt32(port)}},
		},
	}
	_, err = d.client.CoreV1().Services(ns).Create(ctx, svc, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	log.Printf("created service %s/%s", ns, appName)
	return nil
}

func (d *Deployer) ensureIngress(ctx context.Context, ns, appName, region string) error {
	_, err := d.client.NetworkingV1().Ingresses(ns).Get(ctx, appName, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get ingress: %w", err)
	}
	pathType := networkingv1.PathTypePrefix
	ingressClass := "traefik"
	appsDomain := d.cfg.AppsDomain
	host := fmt.Sprintf("%s.%s", appName, appsDomain)
	annotations := map[string]string{
		"cert-manager.io/cluster-issuer":                d.cfg.CertIssuer,
		"traefik.ingress.kubernetes.io/router.tls":      "true",
	}
	ingress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName,
			Namespace: ns,
			Labels: map[string]string{
				"tinai.cloud/app":    appName,
				"tinai.cloud/region": region,
			},
			Annotations: annotations,
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: &ingressClass,
			TLS: []networkingv1.IngressTLS{
				{
					Hosts:      []string{host},
					SecretName: fmt.Sprintf("%s-tls", appName),
				},
			},
			Rules: []networkingv1.IngressRule{{
				Host: host,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						Paths: []networkingv1.HTTPIngressPath{{
							Path:     "/",
							PathType: &pathType,
							Backend: networkingv1.IngressBackend{
								Service: &networkingv1.IngressServiceBackend{
									Name: appName,
									Port: networkingv1.ServiceBackendPort{Number: 80},
								},
							},
						}},
					},
				},
			}},
		},
	}
	_, err = d.client.NetworkingV1().Ingresses(ns).Create(ctx, ingress, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("create ingress: %w", err)
	}
	log.Printf("created ingress %s/%s host=%s region=%s", ns, appName, host, region)
	return nil
}

func imageTag(image string) string {
	if idx := strings.LastIndex(image, ":"); idx != -1 {
		return image[idx+1:]
	}
	return image
}

func boolPtr(b bool) *bool { return &b }
func int32Ptr(i int32) *int32 { return &i }
