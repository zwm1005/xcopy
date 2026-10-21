package main

import "log"

// A single writer preserves snapshot order. At most one newer snapshot waits
// behind a slow fsync; the engine never waits for disk from submit.
type historyWriter struct {
	pending chan []Record
	done    chan struct{}
}

func newHistoryWriter(write func([]Record) error) *historyWriter {
	h := &historyWriter{pending: make(chan []Record, 1), done: make(chan struct{})}
	go func() {
		defer close(h.done)
		for records := range h.pending {
			if err := write(records); err != nil {
				log.Printf("保存记录失败: %v", err)
			}
		}
	}()
	return h
}

// Only the engine loop submits snapshots and closes the writer.
func (h *historyWriter) submit(records []Record) {
	select {
	case <-h.pending:
	default:
	}
	h.pending <- records
}

func (h *historyWriter) close() {
	close(h.pending)
	<-h.done
}
