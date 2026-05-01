package databases

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var clusterGVR = schema.GroupVersionResource{
	Group:    "postgresql.cnpg.io",
	Version:  "v1",
	Resource: "clusters",
}

type Provisioner struct {
	db        *pgxpool.Pool
	dynClient dynamic.Interface
	namespace string // tinai-databases
}

func New(db *pgxpool.Pool, dynClient dynamic.Interface, namespace string) *Provisioner {
	return &Provisioner{db: db, dynClient: dynClient, namespace: namespace}
}

func (p *Provisioner) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.poll(ctx)
		}
	}
}

func (p *Provisioner) poll(ctx context.Context) {
	rows, err := p.db.Query(ctx,
		`SELECT id, tenant_id, name, pg_version, storage_gb FROM storage_databases WHERE status='provisioning' LIMIT 5`)
	if err != nil {
		slog.Error("databases poll", "err", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, name, pgVersion string
		var storageGB int
		if err := rows.Scan(&id, &tenantID, &name, &pgVersion, &storageGB); err != nil {
			continue
		}
		go p.provision(ctx, id, tenantID, name, pgVersion, storageGB)
	}
}

func (p *Provisioner) provision(ctx context.Context, id, tenantID, name, pgVersion string, storageGB int) {
	// Mark in-progress
	tag, _ := p.db.Exec(ctx,
		`UPDATE storage_databases SET status='running' WHERE id=$1 AND status='provisioning'`, id)
	if tag.RowsAffected() == 0 {
		return // another pod picked it up
	}

	clusterName := fmt.Sprintf("tinai-%s-%s", tenantID[:min(8, len(tenantID))], name)
	dbUser := "app"
	dbName := name

	cluster := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "postgresql.cnpg.io/v1",
			"kind":       "Cluster",
			"metadata": map[string]interface{}{
				"name":      clusterName,
				"namespace": p.namespace,
				"labels": map[string]interface{}{
					"tinai.cloud/tenant": tenantID,
					"tinai.cloud/db-id":  id,
				},
			},
			"spec": map[string]interface{}{
				"instances": 1,
				"postgresql": map[string]interface{}{
					"pg_hba": []string{"host all all 0.0.0.0/0 md5"},
				},
				"bootstrap": map[string]interface{}{
					"initdb": map[string]interface{}{
						"database": dbName,
						"owner":    dbUser,
					},
				},
				"storage": map[string]interface{}{
					"size": fmt.Sprintf("%dGi", storageGB),
				},
			},
		},
	}

	_, err := p.dynClient.Resource(clusterGVR).Namespace(p.namespace).Create(ctx, cluster, metav1.CreateOptions{})
	if err != nil && !errors.IsAlreadyExists(err) {
		slog.Error("cluster create", "err", err)
		p.db.Exec(ctx, `UPDATE storage_databases SET status='error' WHERE id=$1`, id)
		return
	}

	// Poll for readiness (up to 5 min)
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Second)
		obj, err := p.dynClient.Resource(clusterGVR).Namespace(p.namespace).Get(ctx, clusterName, metav1.GetOptions{})
		if err != nil {
			continue
		}
		// Check status.readyInstances == 1
		statusRaw, _, _ := unstructured.NestedMap(obj.Object, "status")
		if b, _ := json.Marshal(statusRaw); len(b) > 0 {
			var s struct {
				ReadyInstances int `json:"readyInstances"`
			}
			json.Unmarshal(b, &s)
			if s.ReadyInstances >= 1 {
				// Build connection string
				host := fmt.Sprintf("%s-rw.%s.svc.cluster.local", clusterName, p.namespace)
				connStr := fmt.Sprintf("postgresql://%s@%s:5432/%s", dbUser, host, dbName)
				p.db.Exec(ctx,
					`UPDATE storage_databases SET connection_string=$1, host=$2, port=5432, db_user=$3 WHERE id=$4`,
					connStr, host, dbUser, id)
				slog.Info("database ready", "id", id, "cluster", clusterName)
				return
			}
		}
	}
	slog.Error("database timed out waiting for ready", "id", id)
	p.db.Exec(ctx, `UPDATE storage_databases SET status='error' WHERE id=$1`, id)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
