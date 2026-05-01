package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/tinai/tinai-realtime/internal/hub"
	"github.com/tinai/tinai-realtime/internal/natsbridge"
	"github.com/tinai/tinai-realtime/internal/natspub"
	"github.com/tinai/tinai-realtime/internal/pg"
	"github.com/tinai/tinai-realtime/internal/ws"
)

var (
	wsConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "tinai_realtime_ws_connections_total",
		Help: "Current number of active WebSocket connections",
	})
	pgNotifications = promauto.NewCounter(prometheus.CounterOpts{
		Name: "tinai_realtime_pg_notifications_total",
		Help: "Total PostgreSQL NOTIFY messages received",
	})
	msgBroadcasted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "tinai_realtime_messages_broadcasted_total",
		Help: "Total messages broadcast to WebSocket clients",
	})
	natsBridgeMessages = promauto.NewCounter(prometheus.CounterOpts{
		Name: "tinai_realtime_nats_bridge_messages_total",
		Help: "Total NATS JetStream messages received and fanned out via bridge",
	})
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3003"
	}

	// ---- NATS pub/sub client (hub pod fan-out) ----
	// A failure is non-fatal: the hub falls back to in-memory-only broadcast
	// mode so that a single-pod deployment or local dev environment without
	// NATS still works correctly.
	var nc *natspub.Client
	natsClient, err := natspub.New()
	if err != nil {
		log.Printf("WARNING: nats unavailable (%v) — running in in-memory broadcast mode", err)
	} else {
		nc = natsClient
		defer nc.Close()
	}

	// ---- Hub (PostgreSQL relay + pod fan-out) ----
	h := hub.New(nc)
	h.OnRegister = func() { wsConnections.Inc() }
	h.OnUnregister = func() { wsConnections.Dec() }
	h.OnBroadcast = func(n int) { msgBroadcasted.Add(float64(n)) }
	go h.Run()

	// ---- NATS JetStream bridge (cross-service fan-out on tinai.>) ----
	// The bridge subscribes to the wildcard subject "tinai.>" and fans out
	// incoming events to WebSocket clients that have subscribed to a
	// particular tenant_id via { "type": "subscribe", "tenant_id": "..." }.
	//
	// A nil bridge is handled gracefully in the WS handler: affected clients
	// simply will not receive JetStream events, but PG relay continues.
	var bridge *natsbridge.Bridge
	if natsClient != nil {
		b, err := natsbridge.NewFromConn(natsClient.Conn())
		if err != nil {
			log.Printf("WARNING: nats bridge unavailable (%v) — JetStream fan-out disabled", err)
		} else {
			bridge = b
			bridge.OnMessage = func() { natsBridgeMessages.Inc() }
			log.Printf("tinai-realtime: NATS JetStream bridge active (subject: tinai.>)")
		}
	}

	// ---- PostgreSQL LISTEN relay ----
	// Start relay; cancel its context on shutdown.
	relayCtx, relayCancel := context.WithCancel(context.Background())
	defer relayCancel()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL != "" {
		relay := pg.NewRelay(dbURL, h)
		relay.OnNotify = func() { pgNotifications.Inc() }
		go relay.Start(relayCtx)
	}

	// ---- HTTP routes ----
	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/ws", ws.Handler(h, bridge))
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})

	srv := &http.Server{Addr: ":" + port, Handler: nil}

	// ---- Graceful shutdown on SIGTERM/SIGINT ----
	// Shutdown order:
	//   1. Drain NATS bridge subscription (stop receiving new events)
	//   2. Cancel PG relay context
	//   3. Shut down HTTP server (waits for in-flight WS connections to close)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("tinai-realtime: shutting down...")

		// Step 1: drain NATS bridge first so no new messages are dispatched.
		if bridge != nil {
			bridge.Shutdown()
		}

		// Step 2: cancel PG relay.
		relayCancel()

		// Step 3: graceful HTTP shutdown (30 s timeout).
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	log.Printf("tinai-realtime listening on :%s", port)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	log.Printf("tinai-realtime: shutdown complete")
}
