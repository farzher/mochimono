# Mochimono

Mochimono is a cloud-first personal archive: dump in files, store identical content once, remember where it came from, and know which offline drives protect it.

V1 is deliberately small: plain JavaScript, one Node server, one SQLite catalog, one filesystem object store, one browser library UI, and one local Agent web UI. There are currently no npm runtime dependencies.

## Development philosophy

Mochimono is in rapid pre-user development. Optimize for quick iteration and the smallest clean codebase that lets us use the product and learn what it should become.

- There are no users or compatibility requirements yet. Breaking changes are fine.
- Do not add migrations, version compatibility, legacy support, fallback behavior, compatibility shims, or transitional code unless explicitly requested.
- Prefer replacing or deleting an old design over preserving it alongside a new one.
- Do not spend time adding test suites, test infrastructure, or broad development verification unless explicitly requested or needed to diagnose a concrete problem.
- Keep implementations direct and minimal. Avoid abstractions, dependencies, frameworks, and generalized systems until real usage demonstrates a need for them.
- Plain JavaScript is preferred over TypeScript or additional build tooling.

Runtime integrity checks that are part of Mochimono itself, such as verifying stored file hashes, are product behavior rather than development-test overhead and should remain where they protect user data.

## Current V1 features

- SHA-256 whole-file identity and exact deduplication
- import provenance: import/source, original path, filename, and mtime
- browser search, open/download, and HTTP byte-range streaming
- Delete & Ignore so intentionally rejected exact content stays rejected on later imports
- local Agent web UI for importing folders and managing backup drives
- built-in local folder/drive browser; no CLI workflow required
- managed offline backup drives with independent SQLite inventories
- drive policies for everything or broad MIME classes (`image`, `video`, `audio`, `text`, `application`, `other`)
- server-side backup coverage by drive
- reconnect/resume: only missing objects are copied
- SHA-256 verification while writing primary and backup copies
- optional full backup-drive verification
- a fresh server catalog snapshot copied to each backup drive after update

Not implemented yet: thumbnails, AI, encryption/private vaults, chunking, packfiles, compression, native apps, virtual filesystems, automatic garbage collection, or multi-user sharing.

## Requirements

Node.js 22.16+.

## Run the server

```bash
export MOCHIMONO_TOKEN='use-a-long-random-secret'
export MOCHIMONO_DATA=/srv/mochimono
export HOST=127.0.0.1
export PORT=8642
npm start
```

On Windows PowerShell, the same settings can be set with `$env:NAME="value"`.

Open `http://127.0.0.1:8642` and enter the token to browse the library. Put an internet-facing installation behind HTTPS.

Primary storage is intentionally boring:

```text
$MOCHIMONO_DATA/
  catalog.sqlite
  objects/
    ab/
      ab...full-sha256...
```

## Run the local Agent

On the computer that has the folders and backup drives you want Mochimono to use:

```bash
npm run agent
```

The Agent opens `http://127.0.0.1:8643` in your browser. The first time, open **Agent settings** and enter the Mochimono server URL and token. Those settings are saved locally in `~/.mochimono/agent.json` (the corresponding user-profile directory on Windows).

Use the Agent UI to:

- browse local drives and folders
- choose a folder or whole drive to import
- name the import source
- watch hashing/upload progress
- initialize a drive as a Mochimono backup
- choose whether a backup drive protects everything or selected broad file classes
- update a backup with only missing objects
- see backup coverage
- optionally verify a backup drive

There is intentionally no separate operational CLI to maintain. Filesystem operations live in the local Agent and the browser UI is the normal interface.

## Backup drive format

A managed drive contains:

```text
.mochimono/
  drive.json
  inventory.sqlite
  catalog.sqlite
  objects/
```

The drive inventory and server replica catalog are separate on purpose: a drive can say what it believes it contains, while the server separately remembers what it believes is backed up there.

## Design rules for V1

One original file equals one immutable object. No chunking, compression, or second backup repository format yet. Backup disks are disaster-recovery repositories, not mirrors; live deletions are not automatically propagated to offline disks.

Add complexity only after real usage demonstrates a need for it.
