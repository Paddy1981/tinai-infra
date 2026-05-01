package hub

import (
	"log"
	"strings"

	"github.com/tinai/tinai-realtime/internal/natspub"
)

// CmdType identifies the operation to perform on the hub.
type CmdType int

const (
	CmdRegister   CmdType = iota // add a new client
	CmdUnregister                // remove a client and clean up all subscriptions
	CmdSubscribe                 // subscribe a client to a channel
	CmdUnsubscribe               // unsubscribe a client from a channel
	CmdBroadcast                 // send a payload to every subscriber of a channel
)

// Cmd is the single command type funnelled through the hub's command channel.
// All fields are optional depending on CmdType:
//
//	CmdRegister / CmdUnregister — Client only
//	CmdSubscribe / CmdUnsubscribe — Client + Channel
//	CmdBroadcast — Channel + Payload
type Cmd struct {
	Type    CmdType
	Client  *Client
	Channel string
	Payload []byte
	// fromNATS is set to true when the broadcast originated from a NATS message
	// so that the hub does NOT re-publish it to NATS (avoids infinite loops).
	fromNATS bool
}

// Client represents a connected WebSocket peer. The hub writes outbound
// messages to Send; the WS write-goroutine drains it.
// TenantID is set from the validated JWT at connection time and is used to
// enforce channel-level authorization in the WS handler.
type Client struct {
	Send     chan []byte
	TenantID string
}

// Hub owns the authoritative maps of clients and channel subscriptions.
// All mutations are serialised through the cmds channel so no locks are needed.
//
// OnRegister, OnUnregister and OnBroadcast are optional callbacks invoked in
// the Run loop. Use them to drive Prometheus metrics without importing the
// metrics library from this package.
//
// NATS integration (optional):
//   - If nats is non-nil, subscribing a client to a channel also creates a
//     NATS subscription so that broadcasts from other pod replicas are received
//     and fanned out locally.
//   - Outbound broadcasts are published to NATS so peer pods receive them.
//   - If nats is nil the hub operates in pure in-memory mode (dev / no-NATS).
type Hub struct {
	clients      map[*Client]bool
	channels     map[string]map[*Client]bool
	cmds         chan Cmd
	nats         *natspub.Client
	// natsUnsubs tracks NATS unsubscribe functions keyed by channel name.
	// A NATS subscription is created on the first WebSocket subscription to a
	// channel and torn down when the last WebSocket subscriber leaves.
	natsUnsubs   map[string]func()
	OnRegister   func()
	OnUnregister func()
	OnBroadcast  func(n int) // n = number of recipients
}

// New constructs a Hub ready to be started with Run().
// Pass a non-nil *natspub.Client to enable NATS pub/sub fan-out across pod
// replicas. Pass nil to run in in-memory-only mode.
func New(nc *natspub.Client) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		channels:   make(map[string]map[*Client]bool),
		cmds:       make(chan Cmd, 256),
		nats:       nc,
		natsUnsubs: make(map[string]func()),
	}
}

