package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/lib/pq"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"tinai.cloud/instances/internal/provisioner"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("tinai-instances provisioner starting")

	// --- Database ---
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}
	log.Println("database connection OK")

	// --- Kubernetes client ---
	k8sConfig, err := buildK8sConfig()
	if err != nil {
		log.Fatalf("k8s config: %v", err)
	}
	clientset, err := kubernetes.NewForConfig(k8sConfig)
	if err != nil {
		log.Fatalf("k8s client: %v", err)
	}
	log.Println("kubernetes client OK")

	// --- Run ---
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	p := provisioner.New(db, clientset)
	p.Run(ctx)
	log.Println("provisioner stopped")
}

// buildK8sConfig returns in-cluster config when running inside a pod,
// falling back to KUBECONFIG / default kubeconfig for local development.
func buildK8sConfig() (*rest.Config, error) {
	cfg, err := rest.InClusterConfig()
	if err == nil {
		return cfg, nil
	}
	// Fall back to kubeconfig file.
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		home, _ := os.UserHomeDir()
		kubeconfig = home + "/.kube/config"
	}
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}
