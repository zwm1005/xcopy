package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReceiveCommitAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	payload := []byte("  中文\n<script>原样文字</script>  ")
	sum := sha256.Sum256(payload)
	for i := 0; i < 2; i++ {
		r, err := newReceiver(root, int64(len(payload)), ".xcopy-test-")
		if err != nil {
			t.Fatal(err)
		}
		defer r.abort()
		if err := r.write(payload[:5]); err != nil {
			t.Fatal(err)
		}
		if err := r.write(payload[5:]); err != nil {
			t.Fatal(err)
		}
		name, err := r.commit("../same.txt", hex.EncodeToString(sum[:]), true)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(name) != name {
			t.Fatal("path escaped")
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(data) != string(payload) {
			t.Fatal("bytes changed", err)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatal("existing file overwritten")
	}
}

func TestReceiveRejectsCorruptionAndOversize(t *testing.T) {
	dir := t.TempDir()
	root, _ := os.OpenRoot(dir)
	defer root.Close()
	r, err := newReceiver(root, 3, ".xcopy-test-")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.write([]byte("four")); err == nil {
		t.Fatal("oversize accepted")
	}
	if err := r.write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.commit("data", "wrong", false); err == nil {
		t.Fatal("bad hash accepted")
	}
	r.abort()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatal("partial leaked")
	}
}

func TestReceiveNeverFollowsDestinationSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "target")); err != nil {
		t.Fatal(err)
	}
	root, _ := os.OpenRoot(dir)
	defer root.Close()
	r, _ := newReceiver(root, 0, ".xcopy-test-")
	defer r.abort()
	sum := sha256.Sum256(nil)
	name, err := r.commit("target", hex.EncodeToString(sum[:]), false)
	if err != nil || name == "target" {
		t.Fatal("destination symlink followed", err)
	}
	data, _ := os.ReadFile(outside)
	if string(data) != "keep" {
		t.Fatal("outside file changed")
	}
}

func TestTextRejectsInvalidUTF8(t *testing.T) {
	root, _ := os.OpenRoot(t.TempDir())
	defer root.Close()
	r, _ := newReceiver(root, 1, ".xcopy-test-")
	defer r.abort()
	_ = r.write([]byte{0xff})
	sum := sha256.Sum256([]byte{0xff})
	if _, err := r.commit("text", hex.EncodeToString(sum[:]), true); err == nil {
		t.Fatal("invalid text accepted")
	}
}

func TestIdentityPersistsWithPrivatePermissions(t *testing.T) {
	dir := t.TempDir()
	p := Paths{Config: dir}
	first, err := identity(p)
	if err != nil {
		t.Fatal(err)
	}
	second, err := identity(p)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Fatal("identity changed")
	}
	info, _ := os.Stat(filepath.Join(dir, "identity.pem"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("key permissions")
	}
}

func TestProfileStartupDoesNotDeleteOtherProfilePartial(t *testing.T) {
	dir := t.TempDir()
	first, err := newEngine(context.Background(), Config{ReceiveDir: dir}, Paths{Config: filepath.Join(dir, "a"), Data: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer first.root.Close()
	r, err := newReceiver(first.root, 3, first.partialPrefix)
	if err != nil {
		t.Fatal(err)
	}
	defer r.abort()
	second, err := newEngine(context.Background(), Config{ReceiveDir: dir}, Paths{Config: filepath.Join(dir, "b"), Data: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer second.root.Close()
	if _, err := os.Stat(filepath.Join(dir, r.temp)); err != nil {
		t.Fatal("another profile deleted active partial", err)
	}
}

func TestServerAndArguments(t *testing.T) {
	var auth Auth
	if err := json.Unmarshal([]byte(`{"peers":[{"id":"device","name":"浏览器","online":true,"busy":2}]}`), &auth); err != nil || len(auth.Peers) != 1 || auth.Peers[0].Busy != 2 {
		t.Fatal("server busy is an integer", err)
	}
	for _, url := range []string{"http://example.com", "https://host/path", "https://user:pass@host", "https://host?token=secret"} {
		if _, err := validateServer(url); err == nil {
			t.Fatalf("accepted %s", url)
		}
	}
	if _, err := validateServer("http://localhost:8787"); err != nil {
		t.Fatal(err)
	}
	o, err := parse([]string{"send", "./报告.txt", "--to", "树莓派", "--json"})
	if err != nil || len(o.args) != 2 || o.values["to"] != "树莓派" || !o.flags["json"] {
		t.Fatal("interspersed flags", err)
	}
}