// Run processes hub commands sequentially. It must be called in its own
// goroutine and runs until the process exits.
func (h *Hub) Run() {
	for cmd := range h.cmds {
		switch cmd.Type {

		case CmdRegister:
			h.clients[cmd.Client] = true
			if h.OnRegister != nil {
				h.OnRegister()
			}

		case CmdUnregister:
			if _, ok := h.clients[cmd.Client]; ok {
				delete(h.clients, cmd.Client)
				if h.OnUnregister != nil {
					h.OnUnregister()
				}
				close(cmd.Client.Send)
				// Remove from every channel subscription; tear down NATS
				// subscriptions that now have no local subscribers.
				for ch, subs := range h.channels {
					if subs[cmd.Client] {
						delete(subs, cmd.Client)
					}
					if len(subs) == 0 {
						delete(h.channels, ch)
						h.teardownNATSSub(ch)
					}
				}
			}

		case CmdSubscribe:
			if _, ok := h.channels[cmd.Channel]; !ok {
				h.channels[cmd.Channel] = make(map[*Client]bool)
				// First local subscriber on this channel — create a NATS sub.
				h.ensureNATSSub(cmd.Channel)
			}
			h.channels[cmd.Channel][cmd.Client] = true

		case CmdUnsubscribe:
			if subs, ok := h.channels[cmd.Channel]; ok {
				delete(subs, cmd.Client)
				if len(subs) == 0 {
					delete(h.channels, cmd.Channel)
					h.teardownNATSSub(cmd.Channel)
				}
			}

		case CmdBroadcast:
			// Publish to NATS first (skip if message arrived from NATS to avoid loop).
			if h.nats != nil && !cmd.fromNATS {
				natsSubject := channelToNATSSubject(cmd.Channel)
				if err := h.nats.Publish(natsSubject, cmd.Payload); err != nil {
					log.Printf("hub: nats publish error on %q: %v", natsSubject, err)
				}
			}
			// Fan out to local WebSocket clients.
			if subs, ok := h.channels[cmd.Channel]; ok {
				n := 0
				for client := range subs {
					select {
					case client.Send <- cmd.Payload:
						n++
					default:
						// Slow consumer: drop the message to avoid blocking the hub.
					}
				}
				if h.OnBroadcast != nil && n > 0 {
					h.OnBroadcast(n)
				}
			}
		}
	}
}

// ensureNATSSub creates a NATS subscription for the given hub channel if NATS
// is configured and no subscription exists yet.
// Must be called from within the Run() goroutine (no concurrent access).
func (h *Hub) ensureNATSSub(channel string) {
	if h.nats == nil {
		return
	}
	if _, exists := h.natsUnsubs[channel]; exists {
		return
	}
	natsSubject := channelToNATSSubject(channel)
	unsub, err := h.nats.Subscribe(natsSubject, func(_ string, data []byte) {
		// Deliver the message to local WebSocket subscribers via the normal
		// command path, marking it as fromNATS so it is not re-published.
		h.cmds <- Cmd{
			Type:     CmdBroadcast,
			Channel:  channel,
			Payload:  data,
			fromNATS: true,
		}
	})
	if err != nil {
		log.Printf("hub: nats subscribe error on %q: %v", natsSubject, err)
		return
	}
	h.natsUnsubs[channel] = unsub
	log.Printf("hub: nats subscription created for channel %q (subject %q)", channel, natsSubject)
}

// teardownNATSSub unsubscribes from NATS for the given hub channel if a
// subscription exists.
// Must be called from within the Run() goroutine.
func (h *Hub) teardownNATSSub(channel string) {
	if unsub, ok := h.natsUnsubs[channel]; ok {
		unsub()
		delete(h.natsUnsubs, channel)
		log.Printf("hub: nats subscription removed for channel %q", channel)
	}
}

// channelToNATSSubject converts a hub channel name to a NATS subject.
// Hub channels use colon separators ("tenant:acme:logs");
// NATS subjects use dots ("tenant.acme.logs").
func channelToNATSSubject(channel string) string {
	return strings.ReplaceAll(channel, ":", ".")
}

// Register enqueues a CmdRegister for the given client.
func (h *Hub) Register(c *Client) {
	h.cmds <- Cmd{Type: CmdRegister, Client: c}
}

// Unregister enqueues a CmdUnregister for the given client.
func (h *Hub) Unregister(c *Client) {
	h.cmds <- Cmd{Type: CmdUnregister, Client: c}
}

// Subscribe enqueues a CmdSubscribe to add the client to the named channel.
func (h *Hub) Subscribe(c *Client, channel string) {
	h.cmds <- Cmd{Type: CmdSubscribe, Client: c, Channel: channel}
}

// Unsubscribe enqueues a CmdUnsubscribe to remove the client from a channel.
func (h *Hub) Unsubscribe(c *Client, channel string) {
	h.cmds <- Cmd{Type: CmdUnsubscribe, Client: c, Channel: channel}
}

// Broadcast enqueues a CmdBroadcast to push msg to all subscribers of channel.
func (h *Hub) Broadcast(channel string, msg []byte) {
	h.cmds <- Cmd{Type: CmdBroadcast, Channel: channel, Payload: msg}
}
