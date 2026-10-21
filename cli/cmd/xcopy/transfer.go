package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

type receiver struct {
	root *os.Root
	file interface {
		io.WriteCloser
		Sync() error
	}
	temp      string
	saved     string
	hash      hash.Hash
	size      int64
	written   int64
	committed bool
}

func newReceiver(root *os.Root, size int64, prefix string) (*receiver, error) {
	name := prefix + newID() + ".part"
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	return &receiver{root: root, file: f, temp: name, hash: sha256.New(), size: size}, nil
}
func (r *receiver) write(data []byte) error {
	if int64(len(data))+r.written > r.size {
		return fmt.Errorf("收到的数据超过声明大小")
	}
	n, err := r.file.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	r.hash.Write(data)
	r.written += int64(n)
	return nil
}
func (r *receiver) commit(name, expected string, text bool) (string, error) {
	actual := hex.EncodeToString(r.hash.Sum(nil))
	if r.written != r.size || actual != expected {
		return "", fmt.Errorf("文件长度或 SHA-256 校验失败")
	}
	if err := r.file.Sync(); err != nil {
		return "", err
	}
	if err := r.file.Close(); err != nil {
		return "", err
	}
	r.file = nil
	if text {
		data, err := r.root.ReadFile(r.temp)
		if err != nil {
			return "", err
		}
		if !utf8.Valid(data) {
			return "", fmt.Errorf("文字不是有效 UTF-8")
		}
	}
	name = safeName(name)
	for i := 0; i < 100; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s-%s", newID()[:8], name)
		}
		// Hard-link publication is atomic and refuses to overwrite any existing file or symlink.
		err := r.root.Link(r.temp, candidate)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		r.saved = candidate
		if err := r.root.Remove(r.temp); err != nil {
			return "", err
		}
		dir, err := r.root.Open(".")
		if err != nil {
			return "", err
		}
		err = dir.Sync()
		_ = dir.Close()
		if err != nil {
			return "", err
		}
		r.committed = true
		return candidate, nil
	}
	return "", fmt.Errorf("无法生成未占用的文件名")
}
func (r *receiver) abort() {
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	if !r.committed {
		_ = r.root.Remove(r.temp)
		if r.saved != "" {
			_ = r.root.Remove(r.saved)
		}
	}
}

func (e *Engine) makePC(t *task, servers []webrtc.ICEServer, relay bool) error {
	config := webrtc.Configuration{ICEServers: servers}
	if relay {
		config.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return err
	}
	t.pc = pc
	if t.ctx == nil {
		t.ctx, t.cancel = context.WithCancel(e.ctx)
	}
	t.signals = make(chan any, 128)
	w, id, ctx, signals := e.wire, t.WireID, t.ctx, t.signals
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case signal := <-signals:
				if ctx.Err() != nil {
					return
				}
				if w == nil {
					return
				}
				err := w.call("signal", map[string]any{"id": id, "signal": signal}, nil)
				if err != nil && !strings.HasPrefix(err.Error(), "TRANSFER_ENDED:") && !strings.HasPrefix(err.Error(), "NOT_FOUND:") {
					e.post(func() { e.finish(t, "failed", err.Error(), true) })
					return
				}
			}
		}
	}()
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		e.post(func() {
			if terminal(t.Status) || !t.descriptionPublished {
				return
			}
			if err := e.signal(t, map[string]any{"candidate": candidate.ToJSON()}); err != nil {
				e.finish(t, "failed", err.Error(), true)
			}
		})
	})
	receive := t.receive
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed && receive != nil {
			// An end marker already queued for durable commit takes precedence
			// over a subsequent transport failure.
			receive.push(receiveEvent{err: fmt.Errorf("WebRTC 连接失败")})
			return
		}
		e.post(func() {
			if terminal(t.Status) {
				return
			}
			if state == webrtc.PeerConnectionStateFailed {
				e.finish(t, "failed", "WebRTC 连接失败", true)
			}
			if state == webrtc.PeerConnectionStateConnected {
				t.activity.Store(time.Now().UnixNano())
				if transport := pc.SCTP(); transport != nil {
					pair, err := transport.Transport().ICETransport().GetSelectedCandidatePair()
					if err == nil && pair != nil {
						t.Route = "direct"
						if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
							t.Route = "relay"
						}
					}
				}
			}
		})
	})
	if t.Incoming {
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			bound := make(chan struct{})
			e.post(func() {
				defer close(bound)
				if terminal(t.Status) {
					_ = dc.Close()
					return
				}
				if t.dc != nil || dc.Label() != "suichuan" || !dc.Ordered() {
					_ = dc.Close()
					e.finish(t, "failed", "不兼容的数据通道", true)
					return
				}
				e.bindChannel(t, dc)
			})
			// Register the message handler before Pion starts reading this channel.
			select {
			case <-bound:
			case <-e.ctx.Done():
			}
		})
	}
	return nil
}

