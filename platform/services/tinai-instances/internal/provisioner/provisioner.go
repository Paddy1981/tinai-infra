package provisioner

import (
	"context"
	"database/sql"
	"log"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Provisioner watches Postgres for instances in status='provisioning' and
// launches the corresponding K8s pods.
type Provisioner struct {
	db  *sql.DB
	k8s *kubernetes.Clientset
}

// New creates a Provisioner backed by the given database and K8s client.
func New(db *sql.DB, k8s *kubernetes.Clientset) *Provisioner {
	return &Provisioner{db: db, k8s: k8s}
}

// Run polls for pending instances every 5 seconds until ctx is cancelled.
func (p *Provisioner) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.reconcile(ctx)
		}
	}
}

type pendingInstance struct {
	ID           string
	TenantID     string
	DockerImage  string
	GpuCount     int
	VolumeGB     int
	InstanceType string
}

func (p *Provisioner) reconcile(ctx context.Context) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT i.id, i.tenant_id, img.docker_image, it.gpu_count, i.volume_size_gb, it.name
		FROM instances i
		JOIN instance_images img ON img.id = i.image_id
		JOIN instance_types it ON it.id = i.instance_type_id
		WHERE i.status = 'provisioning'
		LIMIT 10
	`)
	if err != nil {
		log.Printf("provisioner: query error: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var inst pendingInstance
		if err := rows.Scan(&inst.ID, &inst.TenantID, &inst.DockerImage, &inst.GpuCount, &inst.VolumeGB, &inst.InstanceType); err != nil {
			log.Printf("provisioner: scan error: %v", err)
			continue
		}
		go p.launch(ctx, inst)
	}
}

func (p *Provisioner) launch(ctx context.Context, inst pendingInstance) {
	const ns = "tinai-instances"
	pod := BuildInstancePod(inst.ID, inst.TenantID, inst.DockerImage, inst.GpuCount, inst.VolumeGB, inst.InstanceType)

	// Mark as 'starting' to avoid double-launch on the next poll tick.
	_, err := p.db.ExecContext(ctx,
		`UPDATE instances SET status='starting', pod_name=$1, namespace=$2 WHERE id=$3`,
		pod.Name, ns, inst.ID)
	if err != nil {
		log.Printf("provisioner: mark starting %s: %v", inst.ID, err)
		return
	}

	_, err = p.k8s.CoreV1().Pods(ns).Create(ctx, pod, metav1.CreateOptions{})
	if err != nil {
		log.Printf("provisioner: create pod %s: %v", inst.ID, err)
		_, _ = p.db.ExecContext(ctx, `UPDATE instances SET status='error' WHERE id=$1`, inst.ID)
		return
	}

	_, _ = p.db.ExecContext(ctx,
		`UPDATE instances SET status='running', started_at=NOW() WHERE id=$1`, inst.ID)
	log.Printf("provisioner: launched instance %s as pod %s/%s", inst.ID, ns, pod.Name)
}
