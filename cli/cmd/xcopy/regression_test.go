package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func TestDefaultDeviceName(t *testing.T) {
	if got := defaultDeviceName("  raspberry-pi  ", "linux"); got != "raspberry-pi" {
		t.Fatalf("hostname not used: %s", got)
	}
	if got := defaultDeviceName(strings.Repeat("树", 25), "linux"); len([]rune(got)) != 24 {
		t.Fatalf("hostname not truncated by rune: %s", got)
	}
	for system, prefix := range map[string]string{"linux": "Linux", "darwin": "macOS", "windows": "Windows", "unknown": "Device"} {
		for _, hostname := range []string{"", "  ", "bad\nname"} {
			if got := defaultDeviceName(hostname, system); !regexp.MustCompile("^" + prefix + "-[A-F0-9]{4}$").MatchString(got) {
				t.Fatalf("invalid fallback: %s", got)
			}
		}
	}
}

func TestInitPreservesCustomNameUnlessExplicitlyChanged(t *testing.T) {
	t.Setenv("XCOPY_HOME", t.TempDir())
	args := []string{"init", "--server", "http://localhost:1", "--receive-dir", t.TempDir()}
	if err := run(context.Background(), append(args, "--name", "我的树莓派")); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	p, err := paths("default")
	if err != nil {
		t.Fatal(err)
	}
	c, err := loadConfig(p)
	if err != nil || c.Name != "我的树莓派" {
		t.Fatal("existing name changed", c.Name, err)
	}
	if err := run(context.Background(), append(args, "--name", "新名称")); err != nil {
		t.Fatal(err)
	}
	c, err = loadConfig(p)
	if err != nil || c.Name != "新名称" {
		t.Fatal("explicit name ignored", c.Name, err)
	}
}

func TestInitPreservesExistingReceiveDirectory(t *testing.T) {
	base := t.TempDir()
	shared := filepath.Join(base, "shared")
	if err := os.Mkdir(shared, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0775); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(shared, "existing.txt")
	if err := os.WriteFile(existing, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	p := Paths{Config: filepath.Join(base, "config"), Data: filepath.Join(base, "data")}
	if _, err := initConfig(p, "http://localhost:1", "test", shared); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(shared)
	data, err := os.ReadFile(existing)
	if info.Mode().Perm() != 0775 || err != nil || string(data) != "keep" {
		t.Fatal("existing directory or contents changed", info.Mode(), err)
	}
	fresh := filepath.Join(base, "new-inbox")
	if _, err := initConfig(p, "http://localhost:1", "test", fresh); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{fresh, p.Config, p.Data} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatal("new private directory permissions", path, err)
		}
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(shared, link); err != nil {
		t.Fatal(err)
	}
	if _, err := initConfig(p, "http://localhost:1", "test", link); err == nil {
		t.Fatal("symlink receive directory accepted")
	}
}

