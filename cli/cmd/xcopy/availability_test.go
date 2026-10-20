package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTaskCreationRateRetry(t *testing.T) {
	for _, tc := range []struct {
		name     string
		kind     string
		code     string
		retry    int64
		attempts int32
	}{
		{"creation recovers", "transfer.start", "RATE_LIMIT", 1, 3},
		{"rename is not replayed", "device.rename", "RATE_LIMIT", 1, 1},
		{"end is not replayed", "transfer.end", "RATE_LIMIT", 1, 1},
		{"authorization failure", "transfer.start", "NOT_PAIRED", 1, 1},
		{"long wait is bounded", "transfer.start", "RATE_LIMIT", 60001, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var attempts atomic.Int32
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				for {
					var req struct {
						ID string `json:"id"`
					}
					if ws.ReadJSON(&req) != nil {
						return
					}
					n := attempts.Add(1)
					reply := map[string]any{"replyTo": req.ID, "ok": n >= 3, "data": map[string]any{"id": "created"}}
					if n < 3 {
						reply["error"] = map[string]any{"code": tc.code, "message": "limited", "retryAfterMs": tc.retry}
					}
					if ws.WriteJSON(reply) != nil {
						return
					}
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			wire, err := connect(ctx, server.URL, func(message) {})
			if err != nil {
				t.Fatal(err)
			}
			defer wire.ws.Close()
			var result map[string]any
			err = wire.call(tc.kind, map[string]any{}, &result)
			if attempts.Load() != tc.attempts {
				t.Fatalf("attempts: got %d, want %d", attempts.Load(), tc.attempts)
			}
			if tc.attempts == 3 && (err != nil || result["id"] != "created") {
				t.Fatal("creation did not recover", result, err)
			}
			if tc.attempts == 1 && err == nil {
				t.Fatal("non-retryable failure was ignored")
			}
		})
	}
}

func TestRateWaitEndsWhenConnectionCloses(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var req map[string]json.RawMessage
		if ws.ReadJSON(&req) != nil {
			return
		}
		_ = ws.WriteJSON(map[string]any{"replyTo": req["id"], "ok": false, "error": map[string]any{"code": "RATE_LIMIT", "message": "limited", "retryAfterMs": 10000}})
	}))
	defer server.Close()
	wire, err := connect(context.Background(), server.URL, func(message) {})
	if err != nil {
		t.Fatal(err)
	}
	defer wire.ws.Close()
	start := time.Now()
	if err := wire.call("transfer.start", map[string]any{}, nil); err == nil {
		t.Fatal("closed connection was ignored")
	}
	if time.Since(start) > time.Second {
		t.Fatal("backoff did not stop on disconnect")
	}
}
