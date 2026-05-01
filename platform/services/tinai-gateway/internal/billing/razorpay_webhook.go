// Package billing handles Razorpay payment webhook processing.
package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
)

// Handler processes Razorpay payment webhooks.
// Supported events: payment.captured, payment.failed, order.paid
type Handler struct {
	db     *sql.DB
	secret string // RAZORPAY_WEBHOOK_SECRET env var
}

// NewHandler creates a new billing Handler using the given *sql.DB.
// The RAZORPAY_WEBHOOK_SECRET environment variable is read at construction time.
func NewHandler(db *sql.DB) *Handler {
	return &Handler{
		db:     db,
		secret: os.Getenv("RAZORPAY_WEBHOOK_SECRET"),
	}
}

// razorpayEvent is the top-level envelope Razorpay sends for every webhook.
type razorpayEvent struct {
	Event   string          `json:"event"`
	Payload razorpayPayload `json:"payload"`
}

type razorpayPayload struct {
	Payment *razorpayEntity `json:"payment"`
	Order   *razorpayEntity `json:"order"`
}

type razorpayEntity struct {
	Entity *razorpayEntityData `json:"entity"`
}

type razorpayEntityData struct {
	ID      string `json:"id"`
	OrderID string `json:"order_id"` // present on payment entity
}

// ServeHTTP implements http.Handler.
//
// Flow:
//  1. Read body in full (needed for HMAC verification).
//  2. Verify X-Razorpay-Signature header against HMAC-SHA256(body, secret).
//  3. Dispatch based on event string.
//  4. Always return 200 so Razorpay does not retry.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("billing/webhook: failed to read body: %v", err)
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}

	if h.secret == "" {
		// Secret not configured: acknowledge the webhook so Razorpay does not
		// enter an infinite retry loop, but take no action on the payload.
		log.Printf("billing/webhook: RAZORPAY_WEBHOOK_SECRET not configured — acknowledging and discarding event")
		w.WriteHeader(http.StatusOK)
		return
	}
	if !h.verifySignature(body, r.Header.Get("X-Razorpay-Signature")) {
		log.Printf("billing/webhook: signature mismatch — possible spoofed request")
		http.Error(w, `{"error":"invalid signature"}`, http.StatusBadRequest)
		return
	}

	var event razorpayEvent
	if err := json.Unmarshal(body, &event); err != nil {
		log.Printf("billing/webhook: failed to parse event JSON: %v", err)
		// Still return 200 to prevent Razorpay from retrying malformed payloads.
		w.WriteHeader(http.StatusOK)
		return
	}

	log.Printf("billing/webhook: received event %q", event.Event)

	switch event.Event {
	case "payment.captured":
		h.handlePaymentCaptured(r, event)
	case "payment.failed":
		h.handlePaymentFailed(r, event)
	case "order.paid":
		h.handleOrderPaid(r, event)
	default:
		// Unknown events are acknowledged but not acted upon.
		log.Printf("billing/webhook: ignoring unknown event %q", event.Event)
	}

	w.WriteHeader(http.StatusOK)
}

// verifySignature returns true when HMAC-SHA256(body, secret) == sig.
// Returns false (and logs a warning) when the secret is not configured.
func (h *Handler) verifySignature(body []byte, sig string) bool {
	if h.secret == "" {
		log.Printf("billing/webhook: WARNING — RAZORPAY_WEBHOOK_SECRET is not set, skipping signature check")
		return false
	}
	mac := hmac.New(sha256.New, []byte(h.secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

// handlePaymentCaptured sets payment_status='captured' and records the Razorpay
// payment ID on the matching invoice row.
func (h *Handler) handlePaymentCaptured(r *http.Request, event razorpayEvent) {
	if event.Payload.Payment == nil || event.Payload.Payment.Entity == nil {
		log.Printf("billing/webhook: payment.captured missing payment entity")
		return
	}
	entity := event.Payload.Payment.Entity
	orderID := entity.OrderID
	paymentID := entity.ID

	if orderID == "" {
		log.Printf("billing/webhook: payment.captured — empty order_id, skipping DB update")
		return
	}

	res, err := h.db.ExecContext(r.Context(),
		`UPDATE invoices
		    SET payment_status       = 'captured',
		        razorpay_payment_id  = $1
		  WHERE razorpay_order_id    = $2`,
		paymentID, orderID,
	)
	if err != nil {
		log.Printf("billing/webhook: payment.captured DB error (order %s): %v", orderID, err)
		return
	}
	logRowsAffected("payment.captured", orderID, res)
}

// handlePaymentFailed marks the invoice payment_status as 'failed'.
func (h *Handler) handlePaymentFailed(r *http.Request, event razorpayEvent) {
	if event.Payload.Payment == nil || event.Payload.Payment.Entity == nil {
		log.Printf("billing/webhook: payment.failed missing payment entity")
		return
	}
	orderID := event.Payload.Payment.Entity.OrderID

	if orderID == "" {
		log.Printf("billing/webhook: payment.failed — empty order_id, skipping DB update")
		return
	}

	res, err := h.db.ExecContext(r.Context(),
		`UPDATE invoices
		    SET payment_status = 'failed'
		  WHERE razorpay_order_id = $1`,
		orderID,
	)
	if err != nil {
		log.Printf("billing/webhook: payment.failed DB error (order %s): %v", orderID, err)
		return
	}
	logRowsAffected("payment.failed", orderID, res)
}

// handleOrderPaid transitions the invoice status to 'paid' when the order is
// fully settled by Razorpay.
func (h *Handler) handleOrderPaid(r *http.Request, event razorpayEvent) {
	if event.Payload.Order == nil || event.Payload.Order.Entity == nil {
		log.Printf("billing/webhook: order.paid missing order entity")
		return
	}
	orderID := event.Payload.Order.Entity.ID

	if orderID == "" {
		log.Printf("billing/webhook: order.paid — empty order id, skipping DB update")
		return
	}

	res, err := h.db.ExecContext(r.Context(),
		`UPDATE invoices
		    SET status = 'paid'
		  WHERE razorpay_order_id = $1`,
		orderID,
	)
	if err != nil {
		log.Printf("billing/webhook: order.paid DB error (order %s): %v", orderID, err)
		return
	}
	logRowsAffected("order.paid", orderID, res)
}

func logRowsAffected(event, orderID string, res sql.Result) {
	n, err := res.RowsAffected()
	if err != nil {
		log.Printf("billing/webhook: %s — RowsAffected error: %v", event, err)
		return
	}
	if n == 0 {
		log.Printf("billing/webhook: %s — no invoice found for order_id %q", event, orderID)
		return
	}
	log.Printf("billing/webhook: %s — updated %d invoice row(s) for order_id %q", event, n, orderID)
}

