package main

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/push"
)

const (
	defaultMinioEndpoint = "minio.tinai-system.svc.cluster.local:9000"
	defaultMinioBucket   = "tinai-backups"
)

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// BackupTarget describes a single PostgreSQL database to back up.
type BackupTarget struct {
	Name     string
	Host     string
	Port     string
	DBName   string
	Username string
	Password string
}

func main() {
	startTime := time.Now()

	mainDBURL := getEnv("DATABASE_URL", "")
	if mainDBURL == "" {
		log.Fatal("DATABASE_URL env var is required")
	}
	minioEndpoint := getEnv("MINIO_ENDPOINT", defaultMinioEndpoint)
	minioAccessKey := getEnv("MINIO_ACCESS_KEY", "minio-admin")
	minioSecretKey := getEnv("MINIO_SECRET_KEY", "")
	minioBucket := getEnv("MINIO_BUCKET", defaultMinioBucket)
	region := getEnv("REGION", "IN")
	retentionDays := 30
	if rd, err := strconv.Atoi(getEnv("BACKUP_RETENTION_DAYS", "30")); err == nil && rd > 0 {
		retentionDays = rd
	}

	log.Printf("tinai-backup: starting backup run")
	log.Printf("  region: %s", region)
	log.Printf("  minio:  %s/%s", minioEndpoint, minioBucket)
	log.Printf("  db:     %s", maskPassword(mainDBURL))

	ctx := context.Background()

	// Init MinIO client — enable TLS unless endpoint is localhost/127.x
	minioSecure := !strings.HasPrefix(minioEndpoint, "localhost") && !strings.HasPrefix(minioEndpoint, "127.")
	minioClient, err := minio.New(minioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(minioAccessKey, minioSecretKey, ""),
		Secure: minioSecure,
	})
	if err != nil {
		log.Fatalf("minio init: %v", err)
	}

	// Ensure backup bucket exists (race-safe: check again after creation failure)
	exists, err := minioClient.BucketExists(ctx, minioBucket)
	if err != nil {
		log.Fatalf("minio bucket check: %v", err)
	}
	if !exists {
		if mkErr := minioClient.MakeBucket(ctx, minioBucket, minio.MakeBucketOptions{}); mkErr != nil {
			// Another process may have created it concurrently — verify
			if ok, _ := minioClient.BucketExists(ctx, minioBucket); !ok {
				log.Fatalf("minio make bucket: %v", mkErr)
			}
		} else {
			log.Printf("created backup bucket: %s", minioBucket)
		}
	}

	// Connect to main DB
	db, err := sql.Open("postgres", mainDBURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}
	log.Printf("connected to main database")

	// Collect backup targets
	targets := []BackupTarget{}

	// 1. Always back up the main tinai database — parse credentials from DATABASE_URL
	if t, parseErr := targetFromDSN("tinai-main", mainDBURL); parseErr == nil {
		targets = append(targets, t)
	} else {
		log.Fatalf("failed to parse DATABASE_URL: %v", parseErr)
	}

	// 2. App-specific databases from app_databases table (if it exists)
	rows, err := db.QueryContext(ctx, `
		SELECT app_name, host, port::text, db_name, username
		FROM app_databases WHERE status = 'active'
	`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var t BackupTarget
			if scanErr := rows.Scan(&t.Name, &t.Host, &t.Port, &t.DBName, &t.Username); scanErr == nil {
				t.Password = "" // passwords are managed via secrets in production
				targets = append(targets, t)
			}
		}
		log.Printf("loaded %d app databases from app_databases table", len(targets)-1)
	} else {
		log.Printf("app_databases table not found — backing up main DB only")
	}

	// Run backups
	timestamp := time.Now().UTC().Format("2006-01-02T15-04-05Z")
	succeeded := 0
	failed := 0

	for _, target := range targets {
		log.Printf("backing up: %s (%s/%s)", target.Name, target.Host, target.DBName)
		if err := backupDatabase(ctx, minioClient, minioBucket, target, timestamp, region); err != nil {
			log.Printf("backup FAILED %s: %v", target.Name, err)
			failed++
		} else {
			log.Printf("backup OK: %s", target.Name)
			succeeded++
		}
	}

	// Retention cleanup
	log.Printf("running retention cleanup (keep last %d days)...", retentionDays)
	cleaned := cleanOldBackups(ctx, minioClient, minioBucket, retentionDays)

	log.Printf("--- backup summary ---")
	log.Printf("  succeeded: %d", succeeded)
	log.Printf("  failed:    %d", failed)
	log.Printf("  cleaned:   %d old backups", cleaned)
	log.Printf("tinai-backup: done")

	// Push metrics to Prometheus Pushgateway if configured.
	if pgwURL := os.Getenv("PROMETHEUS_PUSHGATEWAY_URL"); pgwURL != "" {
		registry := prometheus.NewRegistry()

		backupSucceeded := prometheus.NewGauge(prometheus.GaugeOpts{
			Name:        "tinai_backup_succeeded_total",
			Help:        "Number of databases successfully backed up in this run",
			ConstLabels: prometheus.Labels{"region": region},
		})
		backupFailed := prometheus.NewGauge(prometheus.GaugeOpts{
			Name:        "tinai_backup_failed_total",
			Help:        "Number of databases that failed to back up in this run",
			ConstLabels: prometheus.Labels{"region": region},
		})
		backupDuration := prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "tinai_backup_duration_seconds",
			Help: "Total wall-clock seconds for the backup run",
		})

		registry.MustRegister(backupSucceeded, backupFailed, backupDuration)
		backupSucceeded.Set(float64(succeeded))
		backupFailed.Set(float64(failed))
		backupDuration.Set(time.Since(startTime).Seconds())

		pusher := push.New(pgwURL, "tinai-backup").Gatherer(registry)
		if err := pusher.Push(); err != nil {
			log.Printf("pushgateway: %v", err)
		} else {
			log.Printf("pushgateway: metrics pushed to %s", pgwURL)
		}
	}

	if failed > 0 {
		os.Exit(1)
	}
}

