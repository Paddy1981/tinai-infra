package main

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// Tinai Edge Agent — lightweight metrics collector for any node
// Pushes node metrics to Prometheus Pushgateway every 15 seconds
// Designed for: K3s worker nodes, WSL, edge devices, any Linux box

func main() {
	pushURL := os.Getenv("PUSHGATEWAY_URL")
	if pushURL == "" {
		pushURL = "http://pushgateway.monitoring.svc.cluster.local:9091"
	}
	nodeName := os.Getenv("NODE_NAME")
	if nodeName == "" {
		name, _ := os.Hostname()
		nodeName = name
	}
	interval := 15 * time.Second

	log.Printf("tinai-edge-agent starting: node=%s push=%s interval=%s", nodeName, pushURL, interval)

	for {
		metrics := collectMetrics(nodeName)
		pushMetrics(pushURL, nodeName, metrics)
		time.Sleep(interval)
	}
}

func collectMetrics(node string) string {
	var b strings.Builder

	// CPU count
	b.WriteString(fmt.Sprintf("# HELP tinai_node_cpu_count Number of CPU cores\n"))
	b.WriteString(fmt.Sprintf("# TYPE tinai_node_cpu_count gauge\n"))
	b.WriteString(fmt.Sprintf("tinai_node_cpu_count{node=%q} %d\n", node, runtime.NumCPU()))

	// Memory from /proc/meminfo
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "MemTotal:") {
				val := parseMeminfo(line)
				b.WriteString(fmt.Sprintf("# HELP tinai_node_memory_total_bytes Total memory\n"))
				b.WriteString(fmt.Sprintf("# TYPE tinai_node_memory_total_bytes gauge\n"))
				b.WriteString(fmt.Sprintf("tinai_node_memory_total_bytes{node=%q} %d\n", node, val*1024))
			}
			if strings.HasPrefix(line, "MemAvailable:") {
				val := parseMeminfo(line)
				b.WriteString(fmt.Sprintf("# HELP tinai_node_memory_available_bytes Available memory\n"))
				b.WriteString(fmt.Sprintf("# TYPE tinai_node_memory_available_bytes gauge\n"))
				b.WriteString(fmt.Sprintf("tinai_node_memory_available_bytes{node=%q} %d\n", node, val*1024))
			}
			if strings.HasPrefix(line, "SwapTotal:") {
				val := parseMeminfo(line)
				b.WriteString(fmt.Sprintf("tinai_node_swap_total_bytes{node=%q} %d\n", node, val*1024))
			}
			if strings.HasPrefix(line, "SwapFree:") {
				val := parseMeminfo(line)
				b.WriteString(fmt.Sprintf("tinai_node_swap_free_bytes{node=%q} %d\n", node, val*1024))
			}
		}
	}

	// Load average from /proc/loadavg
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		parts := strings.Fields(string(data))
		if len(parts) >= 3 {
			b.WriteString(fmt.Sprintf("# HELP tinai_node_load1 1 minute load average\n"))
			b.WriteString(fmt.Sprintf("# TYPE tinai_node_load1 gauge\n"))
			b.WriteString(fmt.Sprintf("tinai_node_load1{node=%q} %s\n", node, parts[0]))
			b.WriteString(fmt.Sprintf("tinai_node_load5{node=%q} %s\n", node, parts[1]))
			b.WriteString(fmt.Sprintf("tinai_node_load15{node=%q} %s\n", node, parts[2]))
		}
	}

	// Uptime from /proc/uptime
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		parts := strings.Fields(string(data))
		if len(parts) >= 1 {
			b.WriteString(fmt.Sprintf("# HELP tinai_node_uptime_seconds System uptime\n"))
			b.WriteString(fmt.Sprintf("# TYPE tinai_node_uptime_seconds gauge\n"))
			b.WriteString(fmt.Sprintf("tinai_node_uptime_seconds{node=%q} %s\n", node, parts[0]))
		}
	}

	// Disk from /proc/mounts + statfs (simplified — just report root)
	if stat, err := os.Stat("/"); err == nil {
		_ = stat
		// Use df-like approach via /proc/self/mountinfo
		b.WriteString(fmt.Sprintf("# HELP tinai_node_agent_up Agent is running\n"))
		b.WriteString(fmt.Sprintf("# TYPE tinai_node_agent_up gauge\n"))
		b.WriteString(fmt.Sprintf("tinai_node_agent_up{node=%q} 1\n", node))
	}

	// Timestamp
	b.WriteString(fmt.Sprintf("# HELP tinai_node_last_push_timestamp Unix timestamp of last push\n"))
	b.WriteString(fmt.Sprintf("# TYPE tinai_node_last_push_timestamp gauge\n"))
	b.WriteString(fmt.Sprintf("tinai_node_last_push_timestamp{node=%q} %d\n", node, time.Now().Unix()))

	return b.String()
}

func parseMeminfo(line string) int64 {
	parts := strings.Fields(line)
	if len(parts) < 2 {
		return 0
	}
	var val int64
	fmt.Sscanf(parts[1], "%d", &val)
	return val
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func pushMetrics(pushURL, nodeName, metrics string) {
	url := fmt.Sprintf("%s/metrics/job/tinai-edge-agent/node/%s", pushURL, nodeName)
	resp, err := httpClient.Post(url, "text/plain", bytes.NewBufferString(metrics))
	if err != nil {
		log.Printf("push failed: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 202 {
		log.Printf("push returned %d", resp.StatusCode)
	}
}
