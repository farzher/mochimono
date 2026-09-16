# Mochimono release builds

Mochimono has two release targets: a portable desktop Agent and a lightweight VPS server. Build the Agent on the same OS/architecture it will run on because it includes native media and peer-to-peer modules. The server has no npm runtime dependencies, but its release still includes the exact Node runtime used to build it, so build it for the target Linux architecture.

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

Zip the **contents of `dist/agent` together**. The recipient extracts it and double-clicks `Mochimono.cmd`. The launcher starts the Agent hidden if needed, waits for `http://127.0.0.1:8643/api/health`, then opens Mochimono in the browser. If the Agent is already running, the launcher only opens it.

No Node/npm installation is required on the recipient PC. User configuration, indexes, thumbnails, Squished renditions, and activity history live in the normal per-user Mochimono config directory rather than beside the executable.

A release should be rebuilt on each target OS/architecture instead of copying `node_modules` between platforms.

## VPS server

The VPS is intentionally a storage/catalog service, not a media-processing machine. CPU-heavy work belongs to the Agent:

- image and HEIC decoding happens on the Agent
- video frame extraction happens on the Agent
- thumbnail WebP encoding happens on the Agent
- Squishing/transcoding happens on the Agent
- the server only stores finished thumbnails/renditions and streams their bytes unchanged

If a file only exists in Cloud and needs a thumbnail, an Agent can download/stream that original, generate the preview locally, and upload the finished thumbnail. The server never falls back to decoding the media itself.

Build the server release on Linux for the target architecture:

```sh
npm ci
npm run release:server
```

The finished directory is `dist/server`. It contains its own Node runtime and **no npm runtime dependencies**: no `sharp`, `heic-decode`, `ffmpeg-static`, or `node-datachannel`. Building the server therefore does not install native media packages at all.

No Node/npm installation is required on the VPS after the release directory has been built. A typical Debian/Ubuntu deployment from inside the extracted server release is:

```sh
sudo useradd --system --home /var/lib/mochimono --shell /usr/sbin/nologin mochimono
sudo mkdir -p /opt/mochimono /var/lib/mochimono
sudo cp -a . /opt/mochimono/
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

The example deliberately disables request/response buffering for the Mochimono upstream. Large object uploads and downloads therefore stream through Nginx instead of being duplicated into proxy temp files or buffered in RAM. The upgrade headers also allow protocols that use HTTP connection upgrades.

### Small VPS resource profile

The supplied systemd unit is aimed at a small 1 GB-class VPS:

- Node old-space capped at 256 MB
- soft service pressure at 256 MB
- hard service memory ceiling at 384 MB
- no image/video decode or transcoding on the VPS
- one CPU worth of quota
- automatic restart on failure
- persistent writes restricted to `/var/lib/mochimono`

SQLite uses WAL + `synchronous=NORMAL`, and object/thumbnail bytes are streamed from disk. Normal server work should therefore mostly be SQLite queries plus file/network I/O rather than CPU-heavy media work.

## Pre-release data contract

This remains pre-release software. Disposable Agent/browser caches are reset when their schema changes instead of being migrated.

The server is different: stored server data is never silently deleted. If an incompatible development-era `catalog.sqlite` is found, the server exits with a clear message. Move/clear the old `MOCHIMONO_DATA` directory and re-import into the current schema rather than carrying development migrations into the release design.
