# 随传

在直接配对的浏览器之间传文字、截图和小文件。网页免安装，无账号，支持 WebRTC 直连和自建 TURN 中继。界面沿用确认的黑白灰传输页原型。

[English](README.en.md) · [贡献与语言包](CONTRIBUTING.md)

## 本机运行

需要 Node.js 24 或以上。

```sh
npm ci
npm run build
npm start
```

打开 `http://localhost:8787` 查看介绍首页，点击“开始传输”进入 `/transfer`，也可收藏传输页直接使用。不同浏览器配置代表不同设备；同一配置的多个标签页共用身份。测试两台逻辑设备可以使用两个浏览器配置或独立无痕窗口。本机没有配置 TURN 时仅能验证可直连的网络。

首页按文字、截图、文件自动循环演示，每种类型约 6 秒，包含准备、发送、收到三个状态。可暂停/继续，点击类型或手动发送后暂停自动播放；支持键盘方向键切换类型。页面隐藏或演示离开视口时暂停计时，系统启用减少动态效果时默认暂停。首页演示不建立真实连接、不读取或创建设备身份；同域名下进入传输页继续沿用已有 IndexedDB 身份和永久配对。

端口被占用时：

```sh
PORT=18877 PUBLIC_ORIGIN=http://localhost:18877 npm start
```

## 配对与传输

1. A 点击“连接设备”，首次使用先确认本机名称；B 输入 A 的 8 位连接码，A 确认申请设备。同名设备会在接收目标和设备列表中附加标识，便于区分。
2. 在发送区选择单台在线设备，或选择「全部在线设备（N 台）」群发，输入文字、通过回形针添加附件、粘贴截图或拖入文件。
3. 接收端自动接收，完成后复制文字、复制图片或保存文件。文字保留空格、换行，不执行 HTML。图片复制在支持剪贴板图片写入的浏览器中提供，JPEG/WebP 等会转为 PNG；GIF 复制为静态图片，保留动图需保存原文件。权限受限或复制失败时仍可保存下载。
4. 配对关系不传递。A–B、A–C 配对不产生 B–C 授权。
5. 这对设备所有标签页都没有未结束任务时才可忘记配对。完成以接收端校验确认为准，无需先点击保存；失败、取消、超时也会结束任务。

默认单发，群发只包含点击发送时已经与本机直接配对且在线的设备。单发、群发和重试共用最多 3 项并发的发送队列。群发记录可展开查看各设备各项结果、取消剩余任务或重试失败项，已送达的内容不重复发送。图片记录可在页面内居中预览。

未选择过接收目标且只有一台设备在线时自动选择该设备；已有目标离线或配对解除时保留原选择并禁发，需手动选择其他设备，不会自动改发。页面的“服务已连接”表示已连到服务，接收设备是否在线以发送区为准。

设备私钥以不可导出的 CryptoKey 保存在 IndexedDB；公钥 SHA-256 指纹标识浏览器实例，服务端验证一次性挑战签名。同一站点、同一浏览器配置中，只要这份密钥仍在，每次打开都使用同一指纹，刷新、重开或正常升级浏览器不会主动换钥。清除站点数据、更换浏览器配置、退出无痕会话或浏览器清理存储导致密钥丢失后，需以新身份重新配对。

服务端配对关系永久保留，不因闲置或连接码更新而失效，只有任一端手动忘记配对才解除；忘记后双方需重新配对。失去本地密钥不会自动删除服务端的旧配对，可由另一端手动忘记旧设备。

网页文件通过 P2P 直连时不设业务大小上限；服务器 TURN 中转单文件默认最多 50 MiB（`MAX_FILE_MB` 现在仅控制中转上限）。超过中转上限的文件只提供 STUN / 直连候选，直连失败时明确提示更换网络；不会发送文件内容到 TURN。单次文字仍限 1 MiB、选择区最多 8 个文件。网页按 1 MiB 分块读取、逐块 SHA-256 校验，并将接收数据合并成 Blob，避免一次分配整文件 ArrayBuffer；可用大小仍取决于浏览器和设备资源。旧版 CLI 保留原有客户端大小限制。刷新或关闭页面清空传输记录和尚未保存的接收内容，不清除设备身份。

