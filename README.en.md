# XCopy · 随传

Send text, screenshots and files between devices. Open it in your browser, no account needed, or host it on your own server.

[Try it online](https://xcopy.werfamily.fun/transfer?lang=en) · [简体中文](README.md) · [Contributing](CONTRIBUTING.md)

## Features

- **Device transfers** — Pair with a connection code, drag files, paste screenshots and send to multiple devices.
- **Share links** — Share by link or QR code, with single or multiple recipients and ZIP downloads on the receiving end.
- **Direct connections and relays** — WebRTC prefers direct connections and supports your own STUN / TURN services.
- **Browser and CLI** — Chinese and English web interfaces, plus a Go CLI for devices without a desktop.

## Quick start

Requires **Node.js 24+**.

```sh
git clone https://github.com/zwm1005/xcopy.git
cd xcopy
npm ci
npm run build
npm start
```

Open [localhost:8787](http://localhost:8787). Open the transfer page on both devices, pair with an 8-digit code and approve the request. You can also share files by link without pairing the recipient.

Use separate browsers or browser profiles to test two devices locally. Run `npm run dev` for development and refresh after each successful build.

## Self hosting

Install Docker Compose, point your domain to the server and allow TCP ports 80 / 443.

```sh
cp .env.example .env
```

Set `PUBLIC_ORIGIN` in `.env` to your HTTPS origin, such as `https://send.example.com`. Configure connectivity as needed:

| Setting | Purpose |
| --- | --- |
| `STUN_URLS` | Comma-separated STUN URLs, e.g. `stun:stun.example.com:3478` |
| `TURN_URLS` | Comma-separated TURN URLs, e.g. `turn:relay.example.com:3478?transport=udp` |
| `TURN_AUTH_MODE=shared-secret`, `TURN_SECRET` | A secret of at least 32 characters matching the TURN server; leave username and password empty |
| `TURN_AUTH_MODE=static`, `TURN_USERNAME`, `TURN_PASSWORD` | Alternatively, use a static account and leave `TURN_SECRET` empty |

No public STUN / TURN fallback is built in. Without TURN, some networks cannot connect. Static credentials are delivered to authorized clients; use a dedicated, restricted account.

```sh
docker compose config --quiet
docker compose up -d --build
```

This starts the app and Caddy, which manages HTTPS. See the [deployment guide (Chinese)](CONTRIBUTING.md#部署与发布) for bundled coturn, systemd / Nginx and configuration updates.

## Before you transfer

- Both devices must be online. Keep the sending page open while sharing. Refreshing or closing a page clears its history and unsaved received content. Offline delivery and resuming across reloads are not supported.
- Browser direct transfers have no application-level file size limit, but remain constrained by device and browser resources. TURN defaults to **50 MiB per file**, configurable with `MAX_FILE_MB`. Larger files only attempt direct connections. The [CLI has its own limits](cli/README.md).
- Pairings persist for the current browser profile. Clearing site data or ending a private session requires pairing again.

## Security and privacy

File content uses WebRTC DataChannels with **DTLS encryption**, including through TURN. The application server does not store file content, but processes device information, filenames and sizes. Receivers verify content integrity with SHA-256.

The current model relies on trusted servers and clients. Peer transport keys are not authenticated independently of the signaling server, so protection against an actively malicious signaling server is not guaranteed. A valid share link grants access to claim its files; send it only to intended recipients.

## Command-line client

Build from source with **Go 1.25+**:

```sh
cd cli
go build -o xcopy ./cmd/xcopy
./xcopy init --server https://send.example.com
./xcopy serve
```

Replace the example URL with your server. See the [English CLI guide](https://xcopy.werfamily.fun/downloads/xcopy/en.html) or the [full CLI reference (Chinese)](cli/README.md) for setup, pairing and commands.

## Development and contributing

TypeScript and native HTML / CSS on the frontend, Node.js and SQLite on the server, and Go for the CLI.

```sh
npm run check
npm test
```

Issues, pull requests and translations are welcome. See [CONTRIBUTING.md (Chinese)](CONTRIBUTING.md) for the source layout, translation guidelines and browser / TURN tests. The CLI currently uses Chinese messages.

## License

[MIT](LICENSE)
