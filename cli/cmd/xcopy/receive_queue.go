package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const receiveQueueSize = 32
const maxReceivers = 32

type receiveEvent struct {
	data []byte
	text bool
	ack  func()
	err  error
}

type receiveQueue struct {
	ctx     context.Context
	pending chan receiveEvent
	done    chan struct{}
}

func (q *receiveQueue) push(event receiveEvent) bool {
	if q.ctx.Err() != nil {
		return false
	}
	select {
	case q.pending <- event:
		return true
	case <-q.ctx.Done():
		return false
	case <-q.done:
		return false
	}
}

func (q *receiveQueue) message(msg webrtc.DataChannelMessage, ack func()) bool {
	if (msg.IsString && len(msg.Data) > 1024) || (!msg.IsString && len(msg.Data) > 16*1024) {
		return q.push(receiveEvent{err: fmt.Errorf("数据通道消息过大")})
	}
	return q.push(receiveEvent{data: append([]byte(nil), msg.Data...), text: msg.IsString, ack: ack})
}

// The worker owns its file through creation, writes, commit, and cleanup.
// Cancelled workers retain a slot until their outstanding disk I/O returns.
func (e *Engine) startReceiver(t *task, open func() (*receiver, error), ready func()) error {
	if e.receivers.Load() >= maxReceivers {
		return fmt.Errorf("本地接收队列已满，最多 32 项")
	}
	if t.ctx == nil {
		t.ctx, t.cancel = context.WithCancel(e.ctx)
	}
	q := &receiveQueue{ctx: t.ctx, pending: make(chan receiveEvent, receiveQueueSize), done: make(chan struct{})}
	t.receive = q
	e.receivers.Add(1)
	e.diskWorkers.Add(1)
	go func() {
		defer close(q.done)
		defer e.diskWorkers.Done()
		defer e.receivers.Add(-1)
		err := e.receiveBytes(t, q, open, ready)
		if err != nil && q.ctx.Err() == nil {
			e.post(func() { e.finish(t, "failed", err.Error(), true) })
		}
	}()
	return nil
}

func (e *Engine) receiveBytes(t *task, q *receiveQueue, open func() (*receiver, error), ready func()) error {
	if q.ctx.Err() != nil {
		return q.ctx.Err()
	}
	r, err := open()
	if err != nil {
		return err
	}
	var accepted atomic.Bool
	defer func() {
		// A cancelled commit must not leave an untracked published file behind.
		r.committed = accepted.Load()
		r.abort()
	}()
	if !e.post(func() {
		if !terminal(t.Status) && q.ctx.Err() == nil {
			ready()
		}
	}) {
		return q.ctx.Err()
	}
	for {
		var event receiveEvent
		select {
		case <-q.ctx.Done():
			return q.ctx.Err()
		case event = <-q.pending:
		}
		if q.ctx.Err() != nil {
			return q.ctx.Err()
		}
		if event.err != nil {
			return event.err
		}
		t.activity.Store(time.Now().UnixNano())
		if !event.text {
			if err := r.write(event.data); err != nil {
				return err
			}
			if q.ctx.Err() != nil {
				return q.ctx.Err()
			}
			t.bytes.Add(int64(len(event.data)))
			continue
		}
		var control struct {
			Type string `json:"type"`
			Hash string `json:"hash"`
		}
		if json.Unmarshal(event.data, &control) != nil {
			return fmt.Errorf("无效的控制消息")
		}
		switch control.Type {
		case "cancel":
			e.post(func() { e.finish(t, "cancelled", "对方取消了传输", true) })
			return nil
		case "ack":
			continue
		case "end":
			name := t.Metadata.Name
			if t.Metadata.Kind == "text" {
				name = "text-" + t.Created.Format("20060102-150405") + "-" + t.ID[:8] + ".txt"
			}
			saved, err := r.commit(name, control.Hash, t.Metadata.Kind == "text")
			if err != nil {
				return err
			}
			if !e.post(func() {
				if terminal(t.Status) || q.ctx.Err() != nil {
					return
				}
				t.Path = filepath.Join(e.config.ReceiveDir, saved)
				t.Hash = control.Hash
				accepted.Store(true)
				e.finish(t, "completed", "", true)
			}) {
				return q.ctx.Err()
			}
			// finish cancels the task context after deciding its final state. This
			// also releases the worker if shutdown overtakes the posted result.
			<-q.ctx.Done()
			if accepted.Load() && event.ack != nil {
				// Only acknowledge durable, verified receipt. ACK failure cannot
				// undo local completion or skip history/server cleanup.
				event.ack()
			}
			return nil
		default:
			return fmt.Errorf("未知的数据通道消息")
		}
	}
}
