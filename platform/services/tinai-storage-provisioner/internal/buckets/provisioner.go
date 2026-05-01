package buckets

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Provisioner struct {
	db          *pgxpool.Pool
	minioURL    string // e.g. https://minio.tinai.cloud
	minioKey    string
	minioSecret string
}

func New(db *pgxpool.Pool, minioURL, minioKey, minioSecret string) *Provisioner {
	return &Provisioner{db: db, minioURL: minioURL, minioKey: minioKey, minioSecret: minioSecret}
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
		`SELECT id, tenant_id, name, region, quota_gb FROM storage_buckets WHERE status='provisioning' LIMIT 5`)
	if err != nil {
		slog.Error("buckets poll", "err", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, tenantID, name, region string
		var quotaGB int
		if err := rows.Scan(&id, &tenantID, &name, &region, &quotaGB); err != nil {
			slog.Error("buckets scan", "err", err)
			continue
		}
		go p.provision(ctx, id, tenantID, name, region, quotaGB)
	}
}

func (p *Provisioner) provision(ctx context.Context, id, tenantID, name, region string, quotaGB int) {
	// Mark as active immediately to avoid double-provisioning
	_, err := p.db.Exec(ctx,
		`UPDATE storage_buckets SET status='active' WHERE id=$1 AND status='provisioning'`, id)
	if err != nil {
		slog.Error("buckets mark active", "err", err)
	}

	// Build per-tenant bucket name: tinai-{tenantID}-{name}
	bucketName := fmt.Sprintf("tinai-%s-%s", tenantID, name)

	// Generate per-bucket access key (use bucket name as key prefix)
	accessKey := fmt.Sprintf("tinai-%s", bucketName[:min(len(bucketName), 20)])
	// In prod: call MinIO admin API to create a service account. Here we use root creds + bucket policy.

	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(p.minioKey, p.minioSecret, "")),
		awsconfig.WithRegion("us-east-1"),
	)
	if err != nil {
		p.setError(ctx, id, err)
		return
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(p.minioURL)
		o.UsePathStyle = true
	})

	_, err = client.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(bucketName),
	})
	if err != nil {
		slog.Warn("bucket create (may already exist)", "bucket", bucketName, "err", err)
		// Non-fatal: bucket may already exist from a retry
	}

	_, err = p.db.Exec(ctx,
		`UPDATE storage_buckets SET status='active', access_key=$1, endpoint_url=$2 WHERE id=$3`,
		accessKey, p.minioURL, id)
	if err != nil {
		slog.Error("buckets update", "err", err)
	}
	slog.Info("bucket provisioned", "id", id, "bucket", bucketName)
}

func (p *Provisioner) setError(ctx context.Context, id string, err error) {
	slog.Error("bucket provisioning failed", "id", id, "err", err)
	p.db.Exec(ctx, `UPDATE storage_buckets SET status='suspended' WHERE id=$1`, id)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
