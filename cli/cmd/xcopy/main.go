package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

var version = "0.1.2"

const help = `xcopy — Linux / 树莓派文件与文字传输

  xcopy init --name walle-pi4 --receive-dir ~/xcopy/inbox
  xcopy service install --user --start     安装并启动用户服务
  xcopy serve                              前台运行（调试或容器）
  xcopy status                             查看连接状态
  xcopy devices                            查看已配对设备
  xcopy pair join 12345678                  输入浏览器配对码并等待批准
  xcopy pair code                          生成配对码
  xcopy pair requests                      查看待批准请求及设备指纹
  xcopy pair accept ID / reject ID          批准或拒绝请求
  xcopy pair forget 设备ID                  解除配对
  xcopy send ./file --to 设备名或ID          发送文件，等待对方确认
  printf '你好' | xcopy send --stdin --to 设备名或ID
  xcopy transfers [--follow]                查看最近 300 条记录
  xcopy inbox                              查看收到的内容
  xcopy read 记录ID [--raw]                 读取收到的文字
  xcopy cancel 记录ID / retry 记录ID        取消或重新发送
  xcopy service status|start|stop|restart|uninstall

通用选项：--profile default  --json
发送选项：--detach（只入队，不等待收件确认）
初始化选项：--server https://xcopy.werfamily.fun
文件上限 50 MiB；UTF-8 文字上限 1 MiB。必须双方在线且已配对。
`

type options struct {
	args   []string
	values map[string]string
	flags  map[string]bool
}

func parse(args []string) (options, error) {
	o := options{values: map[string]string{}, flags: map[string]bool{}}
	bools := map[string]bool{"json": true, "user": true, "start": true, "stdin": true, "detach": true, "follow": true, "raw": true, "help": true}
	values := map[string]bool{"profile": true, "server": true, "name": true, "receive-dir": true, "to": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			o.args = append(o.args, args[i+1:]...)
			break
		}
		if a == "-h" {
			o.flags["help"] = true
			continue
		}
		if !strings.HasPrefix(a, "--") {
			o.args = append(o.args, a)
			continue
		}
		k, v, has := strings.Cut(strings.TrimPrefix(a, "--"), "=")
		if bools[k] && !has {
			o.flags[k] = true
			continue
		}
		if !values[k] {
			return o, fmt.Errorf("未知选项 %s", a)
		}
		if !has {
			i++
			if i >= len(args) {
				return o, fmt.Errorf("%s 缺少参数", a)
			}
			v = args[i]
		}
		o.values[k] = v
	}
	return o, nil
}
func (o options) value(k, def string) string {
	if s, ok := o.values[k]; ok {
		return s
	}
	return def
}
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return '�'
		}
		return r
	}, s)
}
func output(value any, o options) error {
	if o.flags["json"] {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(value)
	}
	switch v := value.(type) {
	case []Peer:
		if len(v) == 0 {
			fmt.Println("暂无配对设备，请运行 xcopy pair join 配对码")
		}
		for _, p := range v {
			dot := "○"
			status := "离线"
			if p.Online {
				dot = "●"
				status = "在线"
			}
			fmt.Printf("%s %-8s %s  %s\n", dot, status, clean(p.Name), p.ID)
		}
	case []Record:
		if len(v) == 0 {
			fmt.Println("暂无传输记录")
		}
		for _, r := range v {
			printRecord(r)
		}
	case Record:
		printRecord(v)
	default:
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
	}
	return nil
}
func printRecord(r Record) {
	direction := "发送"
	if r.Incoming {
		direction = "接收"
	}
	fmt.Printf("%s  %s  %-12s %s ↔ %s  %d/%d 字节\n", r.ID, direction, r.Status, clean(r.Metadata.Name), clean(r.PeerName), r.Bytes, r.Metadata.Size)
	if r.Path != "" {
		fmt.Printf("  %s\n", clean(r.Path))
	}
	if r.Error != "" {
		fmt.Printf("  %s\n", clean(r.Error))
	}
}

