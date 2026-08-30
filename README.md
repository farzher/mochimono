# Mochimono

Mochimono is a cloud-first personal archive: dump in files, store identical content once, remember where it came from, and know which offline drives protect it.

V1 is deliberately small: plain JavaScript, one Node server, one SQLite catalog, one filesystem object store, one browser UI, and one local agent. There are currently no npm runtime dependencies.

## Current V1 features

- SHA-256 whole-file identity and exact deduplication
- import provenance: import/source, original path, filename, and mtime
- browser search, open/download, and HTTP byte-range streaming
- Delete & Ignore so intentionally rejected exact content stays rejected on later imports
- managed offline backup drives with independent SQLite inventories
- drive policies for everything or broad MIME classes (`image`, `video`, `audio`, `text`, `application`, `other`)
- server-side backup coverage by drive
- reconnect/resume: only missing objects are copied
- SHA-256 verification while writing primary and backup copies
- full backup-drive verification
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

Open `http://127.0.0.1:8642` and enter the same token. Put an internet-facing installation behind HTTPS.

Primary storage is intentionally boring:

```text
$MOCHIMONO_DATA/
  catalog.sqlite
  objects/
    ab/
      ab...full-sha256...
```

## Import files

```bash
export MOCHIMONO_URL='https://your-server.example'
export MOCHIMONO_TOKEN='same-secret'
node agent.js import /path/to/folder --source='Old WD drive'
```

Hashing happens on the local device. Only object bytes the server does not already know are uploaded; every accepted original path is recorded.

## Create and update a backup drive

Everything:

```bash
node agent.js backup-init /mnt/backup --name='Red 8TB'
node agent.js backup-update /mnt/backup
```

Selected broad classes:

```bash
node agent.js backup-init /mnt/offsite --name='Offsite 4TB' --types=image,application,text
node agent.js backup-update /mnt/offsite
```

A managed drive contains:

```text
.mochimono/
  drive.json
  inventory.sqlite
  catalog.sqlite
  objects/
```

The drive inventory and server replica catalog are separate on purpose: a drive can say what it believes it contains, while the server separately remembers what it believes is backed up there.

## Check a backup

```bash
node agent.js backup-status /mnt/backup
node agent.js backup-verify /mnt/backup
```

Verification re-hashes stored objects. Missing/corrupt objects are removed from the drive inventory and server replica record so the next `backup-update` repairs them from the primary copy.

## Design rules for V1

One original file equals one immutable object. No chunking, compression, or second backup repository format yet. Backup disks are disaster-recovery repositories, not mirrors; live deletions are not automatically propagated to offline disks.

```bash
npm test
```

Add complexity only after real usage demonstrates a need for it.
