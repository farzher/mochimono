# Backup model

Mochimono should answer one question first: **is my stuff safe?**

The normal workflow is intent-based. Set how much protection a file deserves and which storage Mochimono may rely on. Mochimono chooses where missing recovery copies go. Exact placement stays inspectable, but it is not the default backup workflow.

## Four separate concepts

### Protection

Protection is durability: how many independent recoverable copies must exist.

| UI name | Internal level | Target |
| --- | --- | --- |
| One copy | `disposable` | 1 verified copy |
| Standard | `normal` | 2 verified copies on 2 devices |
| Important | `important` | 3 verified copies, including a remote copy across 2 places |
| Critical | `critical` | 3 verified copies on 3 devices, including a remote copy across 2 places |

Standard is the default. Folders set inherited protection; individual files may override it.

A destination marked **Do not rely on** stays visible but does not satisfy protection.

### Availability

Availability is where the convenient working copy lives, for example Local + Cloud or Cloud-only.

Cloud-only is not a weaker protection level. Removing a local source is allowed only when the copies that remain satisfy the file's protection target using destinations reachable for that operation.

### Representation

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

### Destination eligibility

Eligibility answers whether Mochimono may use a destination to satisfy a protection target.

The simple control is:

- **Counts toward protection**
- **Do not rely on**

Power-user constraints can later add preferred destinations, include/exclude rules, capacity reserves, or rules such as “keep Important files here.” These belong in the same Protection planner rather than a second placement system.

## Canonical recovery picture

Protection summary, file details, automatic placement, and destructive local cleanup should agree on the same facts:

- protection target;
- whether the target is met;
- each known physical copy;
- destination/device/place;
- Original or Squished;
- verification state;
- whether the destination counts toward protection;
- why another copy is needed.

Two representations on one physical drive are one independent recovery destination.

## Automatic behavior

Background Protection:

1. inventories sources and destinations;
2. evaluates active files against inherited or overridden protection targets;
3. chooses an allowed destination that improves the missing copy/device/place/remote requirements;
4. copies and verifies the data;
5. records the recovery copy;
6. repeats until all satisfiable targets are met.

For Squished-only backup destinations, normal Protection may first place an Original. Representation reconciliation then creates and verifies the Squished version and removes that drive's Original only when another Original exists elsewhere. The verified Squished copy continues to satisfy that physical recovery slot, so Protection does not immediately recreate the Original.

Offline destinations remain remembered. Destructive actions such as freeing a local source use a stricter reachable-copy check.

## Placement policy

The old backup-drive `Everything / smart collection` scope predates automatic Protection and is not authoritative for it. New backup setup therefore does not expose that selector.

The replacement is destination eligibility inside Protection. Future placement rules must filter the same planner that performs automatic protection.

## Safety rules

- Keep at least one verified Original.
- Create and verify Squished before removing an Original from that backup.
- Never count Original + Squished on one physical device as two independent copies.
- Never count a destination marked Do not rely on.
- Never call an unverified copy protected.
- Never free a local source merely because an offline copy exists.
- Trash/deletion propagates deliberately; replication must not resurrect intentionally deleted objects.

## UI

### Storage

The Backup section leads with one health statement:

- `Everything is protected`
- `183 files need another safe copy`

It then shows protection-level counts and **Protect now**.

### Backup → Manage

The screen has four groups:

1. **Protection** — concrete targets and file counts.
2. **Folders** — inherited protection per protected source folder.
3. **Destinations** — Cloud, backup drives, and friend storage; representation and whether Mochimono may rely on each.
4. **Automatic work** — background mode.

### File details

File details show the inherited/overridden protection level, concrete target, and every known recovery copy with its Original/Squished representation.

## Remaining work

1. Retire the legacy per-drive collection scope completely and move any useful advanced placement rules into Protection.
2. Make availability (`Keep local`, `Cloud-only`, later `Automatic`) an explicit first-class control layered on top of protection.
3. Add destination capacity/preference rules for power users without making manual placement the default.
4. Add recovery-impact views such as what survives if this PC, drive, or site disappears.
