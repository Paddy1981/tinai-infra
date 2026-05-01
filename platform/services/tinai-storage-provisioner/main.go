package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"tinai.cloud/storage-provisioner/internal/buckets"
	"tinai.cloud/storage-provisioner/internal/databases"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		slog.Error("DATABASE_URL not set")
		os.Exit(1)
	}
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		slog.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	minioURL    := os.Getenv("MINIO_URL")
	minioKey    := os.Getenv("MINIO_ACCESS_KEY")
	minioSecret := os.Getenv("MINIO_SECRET_KEY")
	dbNamespace := os.Getenv("DB_NAMESPACE")
	if dbNamespace == "" {
		dbNamespace = "tinai-databases"
	}

	k8sCfg, err := rest.InClusterConfig()
	if err != nil {
		slog.Warn("not in cluster, databases provisioner disabled", "err", err)
	}

	bucketProv := buckets.New(pool, minioURL, minioKey, minioSecret)
	go bucketProv.Run(ctx)

	if k8sCfg != nil {
		dynClient, _ := dynamic.NewForConfig(k8sCfg)
		dbProv := databases.New(pool, dynClient, dbNamespace)
		go dbProv.Run(ctx)
	}

	slog.Info("tinai-storage-provisioner started")
	<-ctx.Done()
	slog.Info("shutting down")
}
