package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

type Metadata struct {
	Kind string `json:"kind"`
	Size int64  `json:"size"`
	Name string `json:"name"`
	Mime string `json:"mime"`
}
type Record struct {
	ID       string    `json:"id"`
	WireID   string    `json:"wireId,omitempty"`
	PeerID   string    `json:"peerId"`
	PeerName string    `json:"peerName"`
	Incoming bool      `json:"incoming"`
	Metadata Metadata  `json:"metadata"`
	Status   string    `json:"status"`
	Bytes    int64     `json:"bytes"`
	Path     string    `json:"path,omitempty"`
	Source   string    `json:"source,omitempty"`
	Error    string    `json:"error,omitempty"`
	Hash     string    `json:"sha256,omitempty"`
	Route    string    `json:"route,omitempty"`
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"`
}
type task struct {
	Record
	pc                   *webrtc.PeerConnection
	dc                   *webrtc.DataChannel
	candidates           []webrtc.ICECandidateInit
	started              bool
	creating             bool
	signals              chan any
	descriptionPublished bool
	bytes                atomic.Int64
	sent                 atomic.Bool
	activity             atomic.Int64
	cancel               context.CancelFunc
	ctx                  context.Context
	receive              *receiveQueue
}

func terminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

type Engine struct {
	config        Config
	paths         Paths
	ctx           context.Context
	jobs          chan func()
	wire          *wire
	auth          Auth
	lastError     string
	tasks         []*task
	requests      map[string]json.RawMessage
	results       map[string]json.RawMessage
	root          *os.Root
	partialPrefix string
	pendingStarts int
	pendingEvents []message
	receivers     atomic.Int32
	diskWorkers   sync.WaitGroup
	history       *historyWriter
}

func newEngine(ctx context.Context, c Config, p Paths) (*Engine, error) {
	root, err := os.OpenRoot(c.ReceiveDir)
	if err != nil {
		return nil, err
	}
	e := &Engine{config: c, paths: p, ctx: ctx, jobs: make(chan func(), 128), requests: map[string]json.RawMessage{}, results: map[string]json.RawMessage{}, root: root}
	digest := sha256.Sum256([]byte(p.Config))
	e.partialPrefix = ".xcopy-" + hex.EncodeToString(digest[:8]) + "-"
	data, err := os.ReadFile(filepath.Join(p.Data, "history.json"))
	if err == nil {
		var records []Record
		if err := json.Unmarshal(data, &records); err != nil {
			root.Close()
			return nil, fmt.Errorf("传输记录损坏: %w", err)
		}
		for i := len(records) - 1; i >= 0; i-- {
			r := records[i]
			if !terminal(r.Status) {
				r.Status = "failed"
				r.Error = "后台进程重启，需重新发送"
			}
			t := &task{Record: r}
			t.bytes.Store(r.Bytes)
			e.tasks = append(e.tasks, t)
		}
	} else if !os.IsNotExist(err) {
		root.Close()
		return nil, err
	}
	// Only remove partial files owned by this client's receive protocol.
	dir, err := root.Open(".")
	if err != nil {
		root.Close()
		return nil, err
	}
	entries, _ := dir.ReadDir(-1)
	_ = dir.Close()
	for _, f := range entries {
		if strings.HasPrefix(f.Name(), e.partialPrefix) && strings.HasSuffix(f.Name(), ".part") && len(f.Name()) == len(e.partialPrefix)+37 {
			_ = root.Remove(f.Name())
		}
	}
	return e, nil
}

func (e *Engine) post(fn func()) bool {
	select {
	case e.jobs <- fn:
		return true
	case <-e.ctx.Done():
		return false
	}
}

