package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tinai/tinai-realtime/internal/hub"
	"github.com/tinai/tinai-realtime/internal/jwtauth"
	"github.com/tinai/tinai-realtime/internal/natsbridge"
)

const (
	// writeWait is the time allowed to write a message to the peer.
	writeWait = 10 * time.Second
	// pongWait is the time allowed to read the next pong message.
	pongWait = 60 * time.Second
	// pingPeriod is how often a ping is sent (must be less than pongWait).
	pingPeriod = (pongWait * 9) / 10
	// maxMessageSize is the maximum inbound message size in bytes.
	maxMessageSize = 4096

	// closeUnauthorized is the WebSocket application-level close code used
	// when a client attempts to subscribe to a channel it does not own.
	closeUnauthorized = 4001
)

// upgrader validates the WebSocket upgrade request against an explicit origin
// allowlist. Connections from unlisted origins are rejected.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		allowed := map[string]bool{
			"https://tinai.cloud":     true,
			"https://app.tinai.cloud": true,
		}
		return allowed[origin]
	},
}

// inboundMsg is the unified JSON structure the client sends to the server.
//
// Two protocols are supported:
//
//  1. Hub channel protocol (original):
//     { "action": "subscribe"|"unsubscribe", "channel": "tenant:acme:logs" }
//
//  2. NATS bridge protocol (new):
//     { "type": "subscribe"|"unsubscribe", "tenant_id": "acme" }
//
// The two protocols are distinguished by whether the "type" or "action" field
// is present. Both may be used on the same connection simultaneously.
type inboundMsg struct {
	// Hub channel protocol fields
	Action  string `json:"action"`  // "subscribe" | "unsubscribe"
	Channel string `json:"channel"` // e.g. "tenant:acme:logs"

	// NATS bridge protocol fields
	Type     string `json:"type"`      // "subscribe" | "unsubscribe"
	TenantID string `json:"tenant_id"` // e.g. "acme"
}

// Handler returns an http.HandlerFunc that upgrades the connection to WebSocket
// and wires it to both the Hub (PostgreSQL NOTIFY relay + pod fan-out) and the
// NATS bridge (cross-service JetStream fan-out).
//
// Authentication: a valid JWT must be supplied before the upgrade either as
//   - Authorization: Bearer <token> request header, OR
//   - ?token=<token> query parameter (for browser WebSocket clients that
//     cannot set arbitrary headers).
//
// The tenant_id claim from the JWT is stored on the Client so that channel
// subscriptions can be authorised: every hub channel the client subscribes to
// must begin with "tenant:{tenant_id}:". NATS bridge subscriptions are
// restricted to the authenticated tenant's own tenant_id.
//
// bridge may be nil: when NATS is unavailable the handler operates without the
// JetStream fan-out and only serves hub (PG relay) traffic.
func Handler(h *hub.Hub, bridge *natsbridge.Bridge) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ---- JWT validation BEFORE upgrade ----
		tenantID, err := extractAndValidateToken(r)
		if err != nil {
			log.Printf("ws auth rejected: %v", err)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		// ---- Upgrade to WebSocket ----
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade error: %v", err)
			return
		}

		// ---- Hub client (PG relay + pod fan-out) ----
		hubClient := &hub.Client{
			Send:     make(chan []byte, 256),
			TenantID: tenantID,
		}
		h.Register(hubClient)

		// ---- NATS bridge connection (JetStream fan-out) ----
		// bridgeConn is nil when the bridge is unavailable; read/write pumps
		// handle this gracefully.
		var bridgeConn *natsbridge.Conn
		if bridge != nil {
			bridgeConn = bridge.Register()
		}

		// done is closed by readPump when the read loop exits, signalling
		// writePump to stop.
		done := make(chan struct{})

		go writePump(conn, hubClient, bridgeConn, done)
		readPump(conn, hubClient, bridgeConn, h, bridge, tenantID, done)

		// Cleanup: unregister from hub (closes hubClient.Send → writePump exits).
		h.Unregister(hubClient)
		// Unregister from bridge (closes bridgeConn.Send if not already closed).
		if bridge != nil && bridgeConn != nil {
			bridge.Unregister(bridgeConn)
		}
	}
}

// extractAndValidateToken picks a JWT from the Authorization header or the
// ?token= query param and returns the validated tenant_id.
func extractAndValidateToken(r *http.Request) (string, error) {
	var tokenStr string

	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		tokenStr = strings.TrimPrefix(auth, "Bearer ")
	} else if t := r.URL.Query().Get("token"); t != "" {
		tokenStr = t
	} else {
		return "", fmt.Errorf("no token provided (Authorization header or ?token= required)")
	}

	return jwtauth.ParseTenantID(tokenStr)
}

