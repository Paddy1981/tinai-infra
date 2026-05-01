package webhook

// TODO: Register the PR handler in cmd/server/main.go by adding the following line
// after the existing push webhook route:
//
//	mux.Handle("/webhook/pr", webhook.NewPRHandler(cfg, b))
//
// The push webhook handler should remain on its existing path (e.g. "/webhook").
// Both handlers share the same WebhookSecret for HMAC validation.
