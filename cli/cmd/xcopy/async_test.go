package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type engineRequest struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
	send func(any)
}

func (r engineRequest) reply(data any) {
	r.send(map[string]any{"replyTo": r.ID, "ok": true, "data": data})
}

func asyncEngine(t *testing.T, holdSignals bool) (*Engine, <-chan engineRequest) {
	t.Helper()
	requests := make(chan engineRequest, 64)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var writeMu sync.Mutex
		send := func(data any) {
			writeMu.Lock()
			defer writeMu.Unlock()
			_ = ws.WriteJSON(data)
		}
		for {
			var request engineRequest
			if ws.ReadJSON(&request) != nil {
				return
			}
			request.send = send
			if request.Type != "transfer.start" && !(holdSignals && request.Type == "signal") {
				request.reply(map[string]any{})
			}
			requests <- request
		}
	}))
	ctx, cancel := context.WithCancel(context.Background())
	e, err := newEngine(ctx, Config{ReceiveDir: t.TempDir()}, Paths{Data: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e.wire, err = connect(ctx, server.URL, func(m message) {
		e.post(func() { e.event(m) })
	})
	if err != nil {
		t.Fatal(err)
	}
	client := e.wire
	finished := make(chan struct{})
	go func() {
		e.run()
		close(finished)
	}()
	t.Cleanup(func() {
		cancel()
		_ = client.ws.Close()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("engine shutdown blocked by a pending RPC")
		}
		server.Close()
	})
	return e, requests
}

func engineValue(t *testing.T, e *Engine, fn func() any) any {
	t.Helper()
	result := make(chan any, 1)
	e.post(func() { result <- fn() })
	select {
	case value := <-result:
		return value
	case <-time.After(time.Second):
		t.Fatal("engine commands blocked behind network I/O")
		return nil
	}
}

func enqueueFixture(t *testing.T, e *Engine, count int) {
	t.Helper()
	engineValue(t, e, func() any {
		for i := 0; i < count; i++ {
			e.tasks = append(e.tasks, &task{Record: Record{
				ID: newID(), PeerID: "peer", Status: "queued",
				Metadata: Metadata{Kind: "file", Name: "test.bin", Size: 1},
			}})
		}
		return nil
	})
}

func nextRequest(t *testing.T, requests <-chan engineRequest, kind string) engineRequest {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case request := <-requests:
			if request.Type == kind {
				return request
			}
		case <-timer.C:
			t.Fatalf("missing %s request", kind)
			return engineRequest{}
		}
	}
}

