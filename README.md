# Mochimono

A cozy cloud home for your files.

Mochimono syncs folders to one deduplicated library while remembering where every file came from. Original folder structure stays intact, and optional offline backups can restore files without the server.

## Current

- automatic one-way folder sync
- exact SHA-256 deduplication
- original device, path, filename, and mtime provenance
- Agent-generated image and video previews
- server-stored previews with browser caching and local fallback generation
- browser metadata cache for instant search, filters, and sorting
- grid, list, folder, timeline, and Inbox views
- Keep, Delete, and Delete + Ignore
- native folder picker in the local Agent
- offline backup folders with verification, repair, and restore
- encrypted peer-to-peer friend backups without port forwarding
- primary object integrity scrubbing and damaged-copy quarantine
- cancellable sync and backup jobs

Local deletion never deletes the cloud copy.

## Development

Requires Node.js 22.16+.

```bash
npm install
npm run dev
```

`npm run dev` first runs `git pull --ff-only`, then starts:

```text
Library    http://127.0.0.1:8642
Agent      http://127.0.0.1:8643
Friend UI  http://127.0.0.1:8644  local management only
Signaling  http://127.0.0.1:8645/friend-signal
Token      dev
Data       ./dev-data
```

Run separately with:

```bash
npm start
npm run agent
```

Server settings:

```text
MOCHIMONO_TOKEN
MOCHIMONO_DATA
MOCHIMONO_SCRUB_DAYS           primary SHA-256 scrub interval; default 30, 0 disables automatic scrubs
MOCHIMONO_SIGNAL_HOST          signaling bind address; defaults to HOST
MOCHIMONO_SIGNAL_PORT          signaling port; default 8645
HOST
PORT
```

Agent settings:

```text
FFMPEG_PATH                    optional custom FFmpeg binary
MOCHIMONO_THUMBNAIL_WORKERS    optional local preview worker count
MOCHIMONO_SIGNAL_URL           public HTTPS signaling endpoint when not using local development
MOCHIMONO_STUN_URLS            comma-separated STUN URLs
MOCHIMONO_TURN_URLS            comma-separated TURN URLs used when direct ICE traversal fails
MOCHIMONO_TURN_USERNAME        TURN username when the URLs do not contain credentials
MOCHIMONO_TURN_PASSWORD        TURN password when the URLs do not contain credentials
```

The Agent stores its local settings in `~/.mochimono/agent.json`. Its friend-storage recovery keys and peer identities stay local to the Agent.

## Friend storage

Friend storage does not expose either Agent to the internet. In production, put the signaling service behind HTTPS (or another trusted encrypted tunnel) and point `MOCHIMONO_SIGNAL_URL` at it. Both Agents connect outbound to the Mochimono signaling service, exchange WebRTC ICE information, authenticate pinned Ed25519 device identities, and transfer encrypted objects over a reliable DataChannel. ICE tries direct peer-to-peer connectivity first. Configure TURN with `MOCHIMONO_TURN_URLS` for networks where direct NAT traversal fails. TURN credentials can be included in each TURN URL or supplied with `MOCHIMONO_TURN_USERNAME` and `MOCHIMONO_TURN_PASSWORD`.

Pairing uses a short-lived invite code. The signaling service receives only a one-way pairing identifier/verifier; the invite secret itself is not uploaded. The invite authenticates the two public device identities before they are pinned locally.

Backup contents retain their independent application encryption even though WebRTC also encrypts transport. Objects and the catalog are AES-256-GCM encrypted before transmission, and their remote object IDs are HMAC-derived opaque identifiers. The storage host never receives the recovery key, original filenames, or plaintext catalog.

Port 8644 is now only a loopback management API used by the local Agent UI. Friend object data never travels through it.

## Previews

Preview processing belongs on clients, not the storage server.

- Images are auto-oriented, resized, and encoded to WebP in-process with Sharp/libvips.
- Videos use a bundled FFmpeg binary with bounded, single-threaded workers.
- Browser-visible missing previews jump ahead of background work.
- Background discovery is throttled so large libraries stay cheap to coordinate.
- The browser batch-checks preview availability and only downloads previews that exist.
- IndexedDB is an optional local cache; cache failure never blocks display.
- Browser generation is a last-resort fallback and uploads its result for reuse.

The server does no image or video decoding. It stores small derived WebP files, metadata, and preview requests.

## Storage

Primary storage:

```text
$MOCHIMONO_DATA/
  catalog.sqlite
  objects/
  thumbs/
```

Backup folder:

```text
<folder>/.mochimono/
  drive.json
  inventory.sqlite
  catalog.sqlite
  objects/
```

Friend storage folder:

```text
<folder>/.mochimono-friend/<share-id>/
  objects/
```

Derived previews are disposable and are not copied into offline backup repositories.

Mochimono never formats or partitions drives.

### Integrity

Each object is content-addressed by its SHA-256 hash. Incoming object bytes are hashed before they are accepted.

The primary store periodically scrubs active objects by rereading them and comparing their SHA-256 hashes with their object IDs. The default automatic interval is 30 days. A scrub also runs SQLite `quick_check` on the primary catalog. Objects found missing or corrupt are quarantined and no longer count as healthy Mochimono copies until repaired.

Offline backups are intentionally not scrubbed merely because a drive is connected. Use **Verify** after reconnecting an archival drive. The Agent recommends verification after about six months without a full check. Verify hashes every backup object, checks the backup SQLite inventory and catalog snapshot, and repairs when a known-good independent copy exists:

- a damaged backup object can be replaced from a healthy Mochimono copy;
- a healthy backup object can repair a primary object already identified as damaged;
- a damaged backup catalog snapshot can be refreshed from the healthy server catalog;
- damage that has no known-good remaining copy is reported instead of hidden.

Verification age is informational: an offline copy does not stop being a backup simply because it has been unplugged for a long time.

Mochimono does not add parity or Reed–Solomon data to individual objects. Its recovery model is deliberately simple: cryptographic checksums, independent copies, periodic scrubbing, and repair from a verified good copy.

## Principles

- Clients process. Storage stores. Server coordinates.
- Store identical content once.
- Preserve original provenance.
- Organization is metadata, not physical storage layout.
- Prefer simple current designs over compatibility layers or speculative abstractions.
