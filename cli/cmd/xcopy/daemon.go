package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type Request struct {
	Op     string         `json:"op"`
	ID     string         `json:"id,omitempty"`
	Peer   string         `json:"peer,omitempty"`
	Source string         `json:"source,omitempty"`
	Text   string         `json:"text,omitempty"`
	IsText bool           `json:"isText,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}
type Response struct {
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

func serve(ctx context.Context, p Paths) error {
	c, err := loadConfig(p)
	if err != nil {
		return err
	}
	if err := privateDir(p.Data); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(p.Config, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("此 profile 已有 xcopy 后台运行")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if err := privateDir(filepath.Dir(p.Socket)); err != nil {
		return err
	}
	_ = os.Remove(p.Socket)
	listener, err := net.Listen("unix", p.Socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(p.Socket)
	if err := os.Chmod(p.Socket, 0600); err != nil {
		return err
	}
	// Publish the actual endpoint under the profile lock. Short commands may
	// run without the daemon's XDG_RUNTIME_DIR (for example from cron).
	endpointPath := filepath.Join(p.Config, "daemon.json")
	if err := atomicJSON(endpointPath, daemonEndpoint{Socket: p.Socket}); err != nil {
		return err
	}
	defer os.Remove(endpointPath)
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	e, err := newEngine(child, c, p)
	if err != nil {
		return err
	}
	finished := make(chan struct{})
	go func() { e.run(); close(finished) }()
	go e.network()
	mux := http.NewServeMux()
	mux.HandleFunc("/rpc", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "POST" {
			http.Error(w, "POST required", 405)
			return
		}
		var q Request
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024*1024))
		if err := decoder.Decode(&q); err != nil {
			_ = json.NewEncoder(w).Encode(Response{Error: err.Error()})
			return
		}
		result := make(chan Response, 1)
		if !e.post(func() {
			value, err := e.handle(q)
			if err != nil {
				result <- Response{Error: err.Error()}
				return
			}
			if remote, ok := value.(remoteRequest); ok {
				go func() {
					var data json.RawMessage
					if err := remote.wire.call(remote.kind, remote.data, &data); err != nil {
						result <- Response{Error: err.Error()}
					} else {
						result <- Response{Data: data}
					}
				}()
				return
			}
			data, err := json.Marshal(value)
			if err != nil {
				result <- Response{Error: err.Error()}
				return
			}
			result <- Response{Data: data}
		}) {
			return
		}
		select {
		case res := <-result:
			_ = json.NewEncoder(w).Encode(res)
		case <-r.Context().Done():
		case <-child.Done():
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-child.Done()
		closeCtx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		_ = server.Shutdown(closeCtx)
	}()
	log.Printf("xcopy %s 启动，设备 %s，接收目录 %s", version, c.Name, c.ReceiveDir)
	err = server.Serve(listener)
	cancel()
	<-finished
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (e *Engine) handle(q Request) (any, error) {
	switch q.Op {
	case "status":
		return map[string]any{"online": e.wire != nil, "device": e.auth.Device, "name": e.config.Name, "server": e.config.Server, "receiveDir": e.config.ReceiveDir, "error": e.lastError, "version": version}, nil
	case "devices":
		peers := append([]Peer{}, e.auth.Peers...)
		if e.wire == nil {
			for i := range peers {
				peers[i].Online = false
			}
		}
		return peers, nil
	case "transfers":
		return e.records(false), nil
	case "inbox":
		return e.records(true), nil
	case "transfer":
		if t := e.byID(q.ID); t != nil {
			return snapshot(t), nil
		}
		return nil, fmt.Errorf("记录不存在")
	case "send":
		if q.IsText && !utf8.ValidString(q.Text) {
			return nil, fmt.Errorf("文字不是有效 UTF-8")
		}
		t, err := e.enqueue(q.Peer, q.Source, q.Text, q.IsText)
		if err != nil {
			return nil, err
		}
		return snapshot(t), nil
	case "cancel":
		t := e.byID(q.ID)
		if t == nil {
			return nil, fmt.Errorf("记录不存在")
		}
		e.finish(t, "cancelled", "本机取消了传输", true)
		return snapshot(t), nil
	case "retry":
		t := e.byID(q.ID)
		if t == nil || t.Incoming || !terminal(t.Status) || t.Status == "completed" {
			return nil, fmt.Errorf("只能重试失败或取消的发送记录")
		}
		var text string
		if t.Metadata.Kind == "text" {
			data, err := os.ReadFile(t.Source)
			if err != nil {
				return nil, err
			}
			text = string(data)
		}
		next, err := e.enqueue(t.PeerID, t.Source, text, t.Metadata.Kind == "text")
		if err != nil {
			return nil, err
		}
		return snapshot(next), nil
	case "pair.requests":
		out := []json.RawMessage{}
		for id, data := range e.requests {
			var r struct {
				Expires int64 `json:"expires"`
			}
			_ = json.Unmarshal(data, &r)
			if r.Expires > 0 && r.Expires < time.Now().UnixMilli() {
				delete(e.requests, id)
			} else {
				out = append(out, data)
			}
		}
		return out, nil
	case "pair.result":
		if data, ok := e.results[q.ID]; ok {
			return data, nil
		}
		return map[string]any{"id": q.ID, "status": "pending"}, nil
	case "pair.code", "pair.join", "pair.respond", "pair.cancel", "pair.forget":
		if q.Data == nil {
			q.Data = map[string]any{}
		}
		if e.wire == nil {
			return nil, fmt.Errorf("服务器未连接")
		}
		if q.Op == "pair.forget" {
			p, err := e.peer(q.Peer)
			if err != nil {
				return nil, err
			}
			q.Data = map[string]any{"peerId": p.ID}
		}
		return remoteRequest{wire: e.wire, kind: q.Op, data: q.Data}, nil
	}
	return nil, fmt.Errorf("不支持的操作 %s", q.Op)
}

// Prepared on the engine loop, executed by the IPC handler outside that loop.
type remoteRequest struct {
	wire *wire
	kind string
	data any
}

type daemonEndpoint struct {
	Socket string `json:"socket"`
}

func daemonSocket(p Paths) (string, error) {
	data, err := os.ReadFile(filepath.Join(p.Config, "daemon.json"))
	if os.IsNotExist(err) {
		// Also allow commands to reach a daemon installed before endpoint discovery.
		return p.Socket, nil
	}
	if err != nil {
		return "", err
	}
	var endpoint daemonEndpoint
	if err := json.Unmarshal(data, &endpoint); err != nil {
		return "", err
	}
	if !filepath.IsAbs(endpoint.Socket) {
		return "", fmt.Errorf("后台 socket 地址无效")
	}
	return endpoint.Socket, nil
}

func ipc(p Paths, q Request, result any) error {
	socket, err := daemonSocket(p)
	if err != nil {
		return err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second}
	body, err := json.Marshal(q)
	if err != nil {
		return err
	}
	res, err := client.Post("http://xcopy/rpc", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("无法访问 xcopy 后台，请运行 xcopy serve 或 xcopy service start: %w", err)
	}
	defer res.Body.Close()
	var response Response
	if err := json.NewDecoder(io.LimitReader(res.Body, 8*1024*1024)).Decode(&response); err != nil {
		return err
	}
	if response.Error != "" {
		return fmt.Errorf("%s", response.Error)
	}
	if result != nil {
		return json.Unmarshal(response.Data, result)
	}
	return nil
}
