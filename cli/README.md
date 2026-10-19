# xcopy 命令行客户端

`xcopy` 用于没有图形界面的 Linux、Debian、Ubuntu 和树莓派，和 [浏览器传输页面](https://xcopy.werfamily.fun/transfer) 双向传输文字与文件。首期提供 Linux amd64 / arm64 静态单文件，无需 Node.js、浏览器或桌面环境。32 位树莓派系统暂不支持；`uname -m` 应显示 `aarch64`。

## 安装与常驻

下载匹配架构的压缩包及 SHA256SUMS，先用 `sha256sum --ignore-missing -c SHA256SUMS` 校验，再解压。在解压目录运行：

```sh
sh install.sh
export PATH="$HOME/.local/bin:$PATH"
xcopy init --name walle-pi4 --receive-dir "$HOME/xcopy/inbox"
xcopy service install --user --start
sudo loginctl enable-linger "$USER"
xcopy status
```

`enable-linger` 让用户服务在退出 SSH 后继续运行，并在开机后启动。安装服务和初始化都使用普通用户；仅 `enable-linger` 需要管理员权限。无 systemd 的环境可用进程管理器运行 `xcopy serve`。升级时重新安装二进制，然后 `xcopy service restart`，身份和配对不变。

初始化时，名称优先使用 `--name`，其次保留已有配置中的名称；首次初始化默认使用系统主机名，无法读取时使用 `Linux-xxxx`。重复初始化不会自动覆盖自定义名称。

## 与浏览器配对

浏览器打开「连接设备」生成 8 位连接码，在 Linux 执行：

```sh
xcopy pair join 12345678
```

在浏览器确认设备名和指纹并允许，终端会显示配对完成。此后无需重复配对。也可用 `xcopy pair code` 生成连接码，让浏览器输入；随后运行 `xcopy pair requests` 查看请求与指纹，`xcopy pair accept 请求ID` 明确批准。使用 `reject` 拒绝请求，`pair forget 设备ID` 解除配对。

## 发送与接收

```sh
xcopy devices
xcopy send ./app.log --to 我的电脑
printf '树莓派运行正常\n' | xcopy send --stdin --to 我的电脑
xcopy transfers --follow
xcopy inbox
xcopy read 记录ID
```

`devices` 以 ● 表示在线、○ 表示离线。设备同名时使用完整 ID。浏览器选择该 Linux 设备即可发送；后台会自动接收已配对设备的内容。收到的文字也作为 UTF-8 文件保存，文件名包含时间和记录 ID。

`send` 默认等待接收方确认，成功退出码 0，失败非 0。`--detach` 只表示成功入队，应通过 `transfers` 查询是否实际送达。Ctrl+C 会取消正在等待的发送。最多同时发送 3 项，本地最多 32 个未结束任务；文件 50 MiB，文字 1 MiB。文件按 16 KiB 分块传输、流式写入与 SHA-256 校验，校验通过后原子发布；同名文件另取名称，不覆盖原文件。内容不会自动执行。

```sh
xcopy send ./archive.tar.gz --to 设备ID --detach --json
xcopy cancel 记录ID
xcopy retry 记录ID
xcopy status --json
xcopy devices --json
xcopy inbox --json
xcopy read 记录ID --raw > received.txt
```

`--json` 用于脚本；`transfers --follow --json` 每次变更输出一份完整 JSON 数组。普通 `read` 会替换终端控制字符，`--raw` 才原样输出。`retry` 为本机失败或取消的发送创建新任务；对方发来的内容需要对方重发。

## 身份、数据与服务

- 身份与配置：`~/.config/xcopy/default/`，私钥权限 0600，目录 0700。
- 最近 300 条记录：`~/.local/share/xcopy/default/history.json`。记录裁剪不删除收到的用户文件。
- 文字发送暂存：数据目录的 `outbox/`；失败任务保留暂存供重试。
- 接收目录：初始化时指定，默认 `~/xcopy/inbox`。
- 本地命令通过权限 0600 的 Unix socket 调用后台，共享一个设备身份和服务器连接。
- 后台在配置目录的 `daemon.json` 记录实际 socket 地址；cron 等环境无需设置与 systemd 相同的 `XDG_RUNTIME_DIR`。正常停止时自动清除该文件。
- 新建接收目录权限为 0700；已有接收目录保留原权限，收到的文件权限仍为 0600。
- 支持 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_RUNTIME_DIR`；`XCOPY_HOME` 用于测试隔离。
- 另一服务器使用 `--profile 名称` 创建独立配置；`init --server` 只接受 HTTPS origin，本机开发允许 localhost HTTP。

```sh
xcopy service status
journalctl --user -u xcopy -n 100 --no-pager
xcopy service restart
xcopy service stop
xcopy service uninstall
```

卸载服务不删除身份、记录和文件。修改名称、服务器或接收目录前先停止服务，再用 `init` 更新配置并启动。不要复制同一设备私钥到多台机器同时运行。

服务器只转发配对、信令与传输状态；正文由 WebRTC 加密传输，网络无法直连时可使用现有 TURN 中继。双方需要在线；断开会自动重连，但当前传输会失败，需要重新发送。此版本不提供离线投递、断点续传、目录打包和自动更新。

网络地址探测优先等待完整候选集。个别 TURN 地址探测超过 15 秒时，会先使用已获取的候选尝试连接，并继续补充后续候选；强制中继模式仍只使用中继地址。读取 `--stdin` 时也支持 Ctrl+C 或 SIGTERM 中断。

## 开发验证

Go 1.25 或以上：

```sh
go test -race ./...
go build -race -o dist/xcopy-darwin-arm64 ./cmd/xcopy  # macOS 开发机
sh build.sh
```

仓库根目录执行 `node scripts/smoke-cli.js`，会启动隔离服务与 CLI，实际驱动 Chrome 完成配对、双向文字/文件、空文件、图片、取消重试和身份持久化验证。`XCOPY_LARGE=1` 包含 50 MiB 边界文件。远端已运行后台时，可用 `XCOPY_REMOTE`、`XCOPY_REMOTE_BIN`、`XCOPY_SSH_ARGS` 指定实机；`XCOPY_FORCE_RELAY=1` 强制浏览器走 TURN。测试仅解除自己创建的配对关系，验收文件会保留在指定接收目录。
