package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func diskEngine(t *testing.T, history func([]Record) error) (*Engine, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	e, err := newEngine(ctx, Config{ReceiveDir: t.TempDir()}, Paths{Data: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if history != nil {
		e.history = newHistoryWriter(history)
	}
	done := make(chan struct{})
	go func() { e.run(); close(done) }()
	t.Cleanup(func() {
		cancel()
		waitDisk(t, done)
	})
	return e, cancel, done
}

func waitDisk(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("disk worker did not finish")
	}
}

func receiveFixture(t *testing.T, e *Engine, payload []byte, kind string, open func() (*receiver, error)) (*task, *receiveQueue) {
	t.Helper()
	item := engineValue(t, e, func() any {
		item := &task{Record: Record{ID: newID(), Incoming: true, Status: "transferring", Created: time.Now(), Metadata: Metadata{Kind: kind, Name: "received.bin", Size: int64(len(payload))}}}
		item.activity.Store(time.Now().UnixNano())
		e.tasks = append(e.tasks, item)
		if open == nil {
			open = func() (*receiver, error) { return newReceiver(e.root, int64(len(payload)), e.partialPrefix) }
		}
		if err := e.startReceiver(item, open, func() {}); err != nil {
			return err
		}
		return item
	})
	if err, ok := item.(error); ok {
		t.Fatal(err)
	}
	next := item.(*task)
	q := engineValue(t, e, func() any { return next.receive }).(*receiveQueue)
	return next, q
}

func sendReceive(q *receiveQueue, payload []byte, digest string, ack func()) {
	for len(payload) > 0 {
		n := min(16*1024, len(payload))
		q.message(webrtc.DataChannelMessage{Data: payload[:n]}, nil)
		payload = payload[n:]
	}
	data, _ := json.Marshal(map[string]string{"type": "end", "hash": digest})
	q.message(webrtc.DataChannelMessage{IsString: true, Data: data}, ack)
}

func payloadHash(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

type gatedFile struct {
	*os.File
	writeGate func()
	syncGate  func()
}

func (f *gatedFile) Write(data []byte) (int, error) {
	if f.writeGate != nil {
		f.writeGate()
	}
	return f.File.Write(data)
}

func (f *gatedFile) Sync() error {
	if f.syncGate != nil {
		f.syncGate()
	}
	return f.File.Sync()
}

func TestSlowReceiveKeepsControlsAndOtherTransfersResponsive(t *testing.T) {
	for _, stage := range []string{"open", "write", "sync"} {
		t.Run(stage, func(t *testing.T) {
			e, _, _ := diskEngine(t, nil)
			entered, release := make(chan struct{}), make(chan struct{})
			var unblock sync.Once
			t.Cleanup(func() { unblock.Do(func() { close(release) }) })
			gate := func() { close(entered); <-release }
			payload := []byte("slow disk")
			item, q := receiveFixture(t, e, payload, "file", func() (*receiver, error) {
				if stage == "open" {
					gate()
				}
				r, err := newReceiver(e.root, int64(len(payload)), e.partialPrefix)
				if err == nil {
					file := &gatedFile{File: r.file.(*os.File)}
					if stage == "write" {
						file.writeGate = gate
					}
					if stage == "sync" {
						file.syncGate = gate
					}
					r.file = file
				}
				return r, err
			})
			var ack atomic.Int32
			sendReceive(q, payload, payloadHash(payload), func() { ack.Add(1) })
			waitDisk(t, entered)
			controlErr := engineValue(t, e, func() any {
				for _, op := range []string{"status", "devices", "transfers"} {
					if _, err := e.handle(Request{Op: op}); err != nil {
						return err
					}
				}
				return nil
			})
			if controlErr != nil {
				t.Fatal(controlErr)
			}
			other, otherQueue := receiveFixture(t, e, []byte("fast"), "file", nil)
			sendReceive(otherQueue, []byte("fast"), payloadHash([]byte("fast")), nil)
			waitDisk(t, otherQueue.done)
			if status := engineValue(t, e, func() any { return other.Status }); status != "completed" {
				t.Fatal("independent transfer stalled", status)
			}
			result := engineValue(t, e, func() any {
				value, err := e.handle(Request{Op: "cancel", ID: item.ID})
				if err != nil {
					return err
				}
				return value
			})
			if result.(Record).Status != "cancelled" || e.receivers.Load() != 1 {
				t.Fatal("cancel must respond while the blocked worker retains its slot", result)
			}
			unblock.Do(func() { close(release) })
			waitDisk(t, q.done)
			if ack.Load() != 0 {
				t.Fatal("cancelled receipt was acknowledged")
			}
			entries, err := os.ReadDir(e.config.ReceiveDir)
			if err != nil || len(entries) != 1 || entries[0].Name() != "received.bin" {
				t.Fatal("cancelled receive leaked a partial or committed file", entries, err)
			}
		})
	}
}

func TestReceiveBackpressureIsBoundedAndCancelReleasesProducer(t *testing.T) {
	e, _, _ := diskEngine(t, nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	item, q := receiveFixture(t, e, make([]byte, 1024*1024), "file", func() (*receiver, error) {
		r, err := newReceiver(e.root, 1024*1024, e.partialPrefix)
		if err == nil {
			r.file = &gatedFile{File: r.file.(*os.File), writeGate: func() { close(entered); <-release }}
		}
		return r, err
	})
	chunk := webrtc.DataChannelMessage{Data: make([]byte, 16*1024)}
	q.message(chunk, nil)
	waitDisk(t, entered)
	for i := 0; i < receiveQueueSize; i++ {
		q.message(chunk, nil)
	}
	blocked := make(chan struct{})
	var enqueued atomic.Bool
	go func() { enqueued.Store(q.message(chunk, nil)); close(blocked) }()
	select {
	case <-blocked:
		t.Fatal("full receive queue failed to apply backpressure")
	case <-time.After(50 * time.Millisecond):
	}
	engineValue(t, e, func() any { e.finish(item, "cancelled", "", false); return nil })
	waitDisk(t, blocked)
	if enqueued.Load() {
		t.Fatal("cancelled queue accepted another chunk")
	}
	unblock.Do(func() { close(release) })
	waitDisk(t, q.done)
}

func TestReceiveWorkerLimitIncludesCancelledDiskOperations(t *testing.T) {
	e, _, _ := diskEngine(t, nil)
	entered, release := make(chan struct{}, maxReceivers), make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	queues := []*receiveQueue{}
	for i := 0; i < maxReceivers; i++ {
		_, q := receiveFixture(t, e, nil, "file", func() (*receiver, error) {
			entered <- struct{}{}
			<-release
			return newReceiver(e.root, 0, e.partialPrefix)
		})
		queues = append(queues, q)
	}
	for i := 0; i < maxReceivers; i++ {
		waitDisk(t, entered)
	}
	err := engineValue(t, e, func() any {
		for _, item := range e.tasks {
			e.finish(item, "cancelled", "", false)
		}
		return e.startReceiver(&task{}, func() (*receiver, error) {
			return nil, fmt.Errorf("overflow worker must never start")
		}, func() {})
	})
	if err == nil {
		t.Fatal("cancellation bypassed the outstanding disk worker limit")
	}
	unblock.Do(func() { close(release) })
	for _, q := range queues {
		waitDisk(t, q.done)
	}
	if e.receivers.Load() != 0 {
		t.Fatal("completed cleanup failed to release receiver slots")
	}
}

func TestReceiveRejectsMalformedInputAndDiskErrors(t *testing.T) {
	for _, tc := range []struct {
		name       string
		message    webrtc.DataChannelMessage
		closedFile bool
	}{
		{"oversized block", webrtc.DataChannelMessage{Data: make([]byte, 16*1024+1)}, false},
		{"oversized control", webrtc.DataChannelMessage{Data: make([]byte, 1025), IsString: true}, false},
		{"malformed control", webrtc.DataChannelMessage{Data: []byte("{"), IsString: true}, false},
		{"overrun", webrtc.DataChannelMessage{Data: []byte("too long")}, false},
		{"write error", webrtc.DataChannelMessage{Data: []byte("a")}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, _, _ := diskEngine(t, nil)
			item, q := receiveFixture(t, e, []byte("a"), "file", func() (*receiver, error) {
				r, err := newReceiver(e.root, 1, e.partialPrefix)
				if err == nil && tc.closedFile {
					_ = r.file.Close()
				}
				return r, err
			})
			q.message(tc.message, nil)
			waitDisk(t, q.done)
			awaitEngine(t, e, func() bool { return item.Status == "failed" })
			entries, err := os.ReadDir(e.config.ReceiveDir)
			if err != nil || len(entries) != 0 {
				t.Fatal("failed receipt leaked a file", entries, err)
			}
		})
	}
}

func TestReceiveOrderValidationAndCloseAfterEnd(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		payload    []byte
		badHash    bool
		status     string
	}{
		{"file", "file", bytes.Repeat([]byte{0, 255, 42}, 400000), false, "completed"},
		{"empty", "file", nil, false, "completed"},
		{"text", "text", []byte("  中文 🍓\n"), false, "completed"},
		{"corrupt", "file", []byte("corrupt"), true, "failed"},
		{"invalid UTF-8", "text", []byte{0xff}, false, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, _, _ := diskEngine(t, nil)
			item, q := receiveFixture(t, e, tc.payload, tc.kind, nil)
			digest := payloadHash(tc.payload)
			if tc.badHash {
				digest = "invalid"
			}
			var ack atomic.Int32
			sendReceive(q, tc.payload, digest, func() { ack.Add(1) })
			q.push(receiveEvent{err: fmt.Errorf("channel closed immediately after end")})
			waitDisk(t, q.done)
			awaitEngine(t, e, func() bool { return item.Status == tc.status })
			r := engineValue(t, e, func() any { return snapshot(item) }).(Record)
			entries, _ := os.ReadDir(e.config.ReceiveDir)
			if tc.status == "completed" {
				data, err := os.ReadFile(r.Path)
				if err != nil || !bytes.Equal(data, tc.payload) || r.Hash != digest || ack.Load() != 1 || len(entries) != 1 {
					t.Fatal("receipt lost data, ordering, or acknowledgement", r, err)
				}
			} else if len(entries) != 0 || ack.Load() != 0 {
				t.Fatal("invalid receipt published a file or ACK")
			}
		})
	}
}