// readPump reads inbound control messages from the WebSocket connection. It
// dispatches to the hub channel protocol or the NATS bridge protocol depending
// on which fields are present in the incoming JSON.
//
// It runs in the HTTP handler goroutine so that http.Server can track the
// connection lifecycle correctly.
func readPump(
	conn *websocket.Conn,
	c *hub.Client,
	bc *natsbridge.Conn,
	h *hub.Hub,
	bridge *natsbridge.Bridge,
	authenticatedTenantID string,
	done chan struct{},
) {
	defer close(done)

	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseAbnormalClosure,
			) {
				log.Printf("ws read error: %v", err)
			}
			return
		}

		var msg inboundMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("ws bad message: %v", err)
			continue
		}

		// ---- Dispatch: NATS bridge protocol ("type" field) ----
		if msg.Type != "" {
			handleBridgeMessage(msg, bc, bridge, authenticatedTenantID, conn)
			continue
		}

		// ---- Dispatch: Hub channel protocol ("action" field) ----
		if msg.Channel == "" {
			continue
		}

		// Channel authorization: every hub channel must be scoped to the
		// authenticated tenant. Expected prefix: "tenant:{tenant_id}:"
		expectedPrefix := "tenant:" + c.TenantID + ":"
		if !strings.HasPrefix(msg.Channel, expectedPrefix) {
			log.Printf("ws channel auth denied: client tenant=%q tried to access channel %q",
				c.TenantID, msg.Channel)
			closeMsg := websocket.FormatCloseMessage(closeUnauthorized, "channel not permitted for this tenant")
			_ = conn.WriteMessage(websocket.CloseMessage, closeMsg)
			return
		}

		switch msg.Action {
		case "subscribe":
			h.Subscribe(c, msg.Channel)
		case "unsubscribe":
			h.Unsubscribe(c, msg.Channel)
		default:
			log.Printf("ws unknown action: %q", msg.Action)
		}
	}
}

// handleBridgeMessage processes a NATS bridge protocol message
// ({ "type": "subscribe"|"unsubscribe", "tenant_id": "..." }).
//
// Authorization: clients may only subscribe to their own tenant_id (the one
// embedded in the JWT). Attempts to subscribe to a different tenant are
// rejected with a close frame.
func handleBridgeMessage(
	msg inboundMsg,
	bc *natsbridge.Conn,
	bridge *natsbridge.Bridge,
	authenticatedTenantID string,
	conn *websocket.Conn,
) {
	if bridge == nil || bc == nil {
		log.Printf("ws bridge msg ignored: NATS bridge unavailable")
		return
	}

	if msg.TenantID == "" {
		log.Printf("ws bridge msg missing tenant_id — ignoring")
		return
	}

	// Enforce tenant isolation: clients can only subscribe to their own tenant.
	if msg.TenantID != authenticatedTenantID {
		log.Printf("ws bridge auth denied: client tenant=%q tried to subscribe to tenant=%q",
			authenticatedTenantID, msg.TenantID)
		closeMsg := websocket.FormatCloseMessage(closeUnauthorized, "tenant_id not permitted for this connection")
		_ = conn.WriteMessage(websocket.CloseMessage, closeMsg)
		return
	}

	switch msg.Type {
	case "subscribe":
		bridge.Subscribe(bc, msg.TenantID)
	case "unsubscribe":
		bridge.Unsubscribe(bc, msg.TenantID)
	default:
		log.Printf("ws bridge unknown type: %q", msg.Type)
	}
}

// writePump drains both the hub client's Send channel and (if present) the
// NATS bridge connection's Send channel, forwarding messages to the WebSocket.
// It also sends periodic pings to keep the connection alive.
func writePump(
	conn *websocket.Conn,
	c *hub.Client,
	bc *natsbridge.Conn,
	done <-chan struct{},
) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		conn.Close()
	}()

	// Determine which channels to select from. When bc is nil we use a nil
	// channel (which blocks forever in a select, effectively disabling it).
	var bridgeSend <-chan []byte
	if bc != nil {
		bridgeSend = bc.Send
	}

	for {
		select {
		// ---- Hub (PG relay / pod fan-out) messages ----
		case msg, ok := <-c.Send:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel — send a close frame and exit.
				_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("ws write error: %v", err)
				return
			}

		// ---- NATS bridge messages ----
		case msg, ok := <-bridgeSend:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Bridge closed the channel (e.g. Shutdown called) — stop writing.
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("ws write error (bridge): %v", err)
				return
			}

		// ---- Keepalive ping ----
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}

		// ---- readPump exited ----
		case <-done:
			return
		}
	}
}
