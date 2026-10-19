# XCopy

[简体中文](README.md)

Send text, screenshots and files between paired devices, or create a one-time or multi-recipient share link. WebRTC prefers direct connections and can use your own TURN relay. The application server stores device identities and pairings, never transferred content. Keep both pages open and save received files before closing them.

## Run locally

Node.js 24 or newer is required.

```sh
npm ci
npm run build
npm start
```

Open http://localhost:8787. Use different browser profiles to simulate separate devices. `npm run dev` watches frontend sources and rebuilds; refresh after a successful build. `npm start` requires an existing complete build.

The frontend uses strict TypeScript, native HTML/CSS and browser ES modules. The backend remains JavaScript; the CLI remains Go. Chinese and English are included. Choose a language in the header. Selection order: `?lang=`, saved preference, browser languages, `DEFAULT_LOCALE`, Chinese. Switching does not reload the page or reset transfers, identities or drafts.

## Self hosting

Copy `.env.example` to `.env`, set `PUBLIC_ORIGIN` to your HTTPS origin, and configure your own connectivity:

- STUN only: `STUN_URLS=stun:stun.example.com:3478`; leave TURN empty. This does not guarantee connectivity across restrictive networks.
- Shared-secret TURN: set `TURN_URLS`, `TURN_AUTH_MODE=shared-secret`, and `TURN_SECRET` with at least 32 characters. Leave username/password empty.
- Static TURN: set `TURN_AUTH_MODE=static`, `TURN_USERNAME`, `TURN_PASSWORD` and `TURN_URLS`; leave the secret empty. Credentials are delivered to authorized transfer clients, so use a dedicated restricted account.

TURN examples: `turn:relay.example.com:3478?transport=udp`, `turn:relay.example.com:3478?transport=tcp`, or `turns:relay.example.com:5349?transport=tcp`. Lists are comma-separated. Bracket IPv6 addresses. No public fallback server is built in. `FORCE_RELAY=1` requires configured TURN. Shared-secret TTL defaults to 3600 seconds and accepts 3600–86400.

```sh
docker compose config --quiet
docker compose up -d --build
```

The base deployment includes app and Caddy only. To run the bundled coturn on Linux, also set `TURN_EXTERNAL_IP`, `TURN_REALM`, matching `TURN_SECRET`, and point `TURN_URLS` at it:

```sh
docker compose -f compose.yaml -f compose.turn.yaml config --quiet
docker compose -f compose.yaml -f compose.turn.yaml up -d --build
```

Bundled coturn uses shared-secret authentication and host networking. Allow HTTPS and the configured TURN ports through your firewall. The app is single-instance; its SQLite volume retains pairings. Do not expose an app trusting forwarded headers directly to the internet.

ICE and language changes do not require a frontend rebuild. Restart local/systemd processes. For Compose, run `config --quiet` then `up -d --no-deps --force-recreate app`; `restart` does not reload environment variables. Keep the same `-f`, `-p` and `--env-file` options. To rotate bundled TURN secrets: stop app, update both configurations, recreate turn, then recreate app. Roll back both ends together. Process environment takes precedence over `.env` with npm; bare Node does not load `.env` automatically.

`/api/client-config` exposes only language and optional download settings. Node serves `/robots.txt` and `/sitemap.xml` using your origin. `/indexnow.txt` returns 404 unless `INDEXNOW_KEY` is configured (8–128 ASCII letters, digits or hyphens). External submission tools must set `keyLocation=<PUBLIC_ORIGIN>/indexnow.txt`. No automatic submissions occur. Reverse proxies must forward these endpoints to Node instead of serving legacy files.

## Command-line client

Build the Go client in `cli/` and explicitly select your self-hosted server:

```sh
cd cli
go build -o xcopy ./cmd/xcopy
./xcopy init --server https://send.example.com
./xcopy serve
```

The existing CLI default server is retained for compatibility; always pass `--server` for your deployment. Use `xcopy --help` for pairing, sending and receiving commands. This migration does not translate the Go CLI itself. Web download links stay hidden until `CLI_DOWNLOAD_URL` points to your published packages or an HTTPS download page. If using `/downloads/xcopy/`, serve that independent directory in your proxy.

## Checks and release

```sh
npm run check
npm test
npm run test:e2e
npm run test:relay
XCOPY_BINARY=/absolute/path/to/xcopy npm run test:cli
```

Browser tests use Google Chrome; relay tests need coturn. Public network reachability and external TLS relay certificates require environment-specific acceptance.

Builds stage and validate a complete `dist/` before replacing the previous output. Never edit generated files or overwrite a running release piecemeal. A systemd release needs `package*.json`, `server/`, `src/shared/`, `scripts/frontend-artifact.js` and `dist/`; install production dependencies on the target. Keep database and secrets separate. Docker uses a multi-stage build with production-only runtime dependencies.

[Language contribution guide](CONTRIBUTING.md). License: MIT.