func TestDaemonDiscoveryAcrossRuntimeEnvironments(t *testing.T) {
	base := t.TempDir()
	// Short paths also fit macOS's Unix socket path limit.
	runtimeDir, err := os.MkdirTemp("/tmp", "xcopy-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(runtimeDir)
	t.Setenv("XCOPY_HOME", base)
	t.Setenv("XDG_RUNTIME_DIR", runtimeDir)
	daemonPaths, err := paths("default")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := initConfig(daemonPaths, "http://localhost:1", "test", filepath.Join(base, "inbox")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- serve(ctx, daemonPaths) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-finished:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("daemon did not stop")
		}
		if _, err := os.Stat(filepath.Join(daemonPaths.Config, "daemon.json")); !os.IsNotExist(err) {
			t.Error("endpoint not removed at shutdown", err)
		}
	})
	t.Setenv("XDG_RUNTIME_DIR", "")
	clientPaths, err := paths("default")
	if err != nil || clientPaths.Socket == daemonPaths.Socket {
		t.Fatal("test requires different runtime paths", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status struct {
			Name string `json:"name"`
		}
		err = ipc(clientPaths, Request{Op: "status"}, &status)
		if err == nil {
			if status.Name != "test" {
				t.Fatal("wrong daemon reached")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	info, err := os.Stat(filepath.Join(daemonPaths.Config, "daemon.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("endpoint permissions", err)
	}
	if err := run(context.Background(), []string{"init", "--name", "changed"}); err == nil || !strings.Contains(err.Error(), "停止") {
		t.Fatal("init bypassed running daemon check", err)
	}
}

func TestStdinReadCanBeCancelled(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := readInput(ctx, reader); done <- err }()
	if _, err := writer.Write([]byte("unfinished input")); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stdin read ignored cancellation")
	}
	if _, err := writer.Write([]byte("more")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("cancelled input was not closed", err)
	}
	data, err := readInput(context.Background(), io.NopCloser(strings.NewReader("  中文\n")))
	if err != nil || string(data) != "  中文\n" {
		t.Fatal("normal input changed", err)
	}
}

func TestDirectTransferSurvivesStalledTURN(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn // Deliberately never complete the TLS handshake.
		}
	}()
	signals := make(chan json.RawMessage, 32)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			var request struct {
				ID   string          `json:"id"`
				Data json.RawMessage `json:"data"`
			}
			if err := ws.ReadJSON(&request); err != nil {
				return
			}
			signals <- request.Data
			if err := ws.WriteJSON(map[string]any{"replyTo": request.ID, "ok": true, "data": map[string]any{}}); err != nil {
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
	e := &Engine{ctx: ctx, jobs: make(chan func(), 128), wire: wire, paths: Paths{Data: t.TempDir()}}
	item := &task{Record: Record{ID: "test", WireID: "wire", Status: "connecting"}}
	err = e.makePC(item, []webrtc.ICEServer{{URLs: []string{"turns:" + listener.Addr().String() + "?transport=tcp"}, Username: "test", Credential: "test"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	pc := item.pc
	defer pc.Close()
	defer func() {
		select {
		case conn := <-accepted:
			conn.Close()
		default:
		}
	}()
	dc, err := pc.CreateDataChannel("suichuan", nil)
	if err != nil {
		t.Fatal(err)
	}
	dc.OnOpen(func() { _ = dc.SendText("direct transfer works") })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.publishDescription(item, offer); err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Signal struct {
			Description *webrtc.SessionDescription `json:"description"`
		} `json:"signal"`
	}
	deadline := time.After(20 * time.Second)
	for sent.Signal.Description == nil {
		select {
		case fn := <-e.jobs:
			fn()
			if terminal(item.Status) {
				t.Fatal("usable direct candidates discarded:", item.Error)
			}
		case data := <-signals:
			if err := json.Unmarshal(data, &sent); err != nil {
				t.Fatal(err)
			}
			if sent.Signal.Description == nil {
				t.Fatal("candidate sent before initial SDP")
			}
		case <-deadline:
			t.Fatal("no SDP published")
		}
	}
	if pc.ICEGatheringState() != webrtc.ICEGatheringStateGathering {
		t.Fatal("TURN endpoint did not remain stalled")
	}
	remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	received := make(chan string, 1)
	remote.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(m webrtc.DataChannelMessage) { received <- string(m.Data) })
	})
	if err := remote.SetRemoteDescription(*sent.Signal.Description); err != nil {
		t.Fatal(err)
	}
	answer, err := remote.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(remote)
	if err := remote.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("remote gathering timed out")
	}
	if err := pc.SetRemoteDescription(*remote.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-received:
		if value != "direct transfer works" {
			t.Fatal("bytes changed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("direct transfer failed")
	}
}

func TestRelayPolicyRequiresRelayCandidate(t *testing.T) {
	description := &webrtc.SessionDescription{SDP: "a=candidate:1 1 udp 1 192.0.2.1 1234 typ host\r\n"}
	if !usableDescription(description, webrtc.ICETransportPolicyAll) || usableDescription(description, webrtc.ICETransportPolicyRelay) {
		t.Fatal("relay policy bypassed by host candidate")
	}
	description.SDP += "a=candidate:2 1 udp 1 192.0.2.2 5678 typ relay\r\n"
	if !usableDescription(description, webrtc.ICETransportPolicyRelay) || usableDescription(nil, webrtc.ICETransportPolicyAll) || usableDescription(&webrtc.SessionDescription{}, webrtc.ICETransportPolicyAll) {
		t.Fatal("invalid candidate selection")
	}
}