func awaitEngine(t *testing.T, e *Engine, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !engineValue(t, e, func() any { return condition() }).(bool) {
		if time.Now().After(deadline) {
			t.Fatal("engine state did not settle")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPendingCreationDoesNotBlockCancelAndRetiresLateRemoteTask(t *testing.T) {
	e, requests := asyncEngine(t, false)
	enqueueFixture(t, e, 1)
	start := nextRequest(t, requests, "transfer.start")
	status := engineValue(t, e, func() any {
		value, err := e.handle(Request{Op: "cancel", ID: e.tasks[0].ID})
		if err != nil {
			return err
		}
		return value.(Record).Status
	})
	if status != "cancelled" {
		t.Fatal("cancel failed while creation was waiting", status)
	}
	start.reply(map[string]any{"id": "late-task", "iceServers": []any{}})
	end := nextRequest(t, requests, "transfer.end")
	if end.Data["id"] != "late-task" || end.Data["status"] != "cancelled" {
		t.Fatal("late creation leaked its remote task", end.Data)
	}
	awaitEngine(t, e, func() bool { return e.pendingStarts == 0 })
	if engineValue(t, e, func() any { return e.tasks[0].pc != nil }).(bool) {
		t.Fatal("cancelled creation allocated a peer connection")
	}
}

func TestCreationPreservesEarlyAcceptanceAndSignalWaitDoesNotBlockCommands(t *testing.T) {
	e, requests := asyncEngine(t, true)
	enqueueFixture(t, e, 1)
	start := nextRequest(t, requests, "transfer.start")
	start.send(map[string]any{"type": "transfer.accepted", "data": map[string]any{"id": "early-task"}})
	awaitEngine(t, e, func() bool { return len(e.pendingEvents) == 1 })
	start.reply(map[string]any{"id": "early-task", "iceServers": []any{}})
	signal := nextRequest(t, requests, "signal")
	if signal.Data["id"] != "early-task" {
		t.Fatal("acceptance was not replayed", signal.Data)
	}
	state := engineValue(t, e, func() any {
		value, _ := e.handle(Request{Op: "cancel", ID: e.tasks[0].ID})
		return value.(Record).Status
	})
	if state != "cancelled" {
		t.Fatal("signal RPC blocked cancellation", state)
	}
	signal.reply(map[string]any{})
}

func TestCreationConcurrencyRemainsBoundedAcrossDisconnect(t *testing.T) {
	e, requests := asyncEngine(t, false)
	enqueueFixture(t, e, 5)
	starts := []engineRequest{}
	for i := 0; i < 3; i++ {
		starts = append(starts, nextRequest(t, requests, "transfer.start"))
	}
	if engineValue(t, e, func() any { return e.pendingStarts }).(int) != 3 {
		t.Fatal("creation slots were not reserved")
	}
	engineValue(t, e, func() any {
		e.wire = nil
		for _, item := range e.tasks {
			e.finish(item, "failed", "disconnected", false)
		}
		return nil
	})
	for i, start := range starts {
		start.reply(map[string]any{"id": string(rune('a' + i)), "iceServers": []any{}})
	}
	for range starts {
		nextRequest(t, requests, "transfer.end")
	}
	awaitEngine(t, e, func() bool { return e.pendingStarts == 0 })
	engineValue(t, e, func() any {
		for _, item := range e.tasks {
			if item.pc != nil || item.Status != "failed" {
				t.Error("stale creation revived a disconnected task")
			}
		}
		return nil
	})
}

func TestEvictedCancelledCreationStillReservesConcurrencySlot(t *testing.T) {
	e, requests := asyncEngine(t, false)
	enqueueFixture(t, e, 3)
	for i := 0; i < 3; i++ {
		nextRequest(t, requests, "transfer.start")
	}
	engineValue(t, e, func() any {
		cancelled := e.tasks[0]
		e.finish(cancelled, "cancelled", "", false)
		for i := 0; i < 300; i++ {
			e.tasks = append(e.tasks, &task{Record: Record{ID: newID(), Status: "completed"}})
		}
		e.persist()
		if e.byID(cancelled.ID) != nil {
			t.Error("cancelled fixture was not evicted from history")
		}
		return nil
	})
	enqueueFixture(t, e, 1)
	if engineValue(t, e, func() any { return e.pendingStarts }).(int) != 3 {
		t.Fatal("history eviction released a pending RPC's concurrency slot")
	}
	select {
	case request := <-requests:
		t.Fatal("creation exceeded concurrency limit", request.Type)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestCancellationStopsCreationRateBackoffWithoutBlockingEngine(t *testing.T) {
	e, requests := asyncEngine(t, false)
	enqueueFixture(t, e, 1)
	start := nextRequest(t, requests, "transfer.start")
	start.send(map[string]any{"replyTo": start.ID, "ok": false, "error": map[string]any{"code": "RATE_LIMIT", "retryAfterMs": 10000}})
	engineValue(t, e, func() any {
		e.finish(e.tasks[0], "cancelled", "", false)
		return nil
	})
	awaitEngine(t, e, func() bool { return e.pendingStarts == 0 })
	select {
	case request := <-requests:
		t.Fatal("cancelled creation retried", request.Type)
	case <-time.After(50 * time.Millisecond):
	}
}
