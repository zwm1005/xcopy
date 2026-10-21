package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type message struct {
	ReplyTo string          `json:"replyTo"`
	OK      bool            `json:"ok"`
	Type    string          `json:"type"`
	Data    json.RawMessage `json:"data"`
	Error   rpcError        `json:"error"`
}

type rpcError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	RetryAfterMS int64  `json:"retryAfterMs"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

type wire struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan message
	done    chan struct{}
}

func connect(ctx context.Context, server string, event func(message)) (*wire, error) {
	url := "ws" + strings.TrimPrefix(server, "http") + "/ws"
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	ws, _, err := dialer.DialContext(ctx, url, http.Header{"Origin": {server}})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(2 * 1024 * 1024)
	w := &wire{ws: ws, pending: make(map[string]chan message), done: make(chan struct{})}
	events := make(chan message, 256)
	go func() {
		for {
			select {
			case m := <-events:
				event(m)
			case <-w.done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		defer close(w.done)
		defer ws.Close()
		for {
			var m message
			if err := ws.ReadJSON(&m); err != nil {
				return
			}
			if m.ReplyTo != "" {
				w.mu.Lock()
				ch := w.pending[m.ReplyTo]
				w.mu.Unlock()
				if ch != nil {
					select {
					case ch <- m:
					default:
					}
				}
			} else {
				// Keep reading RPC replies while the engine is busy writing file chunks.
				select {
				case events <- m:
				default:
					return
				}
			}
		}
	}()
	return w, nil
}

func (w *wire) call(kind string, data any, result any) error {
	return w.callRetrying(context.Background(), kind, data, result)
}

func (w *wire) callRetrying(ctx context.Context, kind string, data any, result any) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Keep an already submitted request alive until its bounded reply arrives.
		// A cancelled creation needs that reply's ID to retire its remote task.
		err := w.callOnce(kind, data, result)
		var remote *rpcError
		if kind != "transfer.start" || !errors.As(err, &remote) || remote.Code != "RATE_LIMIT" || remote.RetryAfterMS <= 0 || remote.RetryAfterMS > 30000 {
			return err
		}
		delay := time.Duration(remote.RetryAfterMS)*time.Millisecond + 25*time.Millisecond
		if time.Now().Add(delay).After(deadline) {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-w.done:
			timer.Stop()
			return fmt.Errorf("服务器连接中断")
		case <-timer.C:
		}
	}
}

func (w *wire) callOnce(kind string, data any, result any) error {
	id := newID()
	ch := make(chan message, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, id); w.mu.Unlock() }()
	w.writeMu.Lock()
	_ = w.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := w.ws.WriteJSON(map[string]any{"id": id, "type": kind, "data": data})
	w.writeMu.Unlock()
	if err != nil {
		return err
	}
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	select {
	case <-w.done:
		return fmt.Errorf("服务器连接中断")
	case <-timer.C:
		return fmt.Errorf("%s 请求超时", kind)
	case m := <-ch:
		if !m.OK {
			return &m.Error
		}
		if result != nil {
			return json.Unmarshal(m.Data, result)
		}
		return nil
	}
}

type Peer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
	Busy   int    `json:"busy"`
}
type Auth struct {
	Device struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"device"`
	Peers  []Peer `json:"peers"`
	Config struct {
		MaxFileBytes int64 `json:"maxFileBytes"`
		MaxTextBytes int64 `json:"maxTextBytes"`
		ForceRelay   bool  `json:"forceRelay"`
	} `json:"config"`
}

func authenticate(w *wire, key *ecdsa.PrivateKey, name string) (Auth, error) {
	var a Auth
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return a, err
	}
	fingerprint := sha256.Sum256(der)
	var begin struct {
		Challenge   string `json:"challenge"`
		Fingerprint string `json:"fingerprint"`
	}
	err = w.call("auth.begin", map[string]any{"publicKey": base64.StdEncoding.EncodeToString(der), "name": name}, &begin)
	if err != nil {
		return a, err
	}
	if begin.Fingerprint != hex.EncodeToString(fingerprint[:]) {
		return a, fmt.Errorf("服务器返回的设备指纹不匹配")
	}
	digest := sha256.Sum256([]byte(begin.Challenge))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return a, err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	err = w.call("auth.finish", map[string]any{"signature": base64.StdEncoding.EncodeToString(signature)}, &a)
	return a, err
}
