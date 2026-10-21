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

地址支持域名、IPv4 和方括号 IPv6；不接受 URI 内嵌账号、未知参数或非法端口。STUN 目前只接受 `stun:`。外部 TURN 支持 `turns:relay.example.com:5349?transport=tcp`，证书由 TURN 管理员配置。`FORCE_RELAY=1` 必须有有效 TURN；共享密钥凭证有效期由 `TURN_CREDENTIAL_TTL_SECONDS` 控制，默认 900 秒，范围 300–86400 秒。

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

以下连接限制按单个 Node 进程生效。设备活跃时间会自动迁移至附属表，清理默认关闭。连接配额在握手时预留，并在底层 TCP 连接关闭后释放，涵盖认证失败、异常断开及关闭握手。所有连接共用每 IP 配额；新生成密钥的设备同样受限。IPv4 与对应的 IPv4-mapped 地址共用预算，IPv6 按 /64 汇总。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WS_MAX_CONNECTIONS` | 1000 | 全局连接上限 |
| `WS_MAX_CONNECTIONS_PER_IP` | 64 | 每个来源的并发上限，包含待认证、设备和访客 |
| `WS_MAX_CONNECTIONS_PER_DEVICE` | 8 | 同一设备的标签页与 CLI 连接上限 |
| `WS_MAX_PENDING_CONNECTIONS` / `WS_MAX_PENDING_PER_IP` | 128 / 8 | 待认证连接的全局 / 来源上限 |
| `WS_MAX_GUEST_CONNECTIONS` | 256 | 已建立访客会话的全局上限 |
| `WS_PENDING_TIMEOUT_SECONDS` | 15 | 待认证连接的固定期限，不随请求延长 |
| `WS_PENDING_FAIR_ADMISSION_ENABLED` | 1 | 待认证池满时按来源占用回收 |
| `WS_GUEST_PREVIEW_ENABLED` / `WS_GUEST_PREVIEW_SECONDS` | 1 / 60 | 固定预览期限及预览压力回收 |
| `WS_GUEST_IDLE_SECONDS` | 60 | 在途领取结束后的访客宽限期 |
| `WS_PUBLISH_INTERVAL_MS` | 50 | 设备状态更新的合并窗口 |
| `WS_MAX_BUFFERED_KB` | 1024 | 慢客户端待发送队列上限，超过后断开 |
| `WS_MESSAGE_RATE_PER_MINUTE` / `WS_MESSAGE_BURST` | 3000 / 256 | 每来源消息总量和令牌桶突发容量 |
| `WS_RENAME_RATE_PER_MINUTE` / `WS_RENAME_BURST` | 10 / 3 | 每设备改名的补充速率和突发容量 |
| `WS_RENAME_IP_RATE_PER_MINUTE` / `WS_RENAME_IP_BURST` | 60 / 12 | 每来源改名的补充速率和突发容量 |
| `WS_TRANSFER_RATE_PER_MINUTE` / `WS_TRANSFER_BURST` | 600 / 16 | 每设备创建传输的补充速率和突发容量 |
| `WS_TRANSFER_IP_RATE_PER_MINUTE` / `WS_TRANSFER_IP_BURST` | 1800 / 48 | 每来源创建传输的补充速率和突发容量 |

限流在昂贵处理之前执行。普通传输与分享文件共用创建预算；合法的结束消息不消耗创建或改名预算，重复结束不会再次更新数据库或广播。浏览器和 CLI 根据 `RATE_LIMIT.retryAfterMs` 在 30 秒内重试创建，不重放其他变更请求。硬性消息突发超限会断开连接。

仅预览的访客会话默认在 60 秒后休眠，重复有效预览和 pong 均不续期。领取按钮仍可使用，点击后重连并重新检查分享状态；已输入名称保留。排队和正在领取的访客保持连接，分享过期后已准入的领取仍可完成。业务结束后回收空闲访客，浏览器暂停自动重连，已接收文件仍可在当前页面保存。设备页面继续长期在线等待接收。

待认证池或访客池满时，仅回收连接至少 2 秒、来源占用比请求方高至少 2 条的候选。访客候选不得有在途领取；同等占用来源互不淘汰。被回收来源该阶段冷却 15 秒。配额仍在 TCP 实际关闭后释放，所以第一次请求可能收到 503 / BUSY，关闭完成后重试。全局 1000 条连接硬上限保持原样，不淘汰已认证设备连接；这仍需要入口防护。

设备状态仅推送到受影响设备及必要的配对设备，同设备的标签页共用查询快照；心跳不查询数据库或刷新全站列表。身份认证、配对、撤销和传输授权仍同步完成，合并窗口仅影响列表显示。

基础 Compose 已映射上述变量；systemd 将需要覆盖的值加入 `/etc/suichuan/app.env`。共享出口较多时，可按实际并发调整每 IP 配额。`TRUST_PROXY=1` 必须同时配置 `TRUSTED_PROXY_CIDRS` 并禁止公网直连应用端口；横向扩容需要共享配额或在入口统一限流，不能将每进程配额视为集群配额。以上措施控制应用资源消耗，分布式洪泛仍需入口防护。

### 可信代理来源

直连模式 `TRUST_PROXY=0` 忽略 XFF。启用代理模式必须提供精确 `TRUSTED_PROXY_CIDRS`（逗号分隔 IPv4/IPv6 CIDR），空值会阻止启动。仅可信 TCP 对端的 XFF 生效；从右向左跳过可信代理，取第一个非可信地址，再执行 IPv6 /64 聚合。转发链最多 16 跳、1024 字符，非法、空元素或全可信且无客户端边界的链会被拒绝。未提供 XFF 时使用 TCP 对端。

- systemd 模板仅信任 `127.0.0.1/32,::1/128`，Nginx 将 XFF 覆盖为 `$remote_addr`。
- Compose 为 Caddy 固定 `172.30.87.2`，应用只信任该 `/32`。如与本机网段冲突，须同时修改 `.env.example` 中的 `APP_PRIVATE_SUBNET`、`WEB_PRIVATE_IP`、`APP_PRIVATE_IP`、`APP_TRUSTED_PROXY_CIDRS`，并重建 app 与 web。
- 默认 Caddy 不信任客户端传来的 XFF。前置 CDN 时，仅将 CDN 官方地址段配置为 Caddy `trusted_proxies static ...`，启用 `trusted_proxies_strict`，并在应用 CIDR 中加入实际保留在转发链里的 CDN 代理地址段。不要配置整个私网或 `0.0.0.0/0`。若 Nginx 用 realip 模块，应仅 `set_real_ip_from` 可信 CDN 地址段、开启递归解析，再覆盖 XFF；应用仍只信任 Nginx。

### TURN 成本边界

自带镜像固定为 `coturn/coturn:4.18.0`。`TURN_MAX_BPS=81920` 对应每 allocation 每方向 80 KiB/s，`TURN_BPS_CAPACITY=10485760` 对应实例每方向 10 MiB/s，单位为 **bytes/s**。这是示例预算，不代表主机带宽或月账单保证。coturn 会预留分配带宽，设置时应满足 `峰值 allocation 数 × max-bps ≤ bps-capacity`；默认覆盖 `total-quota=128`。一个文件连接通常需要两端各一个 allocation，多个地址或候选可能更多。共享用户名继续受 `user-quota=64` 限制。调整预算后须用真实并发传输验收吞吐与拒绝率。

`no-tcp-relay` 禁止 RFC6062 任意 TCP relay，普通浏览器/CLI 通过 TCP 连接 TURN、再使用 UDP relay 的回退仍可用。特殊地址拒绝规则覆盖私网、回环、链路本地和 CGNAT；本地测试专用回环放行不可用于生产。互联网 P2P 无法用静态 `allowed-peer-ip` 完整列出合法动态对端，因此未添加虚假的允许列表。

普通传输和分享共用凭证入口；同一设备复用距过期超过 60 秒的凭证，访客新凭证同时计入发送方设备预算。默认签发预算：设备/分享发送方 `TURN_ISSUE_RATE_PER_MINUTE=60`、`TURN_ISSUE_BURST=32`，来源 `TURN_ISSUE_IP_RATE_PER_MINUTE=120`、`TURN_ISSUE_IP_BURST=64`，全局 `TURN_ISSUE_GLOBAL_RATE_PER_MINUTE=600`、`TURN_ISSUE_GLOBAL_BURST=128`。按两端需要新签发的份数原子扣减，失败不创建半成品任务，超过中继大小限制的直连任务不签发 TURN。缓存最多 4096 个身份。

短 TTL 限制旧凭证创建新 allocation 的时间，**不等于强制撤销已有 allocation**。匿名用户仍能自配对或创建分享获取中继资格；这些措施限制成本和 TCP 代理能力，无法彻底消除 UDP 滥用。静态模式的账号不会因 TTL 失效，使用外部 TURN 时须由供应商提供等价预算和特殊地址策略。

本机可重复验收：`node scripts/test-turn-security.js` 检查过期分配、RFC6062 拒绝和超额流量限速；`TURN_SECURITY_CAPACITY_ONLY=1 node scripts/test-turn-security.js` 以仅容纳一个 allocation 的测试预算验证容量拒绝；`TURN_SECURITY_DURATION_SECONDS=920 node scripts/test-turn-security.js` 验证 UDP/TCP 接入跨越 900 秒凭证有效期。浏览器慢传使用 `TEST_TURN_LONG=1 TEST_TURN_GREP='credential expiry' node scripts/test-relay.js`；CLI 慢传使用 `TEST_TURN_CLI=1 XCOPY_LONG_TURN=1 node scripts/test-relay.js`，均只访问本机。常规 `npm run test:relay` 验证批量、单次和多人分享。

代理行为可运行 `node scripts/test-proxy-source.js`，需要本机 Docker 与 Caddy/Nginx 镜像，仅发布回环端口。

### 分享列表与设备存储

`share.list` 默认 20 条，`limit` 范围 1–50，响应最多 512 KiB，返回 `nextCursor` / `hasMore`。游标绑定发送会话及查询时的历史上界，重连恢复会话后继续有效；其他标签页即使是同一设备也不能读取。`requestId` 可精确恢复创建结果，不能与分页参数混用。网页提供“加载更多分享记录”。列表单独受设备 `SHARE_LIST_RATE_PER_MINUTE=30` / `SHARE_LIST_BURST=5`、来源 `SHARE_LIST_IP_RATE_PER_MINUTE=120` / `SHARE_LIST_IP_BURST=20` 限制。旧客户端无参数调用只得到首页。

新身份在签名和连接配额校验通过后计入注册预算：来源 `DEVICE_REGISTER_IP_RATE_PER_MINUTE=5` / `DEVICE_REGISTER_IP_BURST=10`，全局 `DEVICE_REGISTER_GLOBAL_RATE_PER_MINUTE=30` / `DEVICE_REGISTER_GLOBAL_BURST=60`。已有设备认证不消耗注册预算。`DEVICES_MAX_RECORDS=100000` 为硬上限，达到时只拒绝新设备，已有身份、配对和接收仍可用；上线前应确认当前数量低于所选上限。

自动迁移只新增 `device_activity` 表及索引、触发器，保留 `devices` 四列结构。现有记录从迁移日获得完整保留期；认证和每 5 分钟在线批次更新活跃时间。默认 `DEVICE_CLEANUP_ENABLED=0`；启用后每分钟最多检查 500 条、删除超过 `DEVICE_UNPAIRED_RETENTION_DAYS=30` 天未活跃且无配对的记录，保护在线、重连宽限及未结束传输参与者。清理不会撤销配对。

首次启用清理前用 SQLite 在线备份（例如 `.backup`）保存一致性快照，不能只复制含活动 WAL 的主库文件。只读候选查询如下；运行时还会扣除在线和在途保护集合：

```sql
SELECT COUNT(*) FROM devices;
SELECT COUNT(*) FROM device_activity AS d
WHERE d.last_seen_at < (unixepoch() - 30 * 86400) * 1000
  AND NOT EXISTS (SELECT 1 FROM pairs WHERE a = d.device_id OR b = d.device_id);
