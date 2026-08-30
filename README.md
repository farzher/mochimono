# Mochimono

A cozy cloud home for your files.

Mochimono syncs folders to one deduplicated library while remembering where every file came from. Original folder structure stays intact, and optional offline backups can restore files without the server.

## Current

- automatic one-way folder sync
- exact SHA-256 deduplication
- original device, path, filename, and mtime provenance
- grid, list, folder, search, and Inbox views
- Keep, Delete, and Delete + Ignore
- native folder picker in the local Agent
- offline backup folders with verification and restore
- cancellable sync and backup jobs

Local deletion never deletes the cloud copy.

## Development

Requires Node.js 22.16+.

```bash
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

The Agent stores its local settings in `~/.mochimono/agent.json`.

## Storage

Primary storage:

```text
$MOCHIMONO_DATA/
  catalog.sqlite
  objects/
```

Backup folder:

```text
<folder>/.mochimono/
  drive.json
  inventory.sqlite
  catalog.sqlite
  objects/
```

Mochimono never formats or partitions drives.

## Principles

- Clients process. Storage stores. Server coordinates.
- Store identical content once.
- Preserve original provenance.
- Organization is metadata, not physical storage layout.
- Prefer simple current designs over compatibility layers or speculative abstractions.
