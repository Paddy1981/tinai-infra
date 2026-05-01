package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ---- helpers ----------------------------------------------------------------

func hmacSHA256(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

func newTestHandler(secret string, db *sql.DB) *Handler {
	return &Handler{db: db, secret: secret}
}

// ---- TestSignatureVerification ----------------------------------------------

func TestSignatureVerification(t *testing.T) {
	const secret = "test_webhook_secret"
	h := newTestHandler(secret, nil)

	body := []byte(`{"event":"payment.captured","payload":{}}`)
	validSig := hmacSHA256(secret, string(body))

	t.Run("valid signature passes", func(t *testing.T) {
		if !h.verifySignature(body, validSig) {
			t.Fatal("expected verifySignature to return true for a valid HMAC")
		}
	})

	t.Run("tampered body fails", func(t *testing.T) {
		tampered := []byte(`{"event":"order.paid","payload":{}}`)
		if h.verifySignature(tampered, validSig) {
			t.Fatal("expected verifySignature to return false for tampered body")
		}
	})

	t.Run("wrong secret fails", func(t *testing.T) {
		hWrong := newTestHandler("wrong_secret", nil)
		if hWrong.verifySignature(body, validSig) {
			t.Fatal("expected verifySignature to return false for wrong secret")
		}
	})

	t.Run("empty signature fails", func(t *testing.T) {
		if h.verifySignature(body, "") {
			t.Fatal("expected verifySignature to return false for empty signature")
		}
	})
}

// ---- mock sql.DB helpers ----------------------------------------------------

// mockResult implements sql.Result.
type mockResult struct{ rowsAffected int64 }

func (m mockResult) LastInsertId() (int64, error) { return 0, nil }
func (m mockResult) RowsAffected() (int64, error) { return m.rowsAffected, nil }

// mockDriver / mockConn / mockStmt implement the minimal driver.Driver interface
// needed so sql.Open can hand us a *sql.DB that we can intercept.

type mockDriver struct {
	capturedQuery string
	capturedArgs  []driver.Value
}

func (d *mockDriver) Open(_ string) (driver.Conn, error) {
	return &mockConn{driver: d}, nil
}

type mockConn struct{ driver *mockDriver }

func (c *mockConn) Prepare(query string) (driver.Stmt, error) {
	return &mockStmt{conn: c, query: query}, nil
}
func (c *mockConn) Close() error           { return nil }
func (c *mockConn) Begin() (driver.Tx, error) { return nil, nil }

type mockStmt struct {
	conn  *mockConn
	query string
}

func (s *mockStmt) Close() error                                    { return nil }
func (s *mockStmt) NumInput() int                                   { return -1 }
func (s *mockStmt) Exec(args []driver.Value) (driver.Result, error) {
	s.conn.driver.capturedQuery = s.query
	s.conn.driver.capturedArgs = args
	return mockResult{rowsAffected: 1}, nil
}
func (s *mockStmt) Query(_ []driver.Value) (driver.Rows, error) { return nil, nil }

// openMockDB registers a uniquely-named mock driver and returns both the *sql.DB
// and a pointer to the driver so the test can inspect what was executed.
func openMockDB(t *testing.T) (*sql.DB, *mockDriver) {
	t.Helper()
	d := &mockDriver{}
	name := "mock_" + t.Name()
	sql.Register(name, d)
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatalf("sql.Open mock: %v", err)
	}
	return db, d
}

// ---- TestPaymentCaptured ----------------------------------------------------

func TestPaymentCaptured(t *testing.T) {
	const secret = "webhook_secret"

	db, drv := openMockDB(t)
	h := newTestHandler(secret, db)

	payload := map[string]any{
		"event": "payment.captured",
		"payload": map[string]any{
			"payment": map[string]any{
				"entity": map[string]any{
					"id":       "pay_ABC123",
					"order_id": "order_XYZ789",
				},
			},
		},
	}
	bodyBytes, _ := json.Marshal(payload)
	sig := hmacSHA256(secret, string(bodyBytes))

	req := httptest.NewRequest(http.MethodPost, "/webhook/razorpay", strings.NewReader(string(bodyBytes)))
	req.Header.Set("X-Razorpay-Signature", sig)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	if drv.capturedQuery == "" {
		t.Fatal("expected a DB query to have been executed, but none was captured")
	}

	// Verify the UPDATE targeted the correct columns / values.
	if !strings.Contains(drv.capturedQuery, "payment_status") {
		t.Errorf("UPDATE query should reference payment_status; got: %s", drv.capturedQuery)
	}
	if !strings.Contains(drv.capturedQuery, "razorpay_payment_id") {
		t.Errorf("UPDATE query should reference razorpay_payment_id; got: %s", drv.capturedQuery)
	}
	if len(drv.capturedArgs) < 2 {
		t.Fatalf("expected at least 2 query args, got %d", len(drv.capturedArgs))
	}
	if drv.capturedArgs[0] != "pay_ABC123" {
		t.Errorf("arg[0] (payment_id) should be 'pay_ABC123', got %v", drv.capturedArgs[0])
	}
	if drv.capturedArgs[1] != "order_XYZ789" {
		t.Errorf("arg[1] (order_id) should be 'order_XYZ789', got %v", drv.capturedArgs[1])
	}
}

// ---- TestUnknownEventReturns200 ---------------------------------------------

func TestUnknownEventReturns200(t *testing.T) {
	const secret = "webhook_secret"
	h := newTestHandler(secret, nil)

	payload := map[string]any{
		"event":   "refund.created",
		"payload": map[string]any{},
	}
	bodyBytes, _ := json.Marshal(payload)
	sig := hmacSHA256(secret, string(bodyBytes))

	req := httptest.NewRequest(http.MethodPost, "/webhook/razorpay", strings.NewReader(string(bodyBytes)))
	req.Header.Set("X-Razorpay-Signature", sig)
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for unknown event, got %d", rr.Code)
	}
}