有未结束传输，或接收文件尚未发起下载／图片尚未成功复制时，会注册浏览器离开提醒；清空未保存文件也需确认。浏览器可能限制离开提醒（例如没有用户交互、移动端强制结束进程），它不提供持久化恢复。点击保存只表示“已发起下载”，页面无法确认磁盘保存是否成功；请在浏览器下载列表核对，取消下载后可点击“再次保存”。GIF 复制静态图片后仍保留原文件的保存提醒。

每台设备由最先连接的页面接收，避免多标签页重复接收。同一浏览器打开多个传输页时，页面会显示自己是否负责接收新内容；接收页关闭或失去连接后，服务端更新剩余页面的接收提示。切换接收页只影响后续传输，已有内容仍保留在原接收页。本功能不增加标签页未读数或修改页面标题。

传输使用有序可靠 DataChannel，16 KiB 分块、有发送背压和 SHA-256 内容校验。内容只在浏览器内存和 WebRTC 传输链路中存在，业务服务端不保存内容。短暂的控制连接断开可在 15 秒内恢复当前标签页；服务器重启或超过恢复窗口后，未完成任务需要重发。不支持跨刷新断点续传。

## 设备名称

浏览器首次访问自动生成 `Android-xxxx`、`iOS-xxxx`、`iPadOS-xxxx`、`Windows-xxxx`、`macOS-xxxx` 或 `Linux-xxxx`，无法识别时使用 `Device-xxxx`。名称在当前浏览器保存，已有名称继续保留。网页无法读取手机设置中的自定义设备名，可在设备设置或领取页手动修改。领取页的修改仅作为分享名称偏好，不改动已配对设备身份。

## 链接分享

在 `/transfer` 切换「链接分享」，将 **1–8 个文件**作为一组生成链接和二维码。文件直连不限大小、整组不再设 200 MiB 上限；走服务器中转时单个文件最多 50 MiB，有效期可选 10 / 30 / 60 分钟。接收者无需账号或配对；打开链接只是预览，点击领取才建立领取会话。

- **一次领取（默认）**：只能由一个接收页面领取；全部文件接收并校验后，链接和二维码失效。
- **多人领取**：有效期内不限累计领取次数，每个接收页面有独立进度、失败重试和完成结果。默认同时处理 3 个领取会话，其余自动排队；并行文件任务与普通设备传输共用 3 个位置。等待上限默认 20 个，满载时提示稍后重试，这不是累计人数限制。

接收设备名称在领取时固定，仅发送方和该领取者可见。其他预览者、领取者看不到对方名称或进度。禁用本地存储仍可领取和改名。统计显示“已完成 N 次领取”，不把会话数当成独立人数。

发送页必须保持打开，文件通过 WebRTC 直传，必要时使用现有 TURN，服务器不保存文件。各文件完成长度和 SHA-256 校验，接收页支持逐个保存或本地打包 ZIP。

单个领取中断后只重试该页面未完成的文件，已经校验的文件不重传；控制连接恢复宽限 15 秒。多人模式下，一个接收页面离线或取消不会结束其他领取。到期停止新的领取，已经受理（含排队）的任务可继续，每次领取从受理开始最多保留 1 小时。

“停止新领取”让已受理任务继续；“结束并中断”取消所有未完成任务，已经接收的文件仍可保存。发送方刷新、关闭后超出恢复宽限或服务器重启，会令整份分享失效。

分享结束后顶部只保留结果提示和新建入口，文件与接收详情在传输记录内展开。多人记录保留当前领取及最近 50 条结束摘要，累计完成次数持续保留。记录和未保存内容仅在当前页面保留；保存按钮表示已发起浏览器下载，不能确认磁盘保存结果。分享令牌位于 URL fragment，不新增永久配对。

服务端可配置 `SHARE_CONCURRENCY`（1–3，默认 3）、`SHARE_QUEUE_LIMIT`（默认 20）、`SHARE_GLOBAL_CLAIMS`（默认 256 个在途领取）和 `SHARE_WATCHER_LIMIT`（默认每份分享 200 个在线预览订阅）。这些限制保护当前连接和任务资源，不限制一份分享的累计完成次数。

