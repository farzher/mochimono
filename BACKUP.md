# Backup model

Mochimono should answer one question first: **is the stuff I chose to protect safe?**

Backup is intent-based. The protected universe is not "everything that happens to exist on the server." It is the union of:

- files currently belonging to protected source folders;
- files deliberately kept **Remote only**.

Everything else is outside the normal protection denominator.

## Adding files

Drag-and-drop has two predictable meanings:

- dropping a **folder** into Library or Sources adds it as a persistent **Local** Source;
- native folder setup scans locally, then reviews a goal and file selection before uploading;
- new folders default to **All files**; browser-handle drops are indexed locally without automatic Original uploads;
- labeled folder controls distinguish **Browse only**, **Back up**, and **Important** from the files included;
- **Photos & videos only** is an explicit selection and warns that documents and other files are not backed up;
- changing Library display filters does not change folder backup selection;
- dropping **loose files** into Library is a one-time managed add;
- successfully added loose files are intentional **Remote only** files unless they also belong to a current protected Source.

Sources therefore means folders Mochimono can continue reading from, whether they are Local-only or backed up. One-time loose files stay in Library rather than becoming fake Sources.

## File lifecycle

Every stored object has one backup lifecycle state.

### Current

The file belongs to a protected source folder now.

Current files participate in normal backup health and automatic protection.

Before the content hash exists or the primary Mochimono copy has finished uploading, the UI shows pending coverage, such as **Waiting for backup**. Once the file is stored, its protection target is evaluated normally.

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

Protection is Original durability: how many independent verified Original copies must exist. Smaller media copies are displayed separately and do not satisfy Original protection.

The overview reports selected files, browse-only folders, deliberately trashed/ignored source contents, One copy goals, and incomplete/unavailable folder checks separately. It never calls an unchecked latest source or a deliberately unselected folder fully backed up.

| UI name | Internal level | Target |
| --- | --- | --- |
| One copy | `disposable` | 1 verified Original storage domain; no redundancy promise |
| Back up | `normal` | 2 independent Original storage domains, including a managed backup |
| Important | `important` | 3 independent Original storage domains, including a managed off-site Original across 2 explicitly named places |
| 3 + off-site | `critical` | Same Original requirements as Important |

Back up is the default when enabling backup. Folders set inherited protection; individual files may override it. Browse only requests no automatic backup. One copy remains an explicit lower target and is not labeled Backed up.

Physical disk identities group partitions and directories/repositories on the same disk, including server storage on the source disk. Windows uses physical disk UniqueId, with volume-serial checks to invalidate cached mappings after drive changes. Linux uses available physical block-device WWID/serial information; ambiguous virtual/network storage stays unidentified. Machine grouping uses a supported hardware UUID, never a hostname or user-visible device name.

Explicitly named, genuinely different physical places also prove independence. Unidentified managed storage is grouped conservatively: several paths at one place do not imply extra drives, and unplaced known disks can overlap unidentified storage. An unidentified source inventory does not inherit its PC’s place as proof of where its file bytes live. Per-file source-drive inventory is still needed for multi-drive/unsupported sources.

Physical places are explicitly named in Backup/location settings, with existing names suggested. Hostnames, URLs, and Friend Drive pairing do not establish off-site safety. Connected, identified local drives use this PC’s place; remembered disconnected locations can be assigned separately. The latest confirmed place follows a known physical disk across repository aliases.

Source inventory is not counted as verified while a multi-batch publication is incomplete. New local/friend backup replicas are not reported complete until their recovery metadata has been saved. Encrypted copies require acknowledgement that their recovery key is saved outside this PC; this is not an automated recovery-kit validation.

A destination marked **Do not rely on** stays visible but does not satisfy protection.

## Representation

Representation is fidelity/storage cost.

- **Original** — exact bytes.
- **Squished** — smaller derived media representation.

A backup destination may use:

- **Original**
- **Original + Squished**
- **Squished only**

A verified Squished version is an extra smaller copy, not an Original protection copy. Original + Squished on one disk never provides independent redundancy.

Before removing an Original from a Squished-only backup, Mochimono creates and verifies the Squished version and requires the **entire remaining Original protection target** to stay satisfied.

Backup location settings expose Originals and Originals + smaller copies. Existing smaller-only settings are disclosed, but new smaller-only setup is not offered before independent smaller-copy recovery is implemented. Current Restore re-imports Originals into Mochimono; it is not yet standalone folder or smaller-copy recovery.

