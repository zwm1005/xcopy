# 贡献指南

欢迎提交问题、修复和语言包。项目使用 Node.js 24+；CLI 开发需要 Go 1.25+。本地启动步骤见[中文 README](README.zh-CN.md#快速开始)。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `src/` | TypeScript 前端：连接、传输、分享和语言包 |
| `public/` | HTML、CSS、图标及独立第三方资源 |
| `server/` | JavaScript 服务端：身份、SQLite、WebSocket 和配置 |
| `cli/` | Go 命令行客户端 |
| `test/` | 单元、协议、类型和浏览器测试 |
| `dist/` | 构建产物，不提交 Git |

新增业务模块须加入 `server/assets.js` 精确白名单，保持浏览器模块 URL 稳定。`src/shared/device-name.js` 是前后端共用的校验模块。提交源码和 lockfile，不直接修改 `dist/`。所有 `if` 使用多行花括号。

`npm run dev` 先构建，再监听 `src/` 和 `public/`；构建成功后手动刷新页面。`npm start` 只启动已有完整产物，首次运行须先构建。

## 语言包

中英文词典位于 `src/i18n/zh-CN.ts` 和 `src/i18n/en.ts`。使用语义键及 `{参数}` 插值，调用 `t()` 时由 TypeScript 检查键和参数。HTML 使用 `data-i18n`、`data-i18n-aria-label` 等允许的属性。通过 `textContent` 输出，禁止将翻译注入 `innerHTML`；用户设备名、文件名和传输文字保持原文。

新增语言需要：

1. 添加词典，在 `src/i18n/index.ts` 注册语言和规范化规则。
2. 更新 HTML 语言选择器、配置校验、`supportedLocales` 和词典检查器。
3. 在 `onLocaleChange` 中按原状态更新动态文案；不要重建连接、传输任务或设备身份。RTL 语言需额外适配布局。
4. 检查窄屏、键盘操作、属性文案、输入焦点和切换时仍在进行的传输。

语言优先级为 `?lang=`、已保存的手动选择、`DEFAULT_LOCALE`、英文；默认配置为 `en`，不再根据浏览器语言自动切换。切换不刷新页面，存储或配置接口不可用时也应保持可用。服务端错误使用可选的 `messageKey/messageParams`、`reasonKey/reasonParams`，保留旧中文字段以兼容已有客户端；新增消息时同步维护 `server/message-keys.js` 和词典。

## 验证

在仓库根目录执行：

```sh
npm ci
npm run check
npm test
npm run test:e2e
npm run test:relay
XCOPY_BINARY=/absolute/path/to/xcopy npm run test:cli
```

- `check` 包含类型检查和词典键、插值参数检查；`test/types/contracts.ts` 中的反例须保持预期编译错误。
- 浏览器测试需要 Google Chrome。常规用例固定中文，`test/browser/i18n.spec.js` 显式验证英文。
- 中继测试需要本机 coturn，可用 `TURNSERVER_BIN` 指定；仅监听回环地址，结束后关闭。可用 `TEST_TURN_AUTH_MODE=static` 验证静态账号模式。
- CLI 测试前先构建本机二进制，并将 `XCOPY_BINARY` 替换为其绝对路径。更多选项见 [CLI 说明](cli/README.md#开发验证)。

测试入口会先构建；直接启动 `test/browser-server.js` 或 CLI 冒烟时会拒绝过期产物。公网 NAT、防火墙及外部 TURN TLS 需要在实际部署环境验证。

部署后可按需运行以下分享验收，域名须替换为实际服务地址：

```sh
node scripts/smoke-share.js https://send.example.com
node scripts/smoke-multiple.js https://send.example.com
```

`--relay` 强制中继，`--expiry` 会真实等待 10 分钟验证过期行为，`XCOPY_ARTIFACTS` 指定报告与截图目录。这些用例会在目标服务上创建测试分享和传输任务。

## 部署与发布

基础 Docker 部署步骤见[中文 README](README.zh-CN.md#自部署)。应用使用单实例维护 WebSocket 会话与任务，SQLite 持久化设备身份和配对。公开入口必须使用 HTTPS；改变域名、协议或端口会改变浏览器身份存储范围。`TRUST_PROXY=1` 只用于受控代理后，app 端口不应直接暴露公网。

### 网络配置

STUN / TURN 列表以逗号分隔，不配置时不会回退到作者或第三方服务器。仅 STUN 或空 ICE 只能连接可直达的网络。示例：

```dotenv
STUN_URLS=stun:stun.example.com:3478
TURN_URLS=turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp
TURN_AUTH_MODE=shared-secret
TURN_SECRET=replace-with-your-turn-server-secret-at-least-32-characters
```

共享密钥须与 TURN 服务端一致，`TURN_USERNAME` 和 `TURN_PASSWORD` 留空。改用 `TURN_AUTH_MODE=static` 时，填写这两个字段并清空 `TURN_SECRET`；静态凭证会下发给获准传输的客户端，应使用专用受限账号。

地址支持域名、IPv4 和方括号 IPv6；不接受 URI 内嵌账号、未知参数或非法端口。STUN 目前只接受 `stun:`。外部 TURN 支持 `turns:relay.example.com:5349?transport=tcp`，证书由 TURN 管理员配置。`FORCE_RELAY=1` 必须有有效 TURN；共享密钥凭证有效期由 `TURN_CREDENTIAL_TTL_SECONDS` 控制，默认 3600 秒，范围 3600–86400 秒。

### 可选 coturn

在公网 Linux 主机上使用仓库自带 coturn 时，设置 `TURN_EXTERNAL_IP`、`TURN_REALM` 和随机 `TURN_SECRET`，并将 `TURN_URLS` 指向该实例。自带实例仅支持共享密钥模式；密钥至少 32 字符，字符限字母、数字、下划线和连字符，应用与 coturn 必须一致。

```sh
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml up -d --build
```

覆盖文件使用 Linux host 网络。除 TCP 80 / 443 外，开放 TCP / UDP 3478 和 UDP 49160–49359；端口范围以 [turn-limits.conf](deploy/turn-limits.conf) 为准。自带实例不配置 TURN TLS；需要 `turns:` 时使用已配置有效证书的外部实例。

### 更新运行配置

修改 ICE、默认语言、CLI 下载地址或 IndexNow 配置无需重建前端，但需要更新应用进程：

- 本地：停止旧进程后运行 `npm start`。npm 命令加载 `.env`，已有进程环境变量优先；裸 `node server/index.js` 不会自动加载 `.env`。
- systemd：更新 `EnvironmentFile` 并重启；只有 unit 变化才需要 `daemon-reload`。
- Compose：先 `docker compose config --quiet`，再 `docker compose up -d --no-deps --force-recreate app`。单独 `restart` 不会更新容器环境变量。

始终沿用部署时的 `-f`、`-p` 和 `--env-file` 参数。配置校验使用 `--quiet`，避免凭证展开到日志。

自带 coturn 轮换共享密钥时，在维护窗口先停止 app，更新两端密钥，再重建 turn 和 app：

```sh
docker compose -f compose.yaml -f compose.turn.yaml stop app
# 更新 .env 中的共享密钥后执行：
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml up -d --no-deps --force-recreate turn
docker compose -f compose.yaml -f compose.turn.yaml up -d --no-deps --force-recreate app
```

回滚密钥时同样恢复两端，不能只回滚其中一端。

分享资源限制：`SHARE_CONCURRENCY` 默认 3（范围 1–3），`SHARE_QUEUE_LIMIT` 默认 20，`SHARE_GLOBAL_CLAIMS` 默认 256 个在途领取，`SHARE_WATCHER_LIMIT` 默认每份分享 200 个在线预览订阅。它们不限制累计完成次数。基础 Compose 已映射前两项；需修改后两项时，应同时添加对应的容器环境变量映射。

### 构建与 systemd 发布

构建先在临时目录编译、复制资源并校验白名单和引用闭包，成功后替换完整 `dist/`，失败保留上一份产物。Docker 使用多阶段构建，运行镜像只安装运行依赖。

[systemd](deploy/aliyun/suichuan.service)、[环境文件](deploy/aliyun/app.env.example)和 [Nginx](deploy/aliyun/nginx.conf) 模板位于 `deploy/aliyun/`，部署时替换域名、证书、运行用户及路径。完整 release 需要包含 `package*.json`、`server/`、`src/shared/`、`scripts/frontend-artifact.js` 和构建后的 `dist/`；在目标环境安装运行依赖。

切换完整 release 后重启应用，不要逐个覆盖正在服务的资源。数据库与密钥使用独立持久目录，代码回滚时保留这些数据。服务重启会使未完成传输及分享失效。

### 下载与发现端点

- `/api/client-config` 只返回默认语言、支持语言和可选 CLI 下载地址，不含 ICE 凭证；ICE 配置由获准传输的控制协议下发。
- `CLI_DOWNLOAD_URL` 为空时隐藏网页下载入口。可设置 HTTPS 下载地址，或 `/downloads/xcopy/` 并让代理提供该独立目录。自部署 CLI 初始化必须显式指定 `xcopy init --server https://send.example.com`，不要依赖历史默认服务器。
- Node 提供 `/robots.txt`、`/sitemap.xml` 和 `/indexnow.txt`，支持 GET / HEAD，使用 `no-store`。站点地图依据 `PUBLIC_ORIGIN` 生成。
- `INDEXNOW_KEY` 默认空，此时 `/indexnow.txt` 返回 404；配置值须为 8–128 位 ASCII 字母、数字或连字符。外部提交工具需携带 `keyLocation=<PUBLIC_ORIGIN>/indexnow.txt`，应用不会自动提交。
- Nginx 必须将发现端点代理到 Node，不能沿用旧版本从 `current/public` 直接读取的规则。回滚到旧版时需同时恢复旧路由及发现文件；Caddy 默认代理全部路径。

### 搜索引擎抓取

首页按 `?lang=en` / `?lang=zh-CN` 在服务端返回完整文案，禁用 JavaScript 也能读取正文、标题和描述。无语言参数时使用 `DEFAULT_LOCALE`；默认语言的 canonical 为 `/`，另一语言保留查询参数。`sitemap.xml` 列出两种语言并提供相互对应的 `hreflang`，不列入设备传输或分享页面。页面内容对普通访问者及 Googlebot、Baiduspider、bingbot 一致。

`robots.txt` 允许抓取首页、样式、脚本和站点地图，只排除 API、WebSocket 和健康检查路径。不要使用 `Disallow: /s`，它也会阻止 `/sitemap.xml`、`/styles.css` 等资源。发送页及分享页允许读取 `noindex`，但通过 HTML 元标签与 `X-Robots-Tag` 阻止收录。

发布后可用 IndexNow 将两种语言的 canonical URL 提交给参与该协议的搜索引擎，携带当前 `/indexnow.txt` 的 key 和 `keyLocation`。HTTP 200/202 仅代表收到通知或等待验证，不代表已经收录。Google Search Console 与百度搜索资源平台仍需站点所有者完成验证后提交 `sitemap.xml`；不要使用已废弃的 sitemap ping 接口，也不要将普通网页提交到只面向特定内容类型的 Google Indexing API。
