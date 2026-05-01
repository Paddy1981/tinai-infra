package pg

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/lib/pq"
	"github.com/tinai/tinai-realtime/internal/hub"
)

const (
	pgChannel      = "tinai_events"
	minBackoff     = 1 * time.Second
	maxBackoff     = 30 * time.Second
	backoffFactor  = 2
)

// notifyPayload matches the JSON pushed by PostgreSQL NOTIFY statements:
//
//	NOTIFY tinai_events, '{"channel":"app:myapp:changes","event":"insert","data":{...}}'
type notifyPayload struct {
	Channel string          `json:"channel"`
	Event   string          `json:"event"`
	Data    json.RawMessage `json:"data"`
}

// outboundMsg is the envelope written to WebSocket subscribers.
type outboundMsg struct {
	Channel string          `json:"channel"`
	Event   string          `json:"event"`
	Data    json.RawMessage `json:"data"`
}

// Relay listens on the PostgreSQL LISTEN/NOTIFY channel and forwards decoded
// payloads to the Hub for broadcast.
//
// OnNotify is an optional callback invoked for every NOTIFY message received
// from PostgreSQL (before dispatch). Use it to drive Prometheus counters
// without importing the metrics library from this package.
type Relay struct {
	dsn      string
	hub      *hub.Hub
	OnNotify func()
}

// NewRelay constructs a Relay. Call Start in a goroutine.
func NewRelay(dsn string, h *hub.Hub) *Relay {
	return &Relay{dsn: dsn, hub: h}
}

// Start connects to PostgreSQL and begins relaying NOTIFY messages to the hub.
// It reconnects with exponential backoff (capped at maxBackoff) whenever the
// connection is lost. Start blocks until ctx is cancelled.
func (r *Relay) Start(ctx context.Context) {
	backoff := minBackoff

	for {
		err := r.listen(ctx)
		if ctx.Err() != nil {
			log.Printf("pg relay: context cancelled, stopping")
			return
		}
		if err != nil {
			log.Printf("pg relay: connection lost (%v), reconnecting in %s", err, backoff)
		} else {
			// Clean exit from a healthy connection — reset backoff
			backoff = minBackoff
			continue
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		// Increase backoff up to maxBackoff.
		backoff *= backoffFactor
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// listen opens a single pq.Listener connection and processes notifications
// until the connection drops or ctx is cancelled.
func (r *Relay) listen(ctx context.Context) error {
	reportProblem := func(ev pq.ListenerEventType, err error) {
		if err != nil {
			log.Printf("pg listener event %d: %v", ev, err)
		}
	}

	listener := pq.NewListener(r.dsn, minBackoff, maxBackoff, reportProblem)
	if err := listener.Listen(pgChannel); err != nil {
		_ = listener.Close()
		return err
	}
	defer listener.Close()

	log.Printf("pg relay: listening on channel %q", pgChannel)

	// Reset backoff to minimum on a successful connection.
	for {
		select {
		case <-ctx.Done():
			return nil

		case n, ok := <-listener.Notify:
			if !ok {
				return fmt.Errorf("pq listener channel closed")
			}
			if n == nil {
				// Keepalive ping from pq — ignore.
				continue
			}
			r.dispatch(n.Extra)

		case <-time.After(90 * time.Second):
			// Periodic ping to detect stale connections.
			if err := listener.Ping(); err != nil {
				return err
			}
		}
	}
}

// dispatch parses a raw NOTIFY payload and broadcasts it to hub subscribers.
func (r *Relay) dispatch(raw string) {
	if r.OnNotify != nil {
		r.OnNotify()
	}
	var p notifyPayload
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		log.Printf("pg relay: bad payload %q: %v", raw, err)
		return
	}
	if p.Channel == "" {
		log.Printf("pg relay: payload missing channel field: %q", raw)
		return
	}

	out := outboundMsg{
		Channel: p.Channel,
		Event:   p.Event,
		Data:    p.Data,
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		log.Printf("pg relay: marshal error: %v", err)
		return
	}

	r.hub.Broadcast(p.Channel, encoded)
}