```

关闭清理开关可停止删除，不能恢复已经清理的身份。原四列插入版本可读取迁移后的库，旧认证的 `INSERT OR IGNORE` 会通过触发器更新活跃时间；回滚期间不运行新清理器。旧版不记录在线批次活动；长时间回滚后重新升级，先保持清理关闭，备份后执行 `UPDATE device_activity SET last_seen_at = MAX(last_seen_at, unixepoch() * 1000)`，为存量记录重置完整保留期，再核对候选数和启用清理。若恢复备份，应评估备份后的配对变更。新增配置均已在 Compose 映射；systemd 可加入 `app.env`。

### 构建与 systemd 发布

构建先在临时目录编译、复制资源并校验白名单和引用闭包，成功后替换完整 `dist/`，失败保留上一份产物。Docker 使用多阶段构建，运行镜像只安装运行依赖。

[systemd](deploy/aliyun/suichuan.service)、[环境文件](deploy/aliyun/app.env.example)和 [Nginx](deploy/aliyun/nginx.conf) 模板位于 `deploy/aliyun/`，部署时替换域名、证书、运行用户及路径。完整 release 需要包含 `package*.json`、`server/`、`src/shared/`、`scripts/frontend-artifact.js` 和构建后的 `dist/`；在目标环境安装运行依赖。

切换完整 release 后重启应用，不要逐个覆盖正在服务的资源。数据库与密钥使用独立持久目录，代码回滚时保留这些数据。服务重启会使未完成传输及分享失效。

应用按进程缓存静态文件及其 Brotli/gzip 表示，并按语言缓存页面模板。HTML 中的入口脚本、样式和图标自动携带构建清单中的内容哈希；哈希匹配时允许一年不可变缓存，未带哈希的模块依赖使用 ETag 条件请求，内容变化后重新下载。HTML 和控制接口仍使用 `no-store`。响应按 `Accept-Encoding` 区分压缩版本，多语言 HTML 同时区分 `Accept-Language`；代理须保留 `Vary`、ETag 和缓存头。新版本或回滚均需重启应用，不能通过原地替换文件刷新进程内缓存。

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