func (e *Engine) publishDescription(t *task, description webrtc.SessionDescription) error {
	pc := t.pc
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(description); err != nil {
		return err
	}
	// Prefer a complete candidate set so relay-only browsers see relay/public
	// addresses together with host addresses. A stalled optional TURN endpoint
	// must not discard usable candidates; late candidates follow the initial SDP.
	go func() {
		select {
		case <-t.ctx.Done():
			return
		case <-time.After(15 * time.Second):
		case <-gathered:
		}
		e.post(func() {
			if terminal(t.Status) {
				return
			}
			description := pc.LocalDescription()
			if !usableDescription(description, pc.GetConfiguration().ICETransportPolicy) {
				e.finish(t, "failed", "未获取可用网络地址，请检查 STUN/TURN 连通性", true)
				return
			}
			if err := e.signal(t, map[string]any{"description": description}); err != nil {
				e.finish(t, "failed", err.Error(), true)
				return
			}
			t.descriptionPublished = true
		})
	}()
	return nil
}

func usableDescription(description *webrtc.SessionDescription, policy webrtc.ICETransportPolicy) bool {
	if description == nil {
		return false
	}
	for _, line := range strings.Split(description.SDP, "\n") {
		if strings.HasPrefix(line, "a=candidate:") && (policy != webrtc.ICETransportPolicyRelay || strings.Contains(line, " typ relay")) {
			return true
		}
	}
	return false
}

func (e *Engine) signal(t *task, signal any) error {
	if e.wire == nil || t.signals == nil {
		return fmt.Errorf("服务器未连接")
	}
	// One bounded queue per transfer preserves SDP/candidate order without
	// making other transfers or local commands wait for an RPC response.
	select {
	case t.signals <- signal:
		return nil
	default:
		return fmt.Errorf("协商消息过多，请重新发送")
	}
}

func (e *Engine) offer(data json.RawMessage) {
	var offer struct {
		ID         string             `json:"id"`
		PeerID     string             `json:"peerId"`
		PeerName   string             `json:"peerName"`
		Metadata   Metadata           `json:"metadata"`
		ICEServers []webrtc.ICEServer `json:"iceServers"`
		ForceRelay bool               `json:"forceRelay"`
	}
	if json.Unmarshal(data, &offer) != nil || e.byWire(offer.ID) != nil {
		return
	}
	t := &task{Record: Record{ID: newID(), WireID: offer.ID, PeerID: offer.PeerID, PeerName: offer.PeerName, Incoming: true, Metadata: offer.Metadata, Status: "connecting", Created: time.Now(), Updated: time.Now()}}
	t.activity.Store(time.Now().UnixNano())
	e.tasks = append(e.tasks, t)
	m := t.Metadata
	if m.Size < 0 || m.Size > maxFile || (m.Kind == "text" && m.Size > maxText) || (m.Kind != "text" && m.Kind != "file" && m.Kind != "image") {
		e.finish(t, "failed", "不支持的内容类型或大小", true)
		return
	}
	w, id := e.wire, t.WireID
	err := e.startReceiver(t, func() (*receiver, error) {
		return newReceiver(e.root, m.Size, e.partialPrefix)
	}, func() {
		if e.wire != w {
			e.finish(t, "failed", "连接中断，请重新发送", false)
			return
		}
		if err := e.makePC(t, offer.ICEServers, offer.ForceRelay); err != nil {
			e.finish(t, "failed", err.Error(), true)
			return
		}
		go func() {
			if err := w.call("transfer.accept", map[string]any{"id": id}, nil); err != nil {
				e.post(func() { e.finish(t, "failed", err.Error(), true) })
			}
		}()
	})
	if err != nil {
		e.finish(t, "failed", err.Error(), true)
	}
	e.persist()
}