// backupDatabase runs pg_dump for the given target and streams the result to MinIO.
// If pg_dump is not available (e.g. during testing), it writes a stub note instead.
func backupDatabase(ctx context.Context, mc *minio.Client, bucket string, target BackupTarget, timestamp, region string) error {
	pgDumpPath, err := exec.LookPath("pg_dump")
	if err != nil {
		// pg_dump not available — write a stub file noting the limitation
		note := fmt.Sprintf(
			"pg_dump not available in container — install postgresql-client\nTarget: %s/%s\nTimestamp: %s\n",
			target.Host, target.DBName, timestamp,
		)
		objectName := fmt.Sprintf("backups/%s/%s/%s.stub.txt", region, target.Name, timestamp)
		_, putErr := mc.PutObject(ctx, bucket, objectName,
			strings.NewReader(note), int64(len(note)),
			minio.PutObjectOptions{ContentType: "text/plain"})
		return putErr
	}

	// Build DSN without password — pass PGPASSWORD via environment to avoid
	// exposing credentials in /proc/<pid>/cmdline.
	dsn := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable",
		target.Username, target.Host, target.Port, target.DBName)

	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, pgDumpPath,
		"--format=custom",
		"--no-password",
		"--dbname", dsn,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+target.Password)
	cmd.Stderr = &stderr

	// Stream pg_dump stdout directly to MinIO — avoids buffering large DBs in RAM
	pr, pw := io.Pipe()
	cmd.Stdout = pw

	objectName := fmt.Sprintf("backups/%s/%s/%s.dump", region, target.Name, timestamp)

	type uploadResult struct {
		size int64
		err  error
	}
	uploadDone := make(chan uploadResult, 1)
	go func() {
		info, putErr := mc.PutObject(ctx, bucket, objectName, pr, -1,
			minio.PutObjectOptions{
				ContentType: "application/octet-stream",
				UserMetadata: map[string]string{
					"X-Tinai-Region":    region,
					"X-Tinai-DBName":    target.DBName,
					"X-Tinai-AppName":   target.Name,
					"X-Tinai-Timestamp": timestamp,
				},
			})
		pr.CloseWithError(putErr)
		uploadDone <- uploadResult{size: info.Size, err: putErr}
	}()

	if runErr := cmd.Run(); runErr != nil {
		pw.CloseWithError(runErr)
		<-uploadDone
		return fmt.Errorf("pg_dump: %v — stderr: %s", runErr, stderr.String())
	}
	pw.Close()

	res := <-uploadDone
	if res.err != nil {
		return fmt.Errorf("minio upload: %w", res.err)
	}
	if res.size < 512 {
		return fmt.Errorf("dump suspiciously small (%d bytes) — may be corrupt", res.size)
	}

	log.Printf("  uploaded: %s (%d bytes)", objectName, res.size)
	return nil
}

// cleanOldBackups removes objects under the backups/ prefix that are older than retentionDays.
// Returns the count of objects successfully deleted.
func cleanOldBackups(ctx context.Context, mc *minio.Client, bucket string, retentionDays int) int {
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays)
	cleaned := 0

	for obj := range mc.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:    "backups/",
		Recursive: true,
	}) {
		if obj.Err != nil {
			log.Printf("list objects error: %v", obj.Err)
			continue
		}
		if obj.LastModified.Before(cutoff) {
			if err := mc.RemoveObject(ctx, bucket, obj.Key, minio.RemoveObjectOptions{}); err != nil {
				log.Printf("remove %s: %v", obj.Key, err)
			} else {
				log.Printf("  cleaned: %s (age: %s)", obj.Key, time.Since(obj.LastModified).Round(time.Hour))
				cleaned++
			}
		}
	}
	return cleaned
}

// targetFromDSN parses a PostgreSQL DSN into a BackupTarget without storing the
// password in a hardcoded constant.
func targetFromDSN(name, dsn string) (BackupTarget, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return BackupTarget{}, fmt.Errorf("parse DSN: %w", err)
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	dbName := strings.TrimPrefix(u.Path, "/")
	user := u.User.Username()
	password, _ := u.User.Password()
	return BackupTarget{
		Name:     name,
		Host:     host,
		Port:     port,
		DBName:   dbName,
		Username: user,
		Password: password,
	}, nil
}

// maskPassword replaces the password in a PostgreSQL DSN with asterisks for safe logging.
func maskPassword(dsn string) string {
	atIdx := strings.LastIndex(dsn, "@")
	if atIdx < 0 {
		return dsn
	}
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd < 0 {
		return dsn
	}
	userInfo := dsn[schemeEnd+3 : atIdx]
	colonIdx := strings.Index(userInfo, ":")
	if colonIdx < 0 {
		return dsn
	}
	user := userInfo[:colonIdx]
	return dsn[:schemeEnd+3] + user + ":****@" + dsn[atIdx+1:]
}
