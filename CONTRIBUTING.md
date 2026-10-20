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

语言优先级为 `?lang=`、已保存的手动选择、浏览器首选语言。浏览器首选语言为中文（包括 `zh-CN`、`zh-TW`、`zh-HK` 等）时显示简体中文，其余或未知语言均显示英文；次选语言不覆盖首选语言。自动判断不会写入语言偏好，手动切换仍会保存。切换不刷新页面，存储或配置接口不可用时也应保持可用。服务端错误使用可选的 `messageKey/messageParams`、`reasonKey/reasonParams`，保留旧中文字段以兼容已有客户端；新增消息时同步维护 `server/message-keys.js` 和词典。

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

### WebSocket 可用性保护

以下限制按单个 Node 进程生效，不需要数据库迁移。连接配额在握手时预留，并在底层 TCP 连接关闭后释放，涵盖认证失败、异常断开及关闭握手。所有连接共用每 IP 配额；新生成密钥的设备同样受限。IPv4 与对应的 IPv4-mapped 地址共用预算，IPv6 按 /64 汇总。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WS_MAX_CONNECTIONS` | 1000 | 全局连接上限 |
| `WS_MAX_CONNECTIONS_PER_IP` | 64 | 每个来源的并发上限，包含待认证、设备和访客 |
| `WS_MAX_CONNECTIONS_PER_DEVICE` | 8 | 同一设备的标签页与 CLI 连接上限 |
| `WS_MAX_PENDING_CONNECTIONS` / `WS_MAX_PENDING_PER_IP` | 128 / 8 | 待认证连接的全局 / 来源上限 |
| `WS_MAX_GUEST_CONNECTIONS` | 256 | 已建立访客会话的全局上限 |
| `WS_GUEST_IDLE_SECONDS` | 60 | 没有关联有效分享或在途领取的访客宽限期 |
| `WS_PUBLISH_INTERVAL_MS` | 50 | 设备状态更新的合并窗口 |
| `WS_MAX_BUFFERED_KB` | 1024 | 慢客户端待发送队列上限，超过后断开 |
| `WS_MESSAGE_RATE_PER_MINUTE` / `WS_MESSAGE_BURST` | 3000 / 256 | 每来源消息总量和令牌桶突发容量 |
| `WS_RENAME_RATE_PER_MINUTE` / `WS_RENAME_BURST` | 10 / 3 | 每设备改名的补充速率和突发容量 |
| `WS_RENAME_IP_RATE_PER_MINUTE` / `WS_RENAME_IP_BURST` | 60 / 12 | 每来源改名的补充速率和突发容量 |
| `WS_TRANSFER_RATE_PER_MINUTE` / `WS_TRANSFER_BURST` | 600 / 16 | 每设备创建传输的补充速率和突发容量 |
| `WS_TRANSFER_IP_RATE_PER_MINUTE` / `WS_TRANSFER_IP_BURST` | 1800 / 48 | 每来源创建传输的补充速率和突发容量 |

限流在昂贵处理之前执行。普通传输与分享文件共用创建预算；合法的结束消息不消耗创建或改名预算，重复结束不会再次更新数据库或广播。浏览器和 CLI 根据 `RATE_LIMIT.retryAfterMs` 在 30 秒内重试创建，不重放其他变更请求。硬性消息突发超限会断开连接。

访客响应 pong 或发送无效请求不会延长宽限期。有效预览、排队和正在领取的访客保持连接，分享过期后已准入的领取仍可完成。业务结束后回收空闲访客，浏览器暂停自动重连，已接收文件仍可在当前页面保存。设备页面继续长期在线等待接收。

设备状态仅推送到受影响设备及必要的配对设备，同设备的标签页共用查询快照；心跳不查询数据库或刷新全站列表。身份认证、配对、撤销和传输授权仍同步完成，合并窗口仅影响列表显示。

基础 Compose 已映射上述变量；systemd 将需要覆盖的值加入 `/etc/suichuan/app.env`。共享出口较多时，可按实际并发调整每 IP 配额。`TRUST_PROXY=1` 必须配合受控代理覆盖来源头、禁止公网直连应用端口；横向扩容需要共享配额或在入口统一限流，不能将每进程配额视为集群配额。以上措施控制应用资源消耗，分布式洪泛仍需入口防护。

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

首页、传输页及分享领取页按 `?lang=en` / `?lang=zh-CN` 在服务端返回完整文案，禁用 JavaScript 也能读取正文、标题和描述。无有效语言参数时根据 `Accept-Language` 的最高优先级语言选择中文或英文，并返回 `Content-Language` 和 `Vary: Accept-Language`；缺失或不支持的语言使用英文。`DEFAULT_LOCALE` 保留为 canonical URL 的语言配置，不再覆盖浏览器的界面语言；其 canonical 为 `/`，另一语言保留查询参数。`sitemap.xml` 列出两种语言并提供相互对应的 `hreflang`，不列入设备传输或分享页面。页面内容对普通访问者及 Googlebot、Baiduspider、bingbot 一致。

`robots.txt` 允许抓取首页、样式、脚本和站点地图，只排除 API、WebSocket 和健康检查路径。不要使用 `Disallow: /s`，它也会阻止 `/sitemap.xml`、`/styles.css` 等资源。发送页及分享页允许读取 `noindex`，但通过 HTML 元标签与 `X-Robots-Tag` 阻止收录。

发布后可用 IndexNow 将两种语言的 canonical URL 提交给参与该协议的搜索引擎，携带当前 `/indexnow.txt` 的 key 和 `keyLocation`。HTTP 200/202 仅代表收到通知或等待验证，不代表已经收录。Google Search Console 与百度搜索资源平台仍需站点所有者完成验证后提交 `sitemap.xml`；不要使用已废弃的 sitemap ping 接口，也不要将普通网页提交到只面向特定内容类型的 Google Indexing API。

### 可选访问统计

统计默认关闭，不依赖管理平台启动。保持 `ANALYTICS_ENABLED=0` 时，页面不注入统计脚本、不请求采集接口、不创建统计 Cookie，也不连接作者的统计服务。脚本与传输代码独立；开启后，上报失败不会阻塞配对、分享和文件传输。

需要自建统计时，使用自己的管理后端和数据库：

1. 在 `wf-admin-web` 的管理数据库执行独立增量脚本 `sql/20261020_analytics_tables.sql` 与 `sql/20261020_analytics_menu.sql`，配置 Java 端 `analytics.*`。详见该项目 README 的“可选随传访问统计”。这一步不会修改随传的 SQLite 数据库。
2. 使用 Nginx 的部署可参考 [公开路由模板](deploy/aliyun/analytics.nginx.conf.example) 和[私有代理片段模板](deploy/aliyun/analytics-private.nginx.conf.example)。复制到服务器后修改 Java 私网地址、站点代码和代理密钥，在网站的 HTTPS `server` 块中 include 路由文件。私有片段须由 root 持有、权限 `600`，不得提交 Git。执行 `nginx -t` 后 reload。使用 Caddy 等代理时，须等价配置两个精确路径、请求方法和可信头；默认 Compose 不包含统计代理。
3. Java 端默认也关闭。配置独立随机代理密钥与 HMAC 密钥（每个至少 32 字符）、自己的精确 HTTPS origin 和 Nginx 出口 IP/CIDR；只允许代理机器访问 Java 端口。Nginx 必须覆盖客户端 IP 头。若前面还有 CDN，只信任该 CDN 官方地址段，不接受任意客户端的 `X-Forwarded-For`。
4. 随传 `.env` 设置 `ANALYTICS_ENABLED=1`、`ANALYTICS_PATH=/api/analytics`。重启 systemd 服务；Compose 使用 `docker compose up -d --force-recreate app`（服务名以实际配置为准）。开关在服务启动时生效，无需修改业务代码。默认路径分别为 `GET /api/analytics/bootstrap` 和 `POST /api/analytics/events`。
5. 使用独立浏览器配置打开首页，检查同源 Cookie 与 204 入库响应；管理端“随传统计”可查看数据。访问 `/analytics-privacy` 阅读说明，`/?analytics=off` 排除此浏览器，`/?analytics=on` 恢复；偏好保留 90 天。不要把管理员 Token、代理密钥或 HMAC 密钥配置到前端。

目前采集首页、传输页和领取页的 PV，以及首页进入传输页、切换设备/分享 tab 的点击。只记录归一页面、语言、来源域名、有限 UTM 字段和客户端类别；分享令牌、完整 URL、传输内容、剪贴板、文件名与文件内容均不进入事件。原始 IP 由可信代理提供，保留 30 天；明细 90 天；日汇总 13 个月。采集从开启时开始，没有历史数据回填。

停用时，将网站开关恢复 `0` 并重启，移除统计代理，然后将 Java 开关恢复 `false` 并重启。已收集的数据会保留；关闭 Java 后定时清理也停止，如需保留清理，应先只关闭网站和代理，再按保留期限清理后关闭 Java。无需删除统计表即可回退。网站、代理访问日志及数据库备份另行设置轮转期限。

埋点专项浏览器验证：`npm run build && npx playwright test test/browser/analytics.spec.js`。默认关闭与资源隔离同时由 `npm test` 验证。
