# Mochimono

Mochimono is a cloud-first personal archive: dump in files, store identical content once, remember where it came from, and know which offline backups protect it.

V1 is deliberately small: plain JavaScript, one Node server, one SQLite catalog, one filesystem object store, one browser library UI, and one local Agent web UI.

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
- import provenance: source/import, original path, filename, and mtime
- **Inbox** for new exact content with **Keep**, **Delete**, and **Delete & Ignore** review actions
- browser library with search, source filtering, type filtering, grid/list views, image previews, paging, and file details
- per-file visibility into every known source path and every backup location that reports a copy
- **No backup copy** filter for finding live files with no known offline replica
- open/download and HTTP byte-range streaming
- local Agent web UI for importing folders and managing backup locations
- paste a filesystem path or use the operating system's native folder picker
- cancel long-running Agent operations while iterating on large imports and backups
- whole-drive imports skip Mochimono's own `.mochimono` backup internals
- unreadable folders/files do not abort an entire large import
- any writable folder can be a backup location, including a folder on the local C: drive for testing
- managed backups with independent SQLite inventories
- editable backup policies for everything or broad MIME classes (`image`, `video`, `audio`, `text`, `application`, `other`)
- backup cards show local inventory plus server-known protected/missing coverage
- reconnect/resume: only missing objects are copied
- SHA-256 verification while writing primary and backup copies
- optional full backup verification
- a fresh server catalog snapshot copied to each backup location after update
- offline **Restore to folder** that reconstructs ordinary source folder trees from a backup even if the server is unavailable

Not implemented yet: generated thumbnails, AI, encryption/private vaults, chunking, packfiles, compression, native apps, virtual filesystems, automatic garbage collection, or multi-user sharing.

## Review workflow

New exact content starts in **Inbox**. Reviewing an item gives three useful choices:

- **Keep** — mark this exact content reviewed and remove it from Inbox.
- **Delete** — remove the live copy; it can return if encountered in a future import.
- **Delete & Ignore** — remove the live copy and remember its SHA-256 so the same exact junk stays rejected on future imports.

If the same exact content appears in several imported folders, it is still one object. Once you keep that object, later duplicate references do not make it unreviewed again.

## Requirements

Node.js 22.16+.

## Fast local development

For normal V1 iteration, run everything locally with one command:

```bash
npm run dev
```

This starts both the server and Agent already connected to each other:

```text
Library  http://127.0.0.1:8642   token: dev
Agent    http://127.0.0.1:8643
Data     ./dev-data/
```

`dev-data/` is intentionally disposable and ignored by Git. Stop both processes with Ctrl+C. Set `MOCHIMONO_TOKEN` before `npm run dev` if you want a different local token.

## Run the server separately

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

## Run the local Agent separately

On the computer that has the folders and backup locations you want Mochimono to use:

```bash
npm run agent
```

The Agent opens `http://127.0.0.1:8643` in your browser. The first time, open **Agent settings** and enter the Mochimono server URL and token. Those settings are saved locally in `~/.mochimono/agent.json` (the corresponding user-profile directory on Windows).

Use the Agent UI to:

- paste a local path or click **Choose…** to open the native OS folder picker
- choose a folder or whole drive to import
- name the import source
- watch hashing/upload progress and cancel an operation if needed
- choose any writable folder as a Mochimono backup location
- configure what each backup protects and change that policy later
- update a backup with only missing objects
- see local backup contents and server-known coverage directly on the backup card
- optionally verify a backup
- restore a backup into ordinary folders without needing the server online

There is intentionally no separate operational CLI to maintain. Filesystem operations live in the local Agent and the browser UI is the normal interface.

## Backup location format

A backup can be the root of a dedicated HDD, a folder on that HDD, or simply a local folder such as `C:\MochimonoBackup` while testing.

Mochimono **never formats, partitions, or erases a drive**. Initializing a backup only creates a `.mochimono` directory inside the folder you selected:

```text
<chosen backup folder>/
  .mochimono/
    drive.json
    inventory.sqlite
    catalog.sqlite
    objects/
```

The backup inventory and server replica catalog are separate on purpose: a backup location can say what it believes it contains, while the server separately remembers what it believes is backed up there.

## Offline restore

Each updated backup includes enough information to restore ordinary files without the server:

1. Open the local Agent.
2. Find the backup location and choose **Restore**.
3. Pick any destination folder.
4. Mochimono reconstructs folders under the original import/source names and verifies each object while copying it.

Existing matching files are skipped. Conflicting files are preserved and the restored copy gets a short content-hash suffix. The backup itself is never modified.

## Design rules for V1

One original file equals one immutable object. No chunking, compression, or second backup repository format yet. Offline backups are disaster-recovery repositories, not mirrors; live deletions are not automatically propagated to them.

Add complexity only after real usage demonstrates a need for it.