部署验收：`node scripts/smoke-share.js https://send.example.com` 验证一次领取；`node scripts/smoke-multiple.js https://send.example.com` 验证多人、排队及重试，加 `--relay` 强制 TURN。使用 `--expiry` 对线上真实等待 10 分钟，验证单次及多人过期。用 `XCOPY_ARTIFACTS` 指定报告与截图目录。

## 语言与开发

前端使用 TypeScript strict + 原生 HTML/CSS，`tsc` 输出 ES Modules；服务端保持 JavaScript，CLI 保持 Go。页面提供简体中文和英文。语言选择顺序为 `?lang=`、已保存偏好、浏览器语言、`DEFAULT_LOCALE`、中文。切换语言不刷新页面，不重建设备身份或连接，用户输入和文件名保持原文；存储不可用时仍可使用。

`npm run dev` 先构建，再监听 `src/` 和 `public/`；构建成功后手动刷新页面。`npm start` 只启动已有完整产物，首次运行须先构建。`public/` 是静态源文件，运行页面来自 `dist/public/`。不要直接编辑 dist；业务模块 URL 仍为 `/app.js`、`/transfer.js`、`/connection.js` 等。

## 自部署

应用单实例维护 WebSocket 会话和任务，SQLite 保存设备与配对。基础 `compose.yaml` 只运行 app/Caddy，支持已有外部 STUN/TURN，也支持仅 STUN 或空 ICE；后两者只能连接可直达的网络，不能保证所有跨网连接。所有公开入口使用 HTTPS，域名、协议和端口改变会改变浏览器身份存储范围。

复制 `.env.example` 为 `.env`，设置自己的 `PUBLIC_ORIGIN=https://send.example.com`，选择一种方式：

1. 仅 STUN：`STUN_URLS=stun:stun.example.com:3478`，`TURN_URLS` 留空。
2. 外部 TURN 共享密钥：设置 `TURN_URLS=turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp`、`TURN_AUTH_MODE=shared-secret`、至少 32 字符的 `TURN_SECRET`；`TURN_USERNAME/TURN_PASSWORD` 留空。
3. 外部 TURN 静态账号：设置同样的地址以及 `TURN_AUTH_MODE=static`、`TURN_USERNAME`、`TURN_PASSWORD`，`TURN_SECRET` 留空。静态凭证会提供给获准传输的客户端，建议使用专用受限账号。TLS 中继可用 `turns:relay.example.com:5349?transport=tcp`，证书由 TURN 管理员配置。

地址列表以逗号分隔，去空白、去重，支持域名、IPv4 和方括号 IPv6。拒绝 URI 内嵌账号、非法端口和未知参数。首期 STUN 只支持 `stun:`。空值不会自动使用作者或第三方服务器。`FORCE_RELAY=1` 必须同时配置有效 TURN。共享密钥凭证有效期由 `TURN_CREDENTIAL_TTL_SECONDS` 控制，默认 3600，范围 3600–86400 秒。

```sh
docker compose config --quiet
docker compose up -d --build
```

需要本项目启动 coturn 时，额外填写 `TURN_EXTERNAL_IP`、`TURN_REALM`、共享 `TURN_SECRET`，使用覆盖文件：

```sh
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml up -d --build
```

自带 coturn 仅使用共享密钥模式；`TURN_URLS` 须指向该实例。覆盖文件使用 Linux host 网络。开放 TCP 80/443、TCP/UDP 3478 和 UDP 49160–49359；其他端口以实际 TURN 配置为准。Caddy 自动申请 HTTPS 证书。`TRUST_PROXY=1` 仅用于受控代理后，app 端口不应直接暴露公网。

配置优先级：进程环境变量高于 npm 启动命令加载的 `.env`；裸 `node server/index.js` 不加载 `.env`。systemd 使用 `EnvironmentFile`，Compose 显式映射配置。修改 ICE、语言、CLI 下载或 IndexNow 无需重新构建前端，但必须按运行方式更新进程：

