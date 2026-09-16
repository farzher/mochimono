# Mochimono release builds

Mochimono has two release targets: a portable desktop Agent and a small VPS server. Build releases on the same OS/architecture they will run on because the Agent includes native modules.

## Portable Agent

On the target PC/build machine, install Node 22.16 or newer and run:

```sh
npm ci
npm run release:agent
```

The finished directory is `dist/agent`.

### Windows

Build on Windows for a Windows release. `dist/agent` contains:

- the Mochimono Agent and web UI
- production `node_modules`, including native modules
- the exact `node.exe` used to build the release
- `Mochimono.cmd`

Zip the **contents of `dist/agent` together**. The recipient extracts it and double-clicks `Mochimono.cmd`. The launcher starts the Agent minimized, waits for `http://127.0.0.1:8643/api/health`, then opens Mochimono in the browser.

No Node/npm installation is required on the recipient PC. User configuration, indexes, thumbnails, Squished renditions, and activity history live in the normal per-user Mochimono config directory rather than beside the executable.

A release should be rebuilt on each target OS/architecture instead of copying `node_modules` between platforms.

## VPS server

The server is intentionally smaller than the Agent release. Build it on Linux:

```sh
npm ci
npm run release:server
```

The finished directory is `dist/server`. It installs only the native packages needed by the server (`sharp` and `heic-decode`); Agent-only FFmpeg and peer-to-peer native dependencies are omitted.

A typical Debian/Ubuntu deployment is:

```sh
sudo useradd --system --home /var/lib/mochimono --shell /usr/sbin/nologin mochimono
sudo mkdir -p /opt/mochimono /var/lib/mochimono
sudo cp -a dist/server/. /opt/mochimono/
sudo chown -R root:root /opt/mochimono
sudo chown -R mochimono:mochimono /var/lib/mochimono

sudo cp deploy/mochimono.env.example /etc/mochimono.env
sudo chmod 600 /etc/mochimono.env
sudo editor /etc/mochimono.env

sudo cp deploy/mochimono.service /etc/systemd/system/mochimono.service
sudo systemctl daemon-reload
sudo systemctl enable --now mochimono
```

Generate a long random `MOCHIMONO_TOKEN`; do not use the example value. Keep `MOCHIMONO_DATA=/var/lib/mochimono`. The service binds to `127.0.0.1:8642` by default so it is not directly exposed to the Internet.

### Nginx

Install Nginx, copy/adapt `deploy/nginx.conf` inside the Nginx `http` context (the normal Debian/Ubuntu `sites-enabled` location is fine), set your real `server_name`, then add TLS with your normal certificate tooling.

The example deliberately disables request/response buffering for the Mochimono upstream. Large object uploads and downloads therefore stream through Nginx instead of being duplicated into proxy temp files or buffered in RAM. The WebSocket upgrade headers also support Friend Drive signaling.

### Small VPS resource profile

The supplied systemd unit is aimed at a small 1 GB-class VPS:

- Node old-space capped at 384 MB
- soft service pressure at 384 MB
- hard service memory ceiling at 512 MB
- one CPU worth of quota
- automatic restart on failure
- persistent writes restricted to `/var/lib/mochimono`

Server-side Sharp already runs at low concurrency and with a small memory cache. SQLite uses WAL + `synchronous=NORMAL`, so normal metadata work stays light while object bytes remain streamed on disk rather than loaded into memory.

If the server legitimately needs more memory for unusually large media, raise `MemoryHigh`, `MemoryMax`, and `--max-old-space-size` together.

## Pre-release data contract

This remains pre-release software. Disposable Agent/browser caches are reset when their schema changes instead of being migrated.

The server is different: stored server data is never silently deleted. If an incompatible development-era `catalog.sqlite` is found, the server exits with a clear message. Move/clear the old `MOCHIMONO_DATA` directory and re-import into the current schema rather than carrying development migrations into the release design.
