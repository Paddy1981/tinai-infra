// Package natsbridge subscribes to the NATS JetStream subject pattern
// "tinai.>" and fans out matching events to connected WebSocket clients that
// have registered interest in a particular tenant_id.
//
// Protocol (inbound from WS client):
//
//	{ "type": "subscribe",   "tenant_id": "acme" }
//	{ "type": "unsubscribe", "tenant_id": "acme" }
//
// Protocol (outbound to WS client):
//
//	{ "type": "event", "event": <original NATS payload> }
//
// NATS message payloads must be valid JSON objects that contain at least a
// "tenant_id" field. Any additional fields (e.g. "event_type") are forwarded
// unchanged inside the "event" envelope.
package natsbridge

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/nats-io/nats.go"
)

const (
	// natsSubject is the wildcard subject the bridge subscribes to.
	natsSubject = "tinai.>"

	// sendBufSize is the per-connection outbound buffer (messages).
	// Slow consumers are dropped rather than blocking the dispatch loop.
	sendBufSize = 256
)

// Conn represents a single WebSocket connection registered with the bridge.
// Callers obtain a *Conn via Register and hold it for the lifetime of the WS
// session; they drain Send and call Unregister when the session ends.
type Conn struct {
	Send chan []byte
	mu   sync.Mutex
	open bool
}

// send attempts a non-blocking write to the connection's Send channel.
// Returns false if the connection is closed or the buffer is full (slow consumer).
func (c *Conn) send(data []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.open {
		return false
	}
	select {
	case c.Send <- data:
		return true
	default:
		// Slow consumer — drop the message.
		return false
	}
}

// close marks the connection as closed and closes the Send channel.
// Must only be called once (by Unregister).
func (c *Conn) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open {
		c.open = false
		close(c.Send)
	}
}

// outboundMsg is the JSON envelope pushed to WebSocket subscribers.
type outboundMsg struct {
	Type  string          `json:"type"`
	Event json.RawMessage `json:"event"`
}

// natsPayload is the minimal structure required in every NATS message.
type natsPayload struct {
	TenantID  string `json:"tenant_id"`
	EventType string `json:"event_type"`
}

// Bridge manages NATS subscriptions and tenant-scoped WebSocket fan-out. All
// mutations to the internal maps are serialised through a mutex; dispatch
// happens in the NATS subscription callback (a separate goroutine).
//
// OnMessage is an optional callback invoked for every NATS message that is
// successfully parsed and fanned out. Use it to drive Prometheus counters
// without importing the metrics library from this package.
type Bridge struct {
	nc  *nats.Conn
	sub *nats.Subscription

	// OnMessage is called (in the NATS callback goroutine) for each message
	// that is dispatched to at least one subscriber. May be nil.
	OnMessage func()

	mu      sync.RWMutex
	tenants map[string]map[*Conn]bool // tenantID → set of conns
}

// NewFromConn creates a Bridge on an existing *nats.Conn and subscribes to
// "tinai.>" for cross-service fan-out. The caller is responsible for calling
// Shutdown before the process exits to drain the subscription cleanly.
func NewFromConn(nc *nats.Conn) (*Bridge, error) {
	b := &Bridge{
		nc:      nc,
		tenants: make(map[string]map[*Conn]bool),
	}

	sub, err := nc.Subscribe(natsSubject, b.handleNATSMessage)
	if err != nil {
		return nil, err
	}
	b.sub = sub
	log.Printf("natsbridge: subscribed to %q", natsSubject)
	return b, nil
}

// Register creates a new Conn for an incoming WebSocket session and returns
// it. The caller must call Unregister(conn) when the session ends.
func (b *Bridge) Register() *Conn {
	c := &Conn{
		Send: make(chan []byte, sendBufSize),
		open: true,
	}
	return c
}

// Subscribe adds conn to the fan-out set for tenantID.
func (b *Bridge) Subscribe(conn *Conn, tenantID string) {
	if tenantID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.tenants[tenantID]; !ok {
		b.tenants[tenantID] = make(map[*Conn]bool)
	}
	b.tenants[tenantID][conn] = true
	log.Printf("natsbridge: conn subscribed to tenant %q", tenantID)
}

// Unsubscribe removes conn from the fan-out set for tenantID.
func (b *Bridge) Unsubscribe(conn *Conn, tenantID string) {
	if tenantID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if subs, ok := b.tenants[tenantID]; ok {
		delete(subs, conn)
		if len(subs) == 0 {
			delete(b.tenants, tenantID)
		}
	}
}

// Unregister removes conn from all tenant subscriptions and closes its Send
// channel. Must be called exactly once per Conn when the WS session ends.
func (b *Bridge) Unregister(conn *Conn) {
	b.mu.Lock()
	for tenantID, subs := range b.tenants {
		if subs[conn] {
			delete(subs, conn)
			if len(subs) == 0 {
				delete(b.tenants, tenantID)
			}
		}
	}
	b.mu.Unlock()
	conn.close()
}

// handleNATSMessage is the NATS message callback. It parses the tenant_id
// from the JSON payload and fans out to all matching WS connections.
func (b *Bridge) handleNATSMessage(msg *nats.Msg) {
	var p natsPayload
	if err := json.Unmarshal(msg.Data, &p); err != nil {
		log.Printf("natsbridge: unparseable message on subject %q: %v", msg.Subject, err)
		return
	}
	if p.TenantID == "" {
		log.Printf("natsbridge: message on subject %q missing tenant_id — skipping", msg.Subject)
		return
	}

	// Build the outbound envelope once and reuse it for all recipients.
	envelope, err := json.Marshal(outboundMsg{
		Type:  "event",
		Event: json.RawMessage(msg.Data),
	})
	if err != nil {
		log.Printf("natsbridge: marshal error: %v", err)
		return
	}

	b.mu.RLock()
	subs := b.tenants[p.TenantID]
	// Copy the set under read-lock to avoid holding the lock during sends.
	targets := make([]*Conn, 0, len(subs))
	for conn := range subs {
		targets = append(targets, conn)
	}
	b.mu.RUnlock()

	for _, conn := range targets {
		if !conn.send(envelope) {
			log.Printf("natsbridge: dropped message for tenant %q (conn closed or slow consumer)", p.TenantID)
		}
	}
	if len(targets) > 0 && b.OnMessage != nil {
		b.OnMessage()
	}
	log.Printf("natsbridge: fanned out event_type=%q tenant=%q to %d connection(s)",
		p.EventType, p.TenantID, len(targets))
}

// Shutdown drains the NATS subscription and closes all registered connections.
// It should be called on SIGTERM before the HTTP server shuts down.
func (b *Bridge) Shutdown() {
	if b.sub != nil {
		if err := b.sub.Drain(); err != nil {
			log.Printf("natsbridge: drain error: %v", err)
		}
		log.Printf("natsbridge: subscription drained")
	}

	// Close all open connections so their WS write-pumps exit cleanly.
	b.mu.Lock()
	defer b.mu.Unlock()
	for tenantID, subs := range b.tenants {
		for conn := range subs {
			conn.close()
		}
		delete(b.tenants, tenantID)
	}
}
