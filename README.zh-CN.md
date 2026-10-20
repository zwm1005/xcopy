# 随传 · XCopy

在设备之间发送文字、截图和文件。打开网页即可使用，无需账号，也可以部署到自己的服务器。

[在线使用](https://xcopy.werfamily.fun/transfer) · [English](README.md) · [贡献指南](CONTRIBUTING.md)

## 功能

- **设备互传**：连接码配对，支持拖放文件、粘贴截图和向多台设备发送。
- **链接分享**：生成链接或二维码，支持一次领取、多人领取和接收端打包下载。
- **直连与中继**：WebRTC 优先直连，可配置自己的 STUN / TURN 服务。
- **多端使用**：网页默认英文，可切换简体中文，Go CLI 支持无桌面环境的设备。

## 快速开始

需要 **Node.js 24+**。

```sh
git clone https://github.com/zwm1005/xcopy.git
cd xcopy
npm ci
npm run build
npm start
```

打开 [localhost:8787](http://localhost:8787)。在两端进入传输页，通过 8 位连接码配对并确认，即可发送内容；也可直接创建分享链接。

本机测试两台设备时，使用不同浏览器或浏览器配置。开发时运行 `npm run dev`，构建完成后手动刷新页面。

## 自部署

准备好域名及 Docker Compose，将域名解析到服务器并开放 TCP 80 / 443。

```sh
cp .env.example .env
```

编辑 `.env`，将 `PUBLIC_ORIGIN` 设为自己的 HTTPS 地址，例如 `https://send.example.com`。按需配置网络服务：

| 配置 | 用途 |
| --- | --- |
| `STUN_URLS` | STUN 地址，多个地址以逗号分隔 |
| `TURN_URLS` | TURN 中继地址，多个地址以逗号分隔 |
| `TURN_AUTH_MODE=shared-secret`、`TURN_SECRET` | 共享密钥认证；密钥至少 32 字符，须与 TURN 服务端一致，用户名和密码留空 |
| `TURN_AUTH_MODE=static`、`TURN_USERNAME`、`TURN_PASSWORD` | 或使用静态账号认证；此时将 `TURN_SECRET` 留空 |

没有内置的公共 STUN / TURN 备用服务；不配置 TURN 时，部分网络之间可能无法连接。静态凭证会提供给获准传输的客户端，建议使用专用受限账号。地址格式及更多配置见 [.env.example](.env.example) 和[部署说明](CONTRIBUTING.md#部署与发布)。

```sh
docker compose config --quiet
docker compose up -d --build
```

默认启动应用和 Caddy，由 Caddy 管理 HTTPS。需要同时部署 coturn，或使用 systemd / Nginx，见[部署与发布](CONTRIBUTING.md#部署与发布)。

## 可选访问统计

默认 `ANALYTICS_ENABLED=0`，不加载统计脚本、不请求采集接口、不创建统计 Cookie。开源自部署不会连接作者的统计服务。

需要 PV / UV、访问来源与 IP 明细时，可自行配置 `wf-admin-web` 管理后端、MySQL 和同源反向代理，再显式开启网站与 Java 两侧开关。启用方式、字段及保留期限见[可选访问统计](CONTRIBUTING.md#可选访问统计)。

## 使用须知

- 双方需要在线，分享期间发送页须保持打开。网页刷新或关闭会清空传输记录和未保存的接收内容；不支持离线投递或跨刷新续传。
- 网页直连不设业务文件大小上限，实际受浏览器和设备资源限制；TURN 中转默认单文件 **50 MiB**，可通过 `MAX_FILE_MB` 调整。超出中转上限的文件仅尝试直连；CLI 限制见[客户端说明](cli/README.md)。
- 配对会保留在当前浏览器配置中。清除站点数据或结束无痕会话后，需要重新配对。

## 安全与隐私

文件内容通过 WebRTC DataChannel 的 **DTLS 加密**传输，走 TURN 中继时也保持加密。应用服务端不保存文件内容，但会处理设备信息、文件名和大小等元数据。接收端使用 SHA-256 校验内容完整性。

当前安全模型依赖服务器和客户端可信，尚未实现独立于信令服务器的对端传输密钥认证，无法保证抵御恶意信令服务器的主动中间人攻击。有效分享链接等同领取凭证，请只分享给预期接收者。

## 命令行客户端

需要 **Go 1.25+** 从源码构建：

```sh
cd cli
go build -o xcopy ./cmd/xcopy
./xcopy init --server https://send.example.com
./xcopy serve
```

将示例地址替换为实际服务地址。安装、配对、收发命令和后台服务见 [CLI 使用说明](cli/README.md)。

## 开发与贡献

前端使用 TypeScript + 原生 HTML / CSS，服务端使用 Node.js + SQLite，CLI 使用 Go。

```sh
npm run check
npm test
```

欢迎提交 Issue、Pull Request 或语言包。代码结构、翻译规范及浏览器 / TURN 测试见[贡献指南](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