func readInput(ctx context.Context, input io.ReadCloser) ([]byte, error) {
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(input, maxText+1))
		done <- result{data, err}
	}()
	select {
	case <-ctx.Done():
		_ = input.Close()
		return nil, ctx.Err()
	case value := <-done:
		return value.data, value.err
	}
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		o, _ := parse(os.Args[1:])
		if o.flags["json"] {
			_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": err.Error()})
		} else {
			fmt.Fprintln(os.Stderr, "xcopy:", clean(err.Error()))
		}
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) error {
	o, err := parse(args)
	if err != nil {
		return err
	}
	if len(o.args) == 0 || o.flags["help"] || o.args[0] == "help" {
		fmt.Print(help)
		return nil
	}
	command := o.args[0]
	if command == "version" || command == "--version" {
		fmt.Printf("xcopy %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
		return nil
	}
	profile := o.value("profile", "default")
	p, err := paths(profile)
	if err != nil {
		return err
	}
	if command == "init" {
		var current any
		if ipc(p, Request{Op: "status"}, &current) == nil {
			return fmt.Errorf("请先停止此 profile 的后台服务再修改初始化配置")
		}
		hostname, _ := os.Hostname()
		name := defaultDeviceName(hostname, runtime.GOOS)
		if previous, err := loadConfig(p); err == nil {
			name = previous.Name
		}
		home, _ := os.UserHomeDir()
		c, err := initConfig(p, o.value("server", defaultServer), o.value("name", name), o.value("receive-dir", filepath.Join(home, "xcopy/inbox")))
		if err != nil {
			return err
		}
		return output(c, o)
	}
	if command == "serve" {
		return serve(ctx, p)
	}
	if command == "service" {
		return service(o, p, profile)
	}
	switch command {
	case "status":
		var value any
		if err := ipc(p, Request{Op: "status"}, &value); err != nil {
			return err
		}
		return output(value, o)
	case "devices":
		var peers []Peer
		if err := ipc(p, Request{Op: "devices"}, &peers); err != nil {
			return err
		}
		return output(peers, o)
	case "transfers", "inbox":
		var previous string
		for {
			var records []Record
			if err := ipc(p, Request{Op: command}, &records); err != nil {
				return err
			}
			data, _ := json.Marshal(records)
			if string(data) != previous {
				if err := output(records, o); err != nil {
					return err
				}
				previous = string(data)
			}
			if !o.flags["follow"] {
				return nil
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
		}
	case "send", "retry":
		var r Record
		q := Request{Op: command, Peer: o.values["to"], IsText: o.flags["stdin"]}
		if command == "retry" {
			if len(o.args) != 2 {
				return fmt.Errorf("用法: xcopy retry 记录ID")
			}
			q.ID = o.args[1]
		} else {
			if q.Peer == "" {
				return fmt.Errorf("请用 --to 指定接收设备")
			}
			if q.IsText {
				if len(o.args) != 1 {
					return fmt.Errorf("--stdin 与文件参数不能同时使用")
				}
				data, err := readInput(ctx, os.Stdin)
				if err != nil {
					return err
				}
				if len(data) > maxText || !utf8.Valid(data) {
					return fmt.Errorf("stdin 必须是最多 1 MiB 的 UTF-8 文字")
				}
				q.Text = string(data)
			} else {
				if len(o.args) != 2 {
					return fmt.Errorf("用法: xcopy send 文件路径 --to 设备")
				}
				q.Source, err = filepath.Abs(o.args[1])
				if err != nil {
					return err
				}
			}
		}
		if err := ipc(p, q, &r); err != nil {
			return err
		}
		if o.flags["detach"] {
			return output(r, o)
		}
		if !o.flags["json"] {
			fmt.Fprintln(os.Stderr, "等待对方确认，任务", r.ID)
		}
		for !terminal(r.Status) {
			select {
			case <-ctx.Done():
				_ = ipc(p, Request{Op: "cancel", ID: r.ID}, nil)
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
			if err := ipc(p, Request{Op: "transfer", ID: r.ID}, &r); err != nil {
				return err
			}
		}
		if err := output(r, o); err != nil {
			return err
		}
		if r.Status != "completed" {
			return fmt.Errorf("传输%s: %s", r.Status, r.Error)
		}
		return nil
	case "cancel":
		if len(o.args) != 2 {
			return fmt.Errorf("用法: xcopy cancel 记录ID")
		}
		var r Record
		if err := ipc(p, Request{Op: "cancel", ID: o.args[1]}, &r); err != nil {
			return err
		}
		return output(r, o)
	case "read":
		if len(o.args) != 2 {
			return fmt.Errorf("用法: xcopy read 记录ID")
		}
		var r Record
		if err := ipc(p, Request{Op: "transfer", ID: o.args[1]}, &r); err != nil {
			return err
		}
		if !r.Incoming || r.Status != "completed" || r.Metadata.Kind != "text" {
			return fmt.Errorf("此记录不是已接收的文字")
		}
		f, err := os.Open(r.Path)
		if err != nil {
			return err
		}
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, maxText+1))
		if err != nil {
			return err
		}
		if len(data) > maxText {
			return fmt.Errorf("文字文件已改变并超过大小限制")
		}
		if o.flags["json"] {
			return output(map[string]any{"id": r.ID, "text": string(data)}, o)
		}
		if !o.flags["raw"] {
			data = []byte(strings.Map(func(r rune) rune {
				if (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.In(r, unicode.Cf) {
					return '�'
				}
				return r
			}, string(data)))
		}
		_, err = os.Stdout.Write(data)
		return err
	case "pair":
		return pairCommand(ctx, p, o)
	}
	return fmt.Errorf("未知命令 %s，运行 xcopy help 查看帮助", command)
}

func pairCommand(ctx context.Context, p Paths, o options) error {
	if len(o.args) < 2 {
		return fmt.Errorf("用法: xcopy pair code|join|requests|accept|reject|forget|cancel")
	}
	sub := o.args[1]
	q := Request{Op: "pair." + sub, Data: map[string]any{}}
	switch sub {
	case "code", "requests":
	case "join", "accept", "reject", "forget", "cancel":
		if len(o.args) != 3 {
			return fmt.Errorf("%s 需要配对码或 ID", sub)
		}
		switch sub {
		case "join":
			q.Data["code"] = o.args[2]
		case "accept", "reject":
			q.Op = "pair.respond"
			q.Data["id"] = o.args[2]
			q.Data["allow"] = sub == "accept"
		case "cancel":
			q.Data["id"] = o.args[2]
		case "forget":
			q.Peer = o.args[2]
		}
	default:
		return fmt.Errorf("未知配对命令 %s", sub)
	}
	var result json.RawMessage
	if err := ipc(p, q, &result); err != nil {
		return err
	}
	if sub != "join" || o.flags["detach"] {
		return output(result, o)
	}
	var joined struct {
		ID      string `json:"id"`
		Expires int64  `json:"expires"`
	}
	if err := json.Unmarshal(result, &joined); err != nil {
		return err
	}
	if !o.flags["json"] {
		fmt.Fprintln(os.Stderr, "请在对方设备确认配对请求；等待批准…")
	}
	for {
		select {
		case <-ctx.Done():
			_ = ipc(p, Request{Op: "pair.cancel", Data: map[string]any{"id": joined.ID}}, nil)
			return ctx.Err()
		case <-time.After(time.Second):
		}
		var state struct {
			Status string `json:"status"`
		}
		if err := ipc(p, Request{Op: "pair.result", ID: joined.ID}, &state); err != nil {
			return err
		}
		if state.Status == "paired" {
			return output(map[string]any{"status": "paired", "id": joined.ID}, o)
		}
		if state.Status != "pending" {
			return fmt.Errorf("配对未完成: %s", state.Status)
		}
		if joined.Expires > 0 && time.Now().UnixMilli() > joined.Expires {
			return fmt.Errorf("配对请求已过期")
		}
	}
}

func service(o options, p Paths, profile string) error {
	if runtime.GOOS != "linux" {
		return errors.New("用户服务安装仅支持 Linux；当前系统可使用 xcopy serve")
	}
	if len(o.args) != 2 {
		return fmt.Errorf("用法: xcopy service install|status|start|stop|restart|uninstall")
	}
	sub := o.args[1]
	unit := "xcopy.service"
	if profile != "default" {
		unit = "xcopy-" + profile + ".service"
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, _ := os.UserHomeDir()
		configHome = filepath.Join(home, ".config")
	}
	dir := filepath.Join(configHome, "systemd/user")
	path := filepath.Join(dir, unit)
	command := func(args ...string) error {
		c := exec.Command("systemctl", append([]string{"--user"}, args...)...)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		return c.Run()
	}
	switch sub {
	case "install":
		if _, err := loadConfig(p); err != nil {
			return err
		}
		binary, err := os.Executable()
		if err != nil {
			return err
		}
		binary, err = filepath.EvalSymlinks(binary)
		if err != nil {
			return err
		}
		quote := func(s string) string { return strconv.Quote(strings.ReplaceAll(s, "%", "%%")) }
		content := "[Unit]\nDescription=xcopy file transfer client\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=" + quote(binary) + " --profile " + profile + " serve\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n"
		for _, key := range []string{"XCOPY_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"} {
			if value := os.Getenv(key); value != "" {
				content += "Environment=" + quote(key+"="+value) + "\n"
			}
		}
		content += "\n[Install]\nWantedBy=default.target\n"
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			return err
		}
		if err := command("daemon-reload"); err != nil {
			return err
		}
		args := []string{"enable"}
		if o.flags["start"] {
			args = append(args, "--now")
		}
		args = append(args, unit)
		if err := command(args...); err != nil {
			return err
		}
		fmt.Println("用户服务已安装。脱离 SSH 和开机自动运行需要管理员执行：sudo loginctl enable-linger", os.Getenv("USER"))
		return nil
	case "status", "start", "stop", "restart":
		return command(sub, unit, "--no-pager")
	case "uninstall":
		if err := command("disable", "--now", unit); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return command("daemon-reload")
	}
	return fmt.Errorf("未知 service 命令 %s", sub)
}