func (e *Engine) remoteSignal(data json.RawMessage) {
	var m struct {
		ID     string `json:"id"`
		Signal struct {
			Description *webrtc.SessionDescription `json:"description"`
			Candidate   *webrtc.ICECandidateInit   `json:"candidate"`
		} `json:"signal"`
	}
	if json.Unmarshal(data, &m) != nil {
		return
	}
	t := e.byWire(m.ID)
	if t == nil || t.pc == nil || terminal(t.Status) {
		return
	}
	var err error
	if m.Signal.Description != nil {
		description := *m.Signal.Description
		err = t.pc.SetRemoteDescription(description)
		if err == nil {
			for _, c := range t.candidates {
				if err = t.pc.AddICECandidate(c); err != nil {
					break
				}
			}
			t.candidates = nil
		}
		if err == nil && description.Type == webrtc.SDPTypeOffer && t.Incoming {
			var answer webrtc.SessionDescription
			answer, err = t.pc.CreateAnswer(&webrtc.AnswerOptions{OfferAnswerOptions: webrtc.OfferAnswerOptions{ICETricklingSupported: true}})
			if err == nil {
				err = e.publishDescription(t, answer)
			}
		}
	} else if m.Signal.Candidate != nil {
		if t.pc.RemoteDescription() == nil {
			if len(t.candidates) < 128 {
				t.candidates = append(t.candidates, *m.Signal.Candidate)
			}
		} else {
			err = t.pc.AddICECandidate(*m.Signal.Candidate)
		}
	}
	if err != nil {
		e.finish(t, "failed", err.Error(), true)
	}
}

func (e *Engine) bindChannel(t *task, dc *webrtc.DataChannel) {
	t.dc = dc
	dc.OnOpen(func() {
		e.post(func() {
			if terminal(t.Status) {
				return
			}
			t.Status = "transferring"
			t.activity.Store(time.Now().UnixNano())
			if !t.Incoming {
				go e.sendBytes(t, dc, t.Source, t.Metadata.Size)
			}
		})
	})
	// Receive callbacks only feed this transfer's bounded queue. Disk I/O and
	// backpressure must never occupy the shared engine/control-command loop.
	receive := t.receive
	channelError := func(err error) {
		if receive != nil {
			receive.push(receiveEvent{err: err})
		} else {
			e.post(func() { e.finish(t, "failed", err.Error(), true) })
		}
	}
	dc.OnError(channelError)
	dc.OnClose(func() {
		channelError(fmt.Errorf("数据通道已关闭"))
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if receive != nil {
			receive.message(msg, func() { _ = dc.SendText(`{"type":"ack"}`) })
			return
		}
		data := append([]byte(nil), msg.Data...)
		e.post(func() {
			if terminal(t.Status) {
				return
			}
			t.activity.Store(time.Now().UnixNano())
			var err error
			if msg.IsString {
				var control struct {
					Type string `json:"type"`
					Hash string `json:"hash"`
				}
				if len(data) > 1024 || json.Unmarshal(data, &control) != nil {
					e.finish(t, "failed", "无效的控制消息", true)
					return
				}
				switch control.Type {
				case "cancel":
					e.finish(t, "cancelled", "对方取消了传输", true)
				case "ack":
					if !t.Incoming {
						e.finish(t, "completed", "", false)
					}
				case "end":
					err = fmt.Errorf("无效的结束消息")
				default:
					err = fmt.Errorf("未知的数据通道消息")
				}
			} else {
				err = fmt.Errorf("发送方收到了意外的二进制数据")
			}
			if err != nil {
				e.finish(t, "failed", err.Error(), true)
			}
		})
	})
}

func (e *Engine) sendBytes(t *task, dc *webrtc.DataChannel, path string, size int64) {
	err := func() error {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() != size {
			return fmt.Errorf("源文件大小已改变，请重新发送")
		}
		h := sha256.New()
		buffer := make([]byte, 16*1024)
		remaining := size
		for remaining > 0 {
			select {
			case <-t.ctx.Done():
				return t.ctx.Err()
			default:
			}
			for dc.BufferedAmount() > 512*1024 {
				select {
				case <-t.ctx.Done():
					return t.ctx.Err()
				case <-time.After(10 * time.Millisecond):
				}
			}
			n := int64(len(buffer))
			if remaining < n {
				n = remaining
			}
			if _, err := io.ReadFull(f, buffer[:n]); err != nil {
				return err
			}
			if err := dc.Send(buffer[:n]); err != nil {
				return err
			}
			h.Write(buffer[:n])
			remaining -= n
			t.bytes.Add(n)
			t.activity.Store(time.Now().UnixNano())
		}
		// Detect append/truncate while reading rather than reporting a stale snapshot.
		extra := make([]byte, 1)
		if n, err := f.Read(extra); n != 0 || err != io.EOF {
			return fmt.Errorf("源文件在传输期间发生变化")
		}
		digest := hex.EncodeToString(h.Sum(nil))
		e.post(func() { t.Hash = digest })
		data, _ := json.Marshal(map[string]string{"type": "end", "hash": digest})
		t.sent.Store(true)
		return dc.SendText(string(data))
	}()
	if err != nil && !strings.Contains(err.Error(), "context canceled") {
		e.post(func() { e.finish(t, "failed", err.Error(), true) })
	}
}