- 本地：停止旧进程，再 `npm start`；检查同名进程环境变量是否覆盖 `.env`。
- systemd：更新环境文件后重启应用；只有 unit 本身变化才需要 daemon-reload。
- Compose：更新 `.env` 后先 `docker compose config --quiet`，再 `docker compose up -d --no-deps --force-recreate app`。仅 `restart` 不会更新容器环境变量。

使用了 `--env-file`、`-p`、`-f` 的部署，后续所有命令保持相同参数。自带 coturn 轮换共享密钥时，维护窗口内停止 app，更新两端密钥，重建 turn，再重建 app：

```sh
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml stop app
docker compose -f compose.yaml -f compose.turn.yaml up -d --no-deps --force-recreate turn
docker compose -f compose.yaml -f compose.turn.yaml up -d --no-deps --force-recreate app
```

回滚密钥须同时恢复 app 和 coturn，再按上述顺序重建，不能只回滚一端。配置命令使用 `--quiet` 避免将凭证展开到日志。运行时 `/api/client-config` 仅返回默认语言、支持语言和可选 CLI 下载地址，不含 ICE 凭证。STUN/TURN 参数仍由已授权的传输控制协议下发，浏览器与 CLI 共用入口。

## 发现端点与下载

Node 精确提供 `/robots.txt`、`/sitemap.xml`、`/indexnow.txt`，支持 GET/HEAD，使用 no-store。站点地图从 `PUBLIC_ORIGIN` 生成。`INDEXNOW_KEY` 默认空，端点返回 404；配置值必须是 8–128 位 ASCII 字母、数字或连字符。固定路径需要外部提交工具显式携带 `keyLocation=<PUBLIC_ORIGIN>/indexnow.txt`；本项目不会自动提交。

`deploy/aliyun/` 现为通用 systemd/Nginx 模板，须替换示例域名、证书、监听和公网 IP。Nginx 将发现路径代理到 Node，不能沿用旧版本从 `current/public` 直接读取的规则。Caddy 默认代理所有路径。旧版回滚时必须同时恢复旧 Nginx 路由和旧发现文件。

自部署未提供 CLI 下载包时页面隐藏下载入口。提供包后配置 `CLI_DOWNLOAD_URL=/downloads/xcopy/`，在代理中配置该独立目录，或使用 HTTPS 下载 URL。CLI 保留历史默认服务器行为，自部署初始化必须显式指定：

```sh
xcopy init --server https://send.example.com
```

CLI 英文说明见 [README.en.md](README.en.md#command-line-client)，完整 Go CLI 本地化另行实施。

## 构建、发布与验证

```sh
npm ci
npm run check
npm test
npm run test:e2e
npm run test:relay
# 先构建本机 CLI；通过 XCOPY_BINARY 指定它，再运行：
npm run test:cli
```

类型检查包含反向契约用例；中英文词典检查键和插值参数一致性。测试入口先构建；直接启动 `test/browser-server.js` 或本地 CLI 冒烟会拒绝过期产物。浏览器测试固定中文，国际化测试显式验证英文。`test:relay` 需要本机 coturn，可通过 `TURNSERVER_BIN` 指定；只监听回环，测试结束关闭。公网 NAT、防火墙和外部 TURN TLS 仍需部署环境验收。

构建在临时目录完成编译、资源复制、白名单和引用闭包检查，成功后替换 dist，失败保留上一份完整产物。镜像多阶段构建，运行镜像只安装运行依赖。systemd 发布也应先在构建机产生完整 release，包含 `package*.json`、`server/`、`src/shared/`、`scripts/frontend-artifact.js`、`dist/`，再安装运行依赖。不要在正在服务的 release 内逐个覆盖资源；切换完整 release 并重启应用。数据库和密钥留在独立持久目录，回滚代码不要覆盖这些数据。

- `src/`：前端类型、连接、传输、分享和语言包；`src/shared/device-name.js` 与后端共用纯校验。
- `public/`：HTML/CSS、图标和独立第三方资源源文件。
- `dist/`：生成资源和构建摘要，不提交 Git。
- `server/`：身份、SQLite、WebSocket、配置与发现端点。
- `test/`：单元、协议、类型、浏览器及国际化验收。

许可证：MIT。
