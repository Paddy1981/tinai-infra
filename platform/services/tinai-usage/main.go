package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	_ "github.com/lib/pq"
)

var (
	prometheusURL = env("PROMETHEUS_URL", "http://prometheus-server.monitoring.svc.cluster.local:80")
	databaseURL   = env("DATABASE_URL", "") // must be injected via secret; no default password
	namespace     = env("STAGING_NAMESPACE", "tinai-staging")
)

const (
	cpuQuery = `sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])) by (container, namespace)`
	memQuery = `sum(container_memory_working_set_bytes{container!="",container!="POD"}) by (container, namespace)`

	// Per-second tracking queries — 10-second rate window, matches all tinai-* namespaces
	activeCPUQuery = `rate(container_cpu_usage_seconds_total{namespace=~"tinai-.*",container!="",container!="POD"}[10s])`
	activeMemQuery = `sum(container_memory_working_set_bytes{namespace=~"tinai-.*",container!="",container!="POD"}) by (container, namespace)`
)

type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		Result []struct {
			Metric map[string]string  `json:"metric"`
			Value  [2]json.RawMessage `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func queryPrometheus(query string) (*promResponse, error) {
	u := prometheusURL + "/api/v1/query?" + url.Values{"query": {query}}.Encode()
	resp, err := httpClient.Get(u)
	if err != nil {
		return nil, fmt.Errorf("prometheus request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result promResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("prometheus decode: %w", err)
	}
	if result.Status != "success" {
		return nil, fmt.Errorf("prometheus status: %s", result.Status)
	}
	return &result, nil
}

func parseValue(raw json.RawMessage) float64 {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// trackActiveCPU polls Prometheus every 10 seconds and writes sub-minute billing
// rows into cpu_seconds_log. It runs until ctx is cancelled.
func trackActiveCPU(ctx context.Context, db *sql.DB) {
	const windowSecs = 10

	ticker := time.NewTicker(windowSecs * time.Second)
	defer ticker.Stop()

	log.Println("active-cpu tracker: started (10s window)")

	for {
		select {
		case <-ctx.Done():
			log.Println("active-cpu tracker: shutting down")
			return
		case tick := <-ticker.C:
			windowEnd := tick.UTC()
			windowStart := windowEnd.Add(-windowSecs * time.Second)

			cpuResult, err := queryPrometheus(activeCPUQuery)
			if err != nil {
				log.Printf("active-cpu tracker: cpu query error: %v", err)
				continue
			}
			memResult, err := queryPrometheus(activeMemQuery)
			if err != nil {
				log.Printf("active-cpu tracker: mem query error: %v", err)
				continue
			}

			type key struct{ ns, container string }
			cpuMap := map[key]float64{}
			memMap := map[key]int64{}

			for _, r := range cpuResult.Data.Result {
				k := key{r.Metric["namespace"], r.Metric["container"]}
				cpuMap[k] = parseValue(r.Value[1])
			}
			for _, r := range memResult.Data.Result {
				k := key{r.Metric["namespace"], r.Metric["container"]}
				memMap[k] = int64(parseValue(r.Value[1]))
			}

			seen := map[key]bool{}
			for k := range cpuMap {
				seen[k] = true
			}
			for k := range memMap {
				seen[k] = true
			}

			inserted := 0
			for k := range seen {
				cpuRate := cpuMap[k]
				memBytes := memMap[k]

				// cpu_seconds consumed in the window = rate (cores) × window seconds
				cpuSeconds := cpuRate * windowSecs
				// memory_byte_seconds = bytes × window seconds
				memByteSeconds := memBytes * windowSecs

				if cpuSeconds == 0 && memByteSeconds == 0 {
					continue
				}

				_, err := db.ExecContext(ctx,
					`INSERT INTO cpu_seconds_log
					 (app_name, namespace, cpu_seconds, memory_byte_secs, window_start, window_end)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					k.container, k.ns, cpuSeconds, memByteSeconds, windowStart, windowEnd,
				)
				if err != nil {
					log.Printf("active-cpu tracker: insert %s/%s: %v", k.ns, k.container, err)
					continue
				}
				inserted++
			}

			if inserted > 0 {
				log.Printf("active-cpu tracker: %d rows at %s", inserted, windowEnd.Format(time.RFC3339))
			}
		}
	}
}

func main() {
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set; refusing to start without a database connection string")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("db ping: %v", err)
	}

	// ── Original 5-minute snapshot (single-shot, run by CronJob) ─────────────
	cpuResult, err := queryPrometheus(cpuQuery)
	if err != nil {
		log.Fatalf("cpu query: %v", err)
	}
	memResult, err := queryPrometheus(memQuery)
	if err != nil {
		log.Fatalf("mem query: %v", err)
	}

	// Build maps keyed by namespace+container
	type key struct{ ns, container string }
	cpuMap := map[key]float64{}
	memMap := map[key]int64{}

	for _, r := range cpuResult.Data.Result {
		ns := r.Metric["namespace"]
		if ns != namespace {
			continue
		}
		k := key{ns, r.Metric["container"]}
		cpuMap[k] = parseValue(r.Value[1])
	}
	for _, r := range memResult.Data.Result {
		ns := r.Metric["namespace"]
		if ns != namespace {
			continue
		}
		k := key{ns, r.Metric["container"]}
		memMap[k] = int64(parseValue(r.Value[1]))
	}

	seen := map[key]bool{}
	for k := range cpuMap {
		seen[k] = true
	}
	for k := range memMap {
		seen[k] = true
	}

	now := time.Now().UTC()
	inserted := 0
	for k := range seen {
		cpu := cpuMap[k]
		mem := memMap[k]
		if cpu == 0 && mem == 0 {
			continue
		}
		_, err = db.Exec(
			`INSERT INTO usage_snapshots (app_name, namespace, cpu_cores, memory_bytes, snapshot_at) VALUES ($1, $2, $3, $4, $5)`,
			k.container, k.ns, cpu, mem, now,
		)
		if err != nil {
			log.Printf("insert %s: %v", k.container, err)
			continue
		}
		inserted++
		log.Printf("snapshot: app=%s cpu=%.4f mem=%dMi", k.container, cpu, mem/1048576)
	}
	log.Printf("done: %d snapshots inserted at %s", inserted, now.Format(time.RFC3339))

	// ── Per-second active CPU tracking (long-running mode) ───────────────────
	// Enabled when ACTIVE_CPU_TRACKING=true (set on a Deployment, not the CronJob).
	if os.Getenv("ACTIVE_CPU_TRACKING") == "true" {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		trackActiveCPU(ctx, db)
	}
}
