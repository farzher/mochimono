# Backup model

Mochimono should answer one question first: **is the stuff I chose to protect safe?**

Backup is intent-based. The protected universe is not "everything that happens to exist on the server." It is the union of:

- files currently belonging to protected source folders;
- files deliberately kept **Remote only**.

Everything else is outside the normal protection denominator.

## File lifecycle

Every stored object has one backup lifecycle state.

### Current

The file belongs to a protected source folder now.

Current files participate in normal backup health and automatic protection.

Before the content hash exists or the primary Mochimono copy has finished uploading, the UI may show **Preparing** or **Backing up**. Once the file is stored, its protection target is evaluated normally.

### Remote only

The file no longer has a current local source, but the user explicitly chose to keep it in Mochimono.

Remote-only files remain part of backup health and automatic protection. Removing a local source does not itself mean the file should be forgotten.

### Unlinked

The file is still stored by Mochimono but no current protected source refers to it, and the user has not chosen Remote only.

Unlinked files are a review queue, not healthy current backup. They:

- do not count in the normal protection denominator;
- are not automatically replicated as if they were still wanted;
- remain visible in Library;
- can be kept deliberately by choosing **Keep remote only**;
- can be removed through the normal delete/trash workflow.

This prevents historical server objects from silently inflating backup health.

## Protection intent

Each Agent publishes the current files in its protected source folders as protection intent.

Intent includes enough information to describe files before and after hashing:

- device;
- source root;
- relative path;
- size;
- content hash when known;
- source import identity when known.

Protection intent is the authoritative desired set for current source-backed files.

Source replica inventory is separate. It describes physical local copies that can satisfy protection; intent describes what the user currently wants protected.

## Protection

Protection is durability: how many independent recoverable copies must exist.

| UI name | Internal level | Target |
| --- | --- | --- |
| One copy | `disposable` | 1 verified copy |
| Standard | `normal` | 2 verified copies on 2 devices |
| Important | `important` | 3 verified copies, including a remote copy across 2 places |
| Critical | `critical` | 3 verified copies on 3 devices, including a remote copy across 2 places |

Standard is the default. Folders set inherited protection; individual files may override it.

A destination marked **Do not rely on** stays visible but does not satisfy protection.

## Representation

Representation is fidelity/storage cost.

- **Original** — exact bytes.
- **Squished** — smaller derived media representation.

A backup destination may use:

- **Original**
- **Original + Squished**
- **Squished only**

A verified Squished-only version counts as one recovery copy at that physical destination. It does not count as a second independent copy when an Original is on the same drive.

Before removing an Original from a Squished-only backup, Mochimono creates and verifies the Squished version and requires another verified Original elsewhere. Protection also requires at least one Original recovery copy overall.

File details disclose whether a known recovery copy is Original or Squished.

## Destination eligibility

Eligibility answers whether Mochimono may use a destination to satisfy a protection target.

The simple control is:

- **Counts toward protection**
- **Do not rely on**

Power-user constraints can later add preferred destinations, include/exclude rules, capacity reserves, or rules such as "keep Important files here." These belong in the same Protection planner rather than a second placement system.

## Canonical recovery picture

Backup summary, Library, file details, automatic placement, source cards, and destructive operations must agree on the same state:

- lifecycle: Current, Remote only, or Unlinked;
- protection target;
- whether the target is met;
- each known physical copy;
- destination/device/place;
- Original or Squished;
- verification state;
- whether the destination counts toward protection;
- why another copy is needed.

Two representations on one physical drive are one independent recovery destination.

## Backup health

The main Backup percentage is:

`protected managed files / managed files`

Managed files are Current + Remote only.

Unlinked files are shown separately as **Needs review** and never make the percentage look healthier.

Files that are still preparing/uploading remain in the managed denominator. They therefore show honestly as not yet protected instead of disappearing until upload completes.

Per-source health is derived from the same intent/protection model. A protected source should be able to say **Protected**, **Backing up**, or **Needs backup** without inventing a second set of counts.

## Automatic behavior

**Protect now** is one workflow:

1. sync/hash/upload the protected source folders;
2. publish the fresh protection intent and local source-copy inventory;
3. evaluate Current + Remote-only files against their inherited or overridden protection targets;
4. choose allowed destinations that improve missing copy/device/place/remote requirements;
5. copy and verify data;
6. record the recovery copy;
7. repeat until all satisfiable targets are met.

Background Protection uses the same planner after refreshing source inventory.

For Squished-only backup destinations, normal Protection may first place an Original. Representation reconciliation then creates and verifies the Squished version and removes that drive's Original only when another Original exists elsewhere. The verified Squished copy continues to satisfy that physical recovery slot, so Protection does not immediately recreate the Original.

Offline destinations remain remembered. Destructive operations use stricter reachable-copy checks when required.

## Safe management

Potentially destructive or protection-reducing actions explain their consequences before committing.

Examples:

- Removing a protected source explains that its files stop being Current and that existing Mochimono copies are not automatically erased. Source-less stored objects move to Unlinked review unless they were already deliberately Remote only.
- Disconnecting or forgetting a backup destination reports how many managed files would fall below their requested protection level.
- Marking a destination **Do not rely on** reports the same protection impact.
- Enabling **Squished only** states that a verified Squished copy may replace the Original on that destination once the safety conditions are met.
- Freeing a local source requires the remaining reachable copies to satisfy the protection target and requires a reachable verified Original.

## Storage UI

Actual recovery destinations belong together:

- Mochimono storage;
- backup drives;
- Friend Drives / remote peers.

Local cache is app housekeeping for previews/index metadata. It is **App storage**, not a backup destination and not a recovery copy.

## Library

Library is the file-level source of truth rather than a separate backup browser.

Every file can carry the same lifecycle/protection state used by Backup. Library exposes filters for:

- In backup;
- Current sources;
- Protected;
- Needs backup;
- Remote only;
- Unlinked.

Backup aggregate rows open those exact Library views.

File cards may show a compact status for Protected, Backing up, Needs backup, Remote only, or Needs review.

## Placement policy

The old backup-drive `Everything / smart collection` scope predates automatic Protection and is not authoritative for it. New backup setup therefore does not expose that selector.

The replacement is destination eligibility inside Protection. Future placement rules must filter the same planner that performs automatic protection.

## Safety rules

- Keep at least one verified Original in the protection model.
- Require a reachable verified Original before freeing the last local source.
- Create and verify Squished before removing an Original from that backup.
- Never count Original + Squished on one physical device as two independent copies.
- Never count a destination marked Do not rely on.
- Never call an unverified copy protected.
- Never treat Unlinked historical storage as current protection intent.
- Never automatically replicate Unlinked files.
- Never free a local source merely because an offline copy exists.
- Trash/deletion propagates deliberately; replication must not resurrect intentionally deleted objects.

## Remaining work

1. Retire the legacy per-drive collection scope completely and move any useful advanced placement rules into Protection.
2. Add destination capacity/preference rules for power users without making manual placement the default.
3. Add recovery-impact views such as what survives if this PC, drive, or site disappears.