func TestHistorySlowSyncCoalescesAndFlushesFinalSnapshotOnShutdown(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var writes []string
	e, cancel, done := diskEngine(t, func(records []Record) error {
		if len(writes) == 0 {
			close(entered)
			<-release
		}
		writes = append(writes, records[0].Status)
		return nil
	})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	engineValue(t, e, func() any {
		e.tasks = append(e.tasks, &task{Record: Record{ID: newID(), Status: "queued"}})
		e.persist()
		return nil
	})
	waitDisk(t, entered)
	engineValue(t, e, func() any {
		for i := 0; i < 1000; i++ {
			e.tasks[0].Status = "transferring"
			e.tasks[0].activity.Store(time.Now().UnixNano())
			e.persist()
		}
		return nil
	})
	cancel()
	unblock.Do(func() { close(release) })
	waitDisk(t, done)
	if writes[0] != "queued" || writes[len(writes)-1] != "failed" || len(writes) > 3 {
		t.Fatal("history lost ordering, coalescing, or the final shutdown state", writes)
	}
}

func TestShutdownWaitsForReceiveCleanupBeforeClosingRoot(t *testing.T) {
	e, cancel, done := diskEngine(t, nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	_, q := receiveFixture(t, e, []byte("pending"), "file", func() (*receiver, error) {
		close(entered)
		<-release
		return newReceiver(e.root, 7, e.partialPrefix)
	})
	waitDisk(t, entered)
	cancel()
	unblock.Do(func() { close(release) })
	waitDisk(t, done)
	waitDisk(t, q.done)
	entries, err := os.ReadDir(e.config.ReceiveDir)
	if err != nil || len(entries) != 0 {
		t.Fatal("shutdown left a partial file", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(e.paths.Data, "history.json"))
	var records []Record
	if err != nil || json.Unmarshal(data, &records) != nil || len(records) != 1 || records[0].Status != "failed" {
		t.Fatal("shutdown did not persist the final history", string(data), err)
	}
}
