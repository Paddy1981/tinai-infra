package builder

import (
	"context"
	"fmt"
	"log"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TriggerPreviewBuild triggers a build and deploy for a pull-request preview environment.
// The preview is isolated in its own namespace (preview-{app}-pr{N}) so it never
// touches staging or production namespaces.
func (b *Builder) TriggerPreviewBuild(ctx context.Context, repoFullName, cloneURL, commit, previewNS, previewName string, prNumber int) error {
	if len(commit) < 8 {
		return fmt.Errorf("commit SHA too short: %q", commit)
	}
	shortSHA := commit[:8]
	imageTag := fmt.Sprintf("%s/%s:pr%d-%s", b.cfg.RegistryHost, strings.ToLower(repoFullName), prNumber, shortSHA)
	jobName := fmt.Sprintf("build-%s-pr%d-%s", sanitizeName(repoFullName), prNumber, shortSHA)

	// Rewrite clone URL to internal cluster DNS so build pods can reach Forgejo.
	// Only rewrite when ForgejoExternalURL is configured; an empty string is a
	// substring of everything so strings.Replace would corrupt the URL.
	if b.cfg.ForgejoExternalURL != "" {
		cloneURL = strings.Replace(cloneURL, b.cfg.ForgejoExternalURL, b.cfg.ForgejoInternalURL, 1)
	}

	log.Printf("preview build: repo=%s pr=%d ns=%s job=%s image=%s", repoFullName, prNumber, previewNS, jobName, imageTag)

	// Ensure the preview namespace exists before submitting the build Job.
	if err := b.ensurePreviewNamespace(ctx, previewNS); err != nil {
		return fmt.Errorf("ensure preview namespace %s: %w", previewNS, err)
	}

	// Submit a dedicated build Job that, on success, deploys into previewNS
	// (not the shared staging namespace). watchAndDeploy receives the preview
	// target so the deploy is fully isolated.
	if err := b.triggerBuildJob(ctx, jobName, repoFullName, cloneURL, commit, imageTag, previewNS, previewName, prNumber); err != nil {
		return fmt.Errorf("trigger build job for pr%d: %w", prNumber, err)
	}

	log.Printf("preview build triggered: pr=%d image=%s job=%s", prNumber, imageTag, jobName)
	return nil
}

// triggerBuildJob submits a Kaniko Job for the PR preview and starts a watcher
// that deploys into previewNS (not the shared staging namespace) on success.
func (b *Builder) triggerBuildJob(ctx context.Context, jobName, repoFullName, cloneURL, commit, imageTag, previewNS, previewName string, prNumber int) error {
	ttl := int32(3600)
	backoff := int32(0)

	prepareScript := `if [ ! -f /workspace/Dockerfile ]; then
  echo "ERROR: No Dockerfile found."
  exit 1
fi
cp -r /workspace/. /build-context/
echo "Build context ready"
`
	job := buildKanikoJob(
		jobName, b.cfg.BuildNamespace, repoFullName, cloneURL, commit, imageTag,
		previewNS, previewName, prNumber,
		ttl, backoff, prepareScript, b.cfg.RegistryHost,
	)

	if _, err := b.client.BatchV1().Jobs(b.cfg.BuildNamespace).Create(ctx, job, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create preview build job: %w", err)
	}

	go b.watchAndDeploy(jobName, sanitizeName(repoFullName), imageTag, "IN", previewNS, previewName, prNumber, "")
	return nil
}


// CleanupPreview removes the Deployment, Service, and Ingress for a PR preview.
// Namespace deletion is intentionally left to the cluster administrator to avoid
// accidental removal of any custom resources.  Run:
//
//	kubectl delete namespace <previewNS>
//
// to fully tear down a preview environment.
func (b *Builder) CleanupPreview(ctx context.Context, previewNS, previewName string) error {
	log.Printf("cleaning up preview: ns=%s name=%s", previewNS, previewName)

	// Best-effort deletes — ignore "not found" errors.
	if err := b.client.AppsV1().Deployments(previewNS).Delete(ctx, previewName, metav1.DeleteOptions{}); err != nil && !errors.IsNotFound(err) {
		log.Printf("preview cleanup: delete deployment %s/%s: %v", previewNS, previewName, err)
	}
	if err := b.client.CoreV1().Services(previewNS).Delete(ctx, previewName, metav1.DeleteOptions{}); err != nil && !errors.IsNotFound(err) {
		log.Printf("preview cleanup: delete service %s/%s: %v", previewNS, previewName, err)
	}
	if err := b.client.NetworkingV1().Ingresses(previewNS).Delete(ctx, previewName, metav1.DeleteOptions{}); err != nil && !errors.IsNotFound(err) {
		log.Printf("preview cleanup: delete ingress %s/%s: %v", previewNS, previewName, err)
	}

	log.Printf("preview cleanup complete: ns=%s", previewNS)
	return nil
}

// ensurePreviewNamespace creates the namespace if it does not already exist.
func (b *Builder) ensurePreviewNamespace(ctx context.Context, ns string) error {
	_, err := b.client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
	if err == nil {
		return nil // already exists
	}
	if !errors.IsNotFound(err) {
		return fmt.Errorf("get namespace %s: %w", ns, err)
	}

	nsObj := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: ns,
			Labels: map[string]string{
				"tinai.cloud/tier":    "preview",
				"tinai.cloud/preview": "true",
			},
		},
	}
	_, createErr := b.client.CoreV1().Namespaces().Create(ctx, nsObj, metav1.CreateOptions{})
	if createErr != nil {
		// Another process may have created it concurrently.
		if errors.IsAlreadyExists(createErr) {
			return nil
		}
		return fmt.Errorf("create namespace %s: %w", ns, createErr)
	}
	log.Printf("created preview namespace: %s", ns)
	return nil
}
