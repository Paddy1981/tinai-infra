package runner

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestTruncateName(t *testing.T) {
	tests := []struct {
		in   string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 3, "hel"},
		{"", 5, ""},
		{strings.Repeat("a", 50), 46, strings.Repeat("a", 46)},
	}
	for _, tc := range tests {
		got := truncateName(tc.in, tc.max)
		if got != tc.want {
			t.Errorf("truncateName(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
		}
	}
}

func TestNamespace(t *testing.T) {
	tests := []struct {
		tenant string
		want   string
	}{
		{"acme-Corp", "tinai-fn-acme-corp"},
		{"Hello World", "tinai-fn-hello-world"},
	}
	for _, tc := range tests {
		got := namespace(tc.tenant)
		if got != tc.want {
			t.Errorf("namespace(%q) = %q, want %q", tc.tenant, got, tc.want)
		}
	}
}

func TestJobNameLength(t *testing.T) {
	// Simulate job name generation with a 60-char function name
	longName := strings.Repeat("x", 60)
	// Job name pattern: "fn-" + truncateName(name, maxFnNameInJobName) + "-" + <13-digit UnixMilli>
	truncated := truncateName(longName, maxFnNameInJobName)
	// Use a fixed 13-digit timestamp as in production
	jobName := fmt.Sprintf("fn-%s-%d", truncated, 1700000000000)
	if len(jobName) > 63 {
		t.Errorf("job name length %d exceeds 63 chars: %q", len(jobName), jobName)
	}
}

func TestInvokeFunction_NilClient(t *testing.T) {
	r := New(nil)
	ctx := context.Background()
	_, err := r.InvokeFunction(ctx, "tenant", "name", "code", "payload")
	if err == nil {
		t.Error("expected error when k8s client is nil, got nil")
	}
}

func TestClassifyFunction(t *testing.T) {
	tests := []struct{ code, want string }{
		{`fetch("https://api.example.com")`, "io"},
		{`for(let i=0;i<1e6;i++) Math.sqrt(i)`, "cpu"},
		{`console.log("hello world")`, "default"},
	}
	for _, tc := range tests {
		got := classifyFunction(tc.code)
		if got != tc.want {
			t.Errorf("classifyFunction(%q) = %q, want %q", tc.code, got, tc.want)
		}
	}
}
