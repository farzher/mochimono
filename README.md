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
- offline backup folders with verification and restore
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
Library  http://127.0.0.1:8642
Agent    http://127.0.0.1:8643
Token    dev
Data     ./dev-data
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
HOST
PORT
```

Agent preview settings:

```text
FFMPEG_PATH                    optional custom FFmpeg binary
MOCHIMONO_THUMBNAIL_WORKERS    optional local preview worker count
```

The Agent stores its local settings in `~/.mochimono/agent.json`.

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

Derived previews are disposable and are not copied into offline backup repositories.

Mochimono never formats or partitions drives.

## Principles

- Clients process. Storage stores. Server coordinates.
- Store identical content once.
- Preserve original provenance.
- Organization is metadata, not physical storage layout.
- Prefer simple current designs over compatibility layers or speculative abstractions.
