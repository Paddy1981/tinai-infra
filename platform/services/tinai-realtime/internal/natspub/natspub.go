package natspub

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/nats-io/nats.go"
)

// Client wraps a NATS connection with JetStream for tinai-realtime.
type Client struct {
	nc *nats.Conn
	js nats.JetStreamContext
}

// New connects to NATS and returns a Client.
// NATS_URL env var, defaults to nats://nats.nats.svc.cluster.local:4222 in-cluster,
// or nats://localhost:4222 (nats.DefaultURL) when NATS_URL is empty.
func New() (*Client, error) {
	url := os.Getenv("NATS_URL")
	if url == "" {
		url = nats.DefaultURL // nats://127.0.0.1:4222 — suitable for local dev
	}
	nc, err := nats.Connect(url,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Printf("nats: disconnected: %v", err)
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			log.Printf("nats: reconnected")
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}
	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("nats jetstream: %w", err)
	}
	log.Printf("nats: connected to %s", url)
	return &Client{nc: nc, js: js}, nil
}

// Publish publishes a message to the REALTIME JetStream stream.
// Subject format expected by the hub: tenant.{tenantID}.{channel}
func (c *Client) Publish(subject string, data []byte) error {
	_, err := c.js.Publish(subject, data)
	return err
}

// Subscribe subscribes to a core NATS subject pattern and calls handler for
// each message. Returns an unsubscribe function.
func (c *Client) Subscribe(subject string, handler func(subject string, data []byte)) (func(), error) {
	sub, err := c.nc.Subscribe(subject, func(msg *nats.Msg) {
		handler(msg.Subject, msg.Data)
	})
	if err != nil {
		return nil, err
	}
	return func() { _ = sub.Unsubscribe() }, nil
}

// Conn returns the underlying *nats.Conn so that other packages (e.g.
// natsbridge) can create their own subscriptions on the same connection.
func (c *Client) Conn() *nats.Conn {
	return c.nc
}

// Close drains and closes the NATS connection.
func (c *Client) Close() {
	_ = c.nc.Drain()
}