File details use one Copies panel for the Original target, all known physical copies, smaller representations, verification, and known source paths.

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

Smaller copies never replace a missing Original protection slot. Representation reconciliation may remove a managed Original only when the remaining Originals still satisfy the full goal. If that is not possible, the Original remains.

Newly placed local/friend replica records are published after the repository catalog or encrypted catalog/manifest has been saved. A failed metadata save must not turn freshly copied bytes into a completed backup.

Offline destinations remain remembered. Destructive operations use stricter reachable-copy checks when required.

## Safe management

Potentially destructive or protection-reducing actions explain their consequences before committing.

Examples:

- Removing a protected source explains that its files stop being Current and that existing Mochimono copies are not automatically erased. Source-less stored objects move to Unlinked review unless they were already deliberately Remote only.
- Disconnecting or forgetting a backup destination reports how many managed files would fall below their requested protection level.
- Marking a destination **Do not rely on** reports the same protection impact.
- Changing smaller-media placement keeps Original protection separate and revokes destructive retention before returning to additive/original storage.
- Freeing a local source requires the remaining reachable copies to satisfy the protection target and requires a reachable verified Original. The source’s actual content hash is checked before moving it to Trash.

## Storage UI

Actual recovery destinations belong together:

- Mochimono storage;
- backup drives;
- Friend Drives / remote peers.

Local cache is app housekeeping for previews/index metadata. It is **App storage**, not a backup destination and not a recovery copy.

## Library

Library is the file-level source of truth rather than a separate backup browser.

Every file can carry the same lifecycle/protection state used by Backup. Library exposes filters for:

- Selected for backup;
- Current sources;
- Backed up;
- Needs backup;
- Not backed up;
- Stored without a source;
- Needs review.

Backup aggregate rows open those exact Library views.

File cards may show Backed up, One copy, Waiting for backup, Needs backup, Not backed up, Stored without a source, or Needs review.

## Automatic backup

Automatic backup is On or Paused. Paused stops automatic Original source uploads and additional local/Friend placement; locally indexing folders remains possible. Explicit Back up now overrides the pause. Work scheduling is automatic: focused Mochimono windows run promptly; unattended indexing, previews, hashing, and backups wait for 60 seconds of inactivity and low CPU use. Work yields between items and transfer chunks when activity returns; media workers use low process priority. Browser folders participate in the Backup screen’s manual action before destination placement starts.

Friend Drive setup requires saving the recovery key outside this PC before upload. Full recovery-kit export and standalone recovery remain unfinished.

## Placement policy

The old backup-drive `Everything / smart collection` scope predates automatic Protection and is not authoritative for it. New backup setup therefore does not expose that selector.

The replacement is destination eligibility inside Protection. Future placement rules must filter the same planner that performs automatic protection.

## Safety rules

- Require the requested independent Original redundancy, including a managed backup for Back up/Important.
- Smaller copies never make missing Original redundancy look complete.
- Require a reachable verified Original before freeing the last local source.
- Create and verify Squished before removing an Original from that backup, and preserve the remaining full Original target.
- Never count Original + Squished on one physical device as two independent copies.
- Never count a destination marked Do not rely on.
- Never call an unverified copy protected.
- Never treat Unlinked historical storage as current protection intent.
- Never automatically replicate Unlinked files.
- Never free a local source merely because an offline copy exists.
- Trash/deletion propagates deliberately; replication must not resurrect intentionally deleted objects.
- Permanent managed-copy deletion does not implicitly delete working source paths. Purged bytes are suppressed from automatic re-upload using the ignored-content record.

## Remaining work

The UI now has Library/Backup navigation, scan/review folder setup, labeled goals, honest selected/unselected coverage, and consolidated file/location controls. The full redesign is tracked in `BACKUP-UX-PLAN.md`.

Still required:

1. Genuine local-only backup plans and direct source-to-destination copying. Browse only is **not** a local-only backup; enabled backup still stores primary Originals.
2. Inherited subfolder rules and per-plan destination restrictions.
3. Standalone restore to ordinary folders, including independent local/friend and smaller-copy recovery.
4. Path/version history, retention, pinning, and a saved Friend Drive recovery kit.
5. Per-file physical source-drive inventory, richer capacity/priority rules, and disaster-impact views.
6. Retire the legacy per-drive collection scope completely, finish scoped deletion across Friend providers, and finish merging suppression status into raw local-index Library rows.

No history retention or standalone disaster recovery is advertised by the shipped UI yet.