func (e *Engine) run() {
	defer e.root.Close()
	defer func() {
		e.diskWorkers.Wait()
		if e.history != nil {
			e.history.close()
		}
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case fn := <-e.jobs:
			fn()
			e.pump()
		case <-ticker.C:
			for _, t := range e.tasks {
				if !terminal(t.Status) && t.Status != "queued" {
					if time.Since(time.Unix(0, t.activity.Load())) > 75*time.Second {
						e.finish(t, "failed", "传输超时，请重新发送", true)
					} else {
						w, id := e.wire, t.WireID
						if w != nil && id != "" {
							go w.call("transfer.progress", map[string]any{"id": id}, nil)
						}
					}
				}
			}
			e.pump()
		case <-e.ctx.Done():
			for _, t := range e.tasks {
				if !terminal(t.Status) {
					e.finish(t, "failed", "后台进程停止，需重新发送", true)
				}
			}
			if e.wire != nil {
				e.wire.ws.Close()
			}
			return
		}
	}
}

func (e *Engine) network() {
	key, err := identity(e.paths)
	if err != nil {
		e.post(func() { e.lastError = err.Error() })
		return
	}
	delay := time.Second
	for e.ctx.Err() == nil {
		var w *wire
		w, err = connect(e.ctx, e.config.Server, func(m message) {
			e.post(func() {
				if e.wire == w {
					e.event(m)
				}
			})
		})
		if err == nil {
			var a Auth
			a, err = authenticate(w, key, e.config.Name)
			if err == nil {
				e.post(func() { e.wire = w; e.auth = a; e.lastError = ""; e.pump() })
				delay = time.Second
				select {
				case <-e.ctx.Done():
					w.ws.Close()
					return
				case <-w.done:
				}
				e.post(func() {
					if e.wire == w {
						e.wire = nil
						e.lastError = "连接中断，正在重连"
						e.requests = map[string]json.RawMessage{}
						e.pendingEvents = nil
						for _, t := range e.tasks {
							if !terminal(t.Status) {
								e.finish(t, "failed", "连接中断，请重新发送", false)
							}
						}
					}
				})
			} else {
				w.ws.Close()
			}
		}
		if err != nil {
			reason := err.Error()
			e.post(func() { e.lastError = reason })
		}
		select {
		case <-e.ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 8*time.Second {
			delay *= 2
		}
	}
}

func (e *Engine) event(m message) {
	// The peer can accept before the asynchronous creation result gets its turn
	// on the engine loop. Hold these events until the task has its wire ID/PC.
	if e.pendingStarts > 0 && (m.Type == "transfer.accepted" || m.Type == "signal" || m.Type == "transfer.state") {
		var data struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(m.Data, &data) == nil && data.ID != "" && e.byWire(data.ID) == nil {
			if len(e.pendingEvents) >= 256 {
				_ = e.wire.ws.Close()
				return
			}
			e.pendingEvents = append(e.pendingEvents, m)
			return
		}
	}
	switch m.Type {
	case "peers":
		var data struct {
			Peers []Peer `json:"peers"`
		}
		if json.Unmarshal(m.Data, &data) == nil {
			e.auth.Peers = data.Peers
		}
	case "pair.request", "pair.result":
		var data struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(m.Data, &data) == nil {
			if m.Type == "pair.request" {
				e.requests[data.ID] = m.Data
			} else {
				delete(e.requests, data.ID)
				if len(e.results) >= 100 {
					e.results = map[string]json.RawMessage{}
				}
				e.results[data.ID] = m.Data
			}
		}
	case "transfer.offer":
		e.offer(m.Data)
	case "transfer.accepted":
		var data struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(m.Data, &data)
		t := e.byWire(data.ID)
		if t != nil && !t.Incoming && !terminal(t.Status) && !t.started {
			t.started = true
			dc, err := t.pc.CreateDataChannel("suichuan", nil)
			if err == nil {
				e.bindChannel(t, dc)
				var sdp webrtc.SessionDescription
				sdp, err = t.pc.CreateOffer(&webrtc.OfferOptions{OfferAnswerOptions: webrtc.OfferAnswerOptions{ICETricklingSupported: true}})
				if err == nil {
					err = e.publishDescription(t, sdp)
				}
			}
			if err != nil {
				e.finish(t, "failed", err.Error(), true)
			}
		}
	case "signal":
		e.remoteSignal(m.Data)
	case "transfer.state":
		var data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(m.Data, &data) == nil {
			t := e.byWire(data.ID)
			if t != nil && terminal(data.Status) {
				// A receiver only acknowledges after its own local validation and commit.
				if data.Status != "completed" || !t.Incoming {
					e.finish(t, data.Status, data.Reason, false)
				}
			}
		}
	}
}

func (e *Engine) byWire(id string) *task {
	for _, t := range e.tasks {
		if t.WireID == id {
			return t
		}
	}
	return nil
}
func (e *Engine) byID(id string) *task {
	for _, t := range e.tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}
func snapshot(t *task) Record { r := t.Record; r.Bytes = t.bytes.Load(); return r }
func (e *Engine) records(incoming bool) []Record {
	out := []Record{}
	for i := len(e.tasks) - 1; i >= 0; i-- {
		t := e.tasks[i]
		if !incoming || t.Incoming {
			out = append(out, snapshot(t))
		}
	}
	return out
}
func (e *Engine) persist() {
	for len(e.tasks) > 300 {
		found := false
		for i, t := range e.tasks {
			if terminal(t.Status) {
				e.removeSpool(t)
				e.tasks = append(e.tasks[:i], e.tasks[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			break
		}
	}
	if e.history == nil {
		path := filepath.Join(e.paths.Data, "history.json")
		e.history = newHistoryWriter(func(records []Record) error { return atomicJSON(path, records) })
	}
	e.history.submit(e.records(false))
}

func (e *Engine) peer(value string) (Peer, error) {
	matches := []Peer{}
	for _, p := range e.auth.Peers {
		if p.ID == value {
			return p, nil
		}
		if p.Name == value {
			matches = append(matches, p)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return Peer{}, fmt.Errorf("设备重名，请使用完整设备 ID")
	}
	return Peer{}, fmt.Errorf("未找到配对设备 %q，请先配对", value)
}

func (e *Engine) enqueue(peer, source, text string, isText bool) (*task, error) {
	if e.wire == nil {
		return nil, fmt.Errorf("后台暂未连接服务器")
	}
	p, err := e.peer(peer)
	if err != nil {
		return nil, err
	}
	if !p.Online {
		return nil, fmt.Errorf("设备 %s 当前离线", p.Name)
	}
	active := 0
	for _, t := range e.tasks {
		if !terminal(t.Status) {
			active++
		}
	}
	if active >= 32 {
		return nil, fmt.Errorf("本地队列已满，最多 32 项")
	}
	id := newID()
	m := Metadata{Kind: "file", Mime: "application/octet-stream"}
	if isText {
		if len(text) > maxText {
			return nil, fmt.Errorf("文字上限 1 MiB")
		}
		dir := filepath.Join(e.paths.Data, "outbox")
		if err := privateDir(dir); err != nil {
			return nil, err
		}
		source = filepath.Join(dir, id+".txt")
		if err := os.WriteFile(source, []byte(text), 0600); err != nil {
			return nil, err
		}
		m = Metadata{Kind: "text", Mime: "text/plain", Name: "文字", Size: int64(len(text))}
	} else {
		source, err = filepath.Abs(source)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(source)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("只能发送普通文件")
		}
		if info.Size() > maxFile {
			return nil, fmt.Errorf("文件上限 50 MiB")
		}
		m.Name = safeName(info.Name())
		m.Size = info.Size()
	}
	if (m.Kind == "text" && m.Size > e.auth.Config.MaxTextBytes) || (m.Kind != "text" && m.Size > e.auth.Config.MaxFileBytes) {
		return nil, fmt.Errorf("内容超过服务器大小限制")
	}
	t := &task{Record: Record{ID: id, PeerID: p.ID, PeerName: p.Name, Metadata: m, Source: source, Status: "queued", Created: time.Now(), Updated: time.Now()}}
	e.tasks = append(e.tasks, t)
	e.persist()
	e.pump()
	return t, nil
}

func (e *Engine) pump() {
	if e.wire == nil || e.ctx.Err() != nil {
		return
	}
	// A cancelled creation may already be evicted from history, but its RPC
	// still occupies a slot until the response can retire the remote task.
	count := e.pendingStarts
	for _, t := range e.tasks {
		if !t.creating && !t.Incoming && t.Status != "queued" && !terminal(t.Status) {
			count++
		}
	}
	for _, t := range e.tasks {
		if count >= 3 {
			return
		}
		if t.Status != "queued" {
			continue
		}
		count++
		t.Status = "connecting"
		t.creating = true
		t.activity.Store(time.Now().UnixNano())
		t.ctx, t.cancel = context.WithCancel(e.ctx)
		e.pendingStarts++
		e.startTask(t)
	}
}

func (e *Engine) startTask(t *task) {
	w, ctx := e.wire, t.ctx
	data := map[string]any{"peerId": t.PeerID, "metadata": t.Metadata}
	go func() {
		var started struct {
			ID         string             `json:"id"`
			ICEServers []webrtc.ICEServer `json:"iceServers"`
			ForceRelay bool               `json:"forceRelay"`
		}
		err := w.callRetrying(ctx, "transfer.start", data, &started)
		e.post(func() {
			t.creating = false
			e.pendingStarts--
			if err == nil && started.ID == "" {
				err = fmt.Errorf("服务器返回的传输 ID 无效")
			}
			if terminal(t.Status) || e.wire != w || e.ctx.Err() != nil {
				if err == nil {
					go w.call("transfer.end", map[string]any{"id": started.ID, "status": "cancelled"}, nil)
				}
			} else {
				if err == nil {
					t.WireID = started.ID
					err = e.makePC(t, started.ICEServers, started.ForceRelay)
				}
				if err != nil {
					e.finish(t, "failed", err.Error(), true)
				}
			}
			pending := e.pendingEvents
			e.pendingEvents = nil
			for _, event := range pending {
				var data struct {
					ID string `json:"id"`
				}
				_ = json.Unmarshal(event.Data, &data)
				if data.ID == started.ID {
					if !terminal(t.Status) && e.wire == w {
						e.event(event)
					}
				} else if e.pendingStarts > 0 {
					e.pendingEvents = append(e.pendingEvents, event)
				}
			}
		})
	}()
}

func (e *Engine) finish(t *task, status, reason string, notify bool) {
	if terminal(t.Status) {
		return
	}
	if status == "completed" && !t.Incoming && !t.sent.Load() {
		status = "failed"
		reason = "对方在发送结束前确认，未认定为送达"
		notify = true
	}
	t.Status = status
	t.Error = reason
	t.Updated = time.Now()
	if t.cancel != nil {
		t.cancel()
	}
	t.receive = nil
	if t.pc != nil {
		pc := t.pc
		t.pc = nil
		t.dc = nil
		time.AfterFunc(1500*time.Millisecond, func() { _ = pc.Close() })
	}
	if status == "completed" {
		e.removeSpool(t)
	}
	if notify && e.wire != nil && t.WireID != "" {
		w, id := e.wire, t.WireID
		go w.call("transfer.end", map[string]any{"id": id, "status": status}, nil)
	}
	e.persist()
}

func (e *Engine) removeSpool(t *task) {
	if !t.Incoming && t.Metadata.Kind == "text" && filepath.Dir(t.Source) == filepath.Join(e.paths.Data, "outbox") && filepath.Base(t.Source) == t.ID+".txt" {
		_ = os.Remove(t.Source)
	}
}
