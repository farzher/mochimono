# Backup model

Mochimono should answer one question first: **is my stuff safe?**

The normal workflow is intent-based. People say how much protection a file deserves and which storage Mochimono may rely on. Mochimono chooses where missing recovery copies go. Exact placement remains inspectable and can gain advanced constraints later, but it is not the default backup workflow.

## Four separate concepts

Do not collapse these into one setting.

### 1. Protection

Protection is durability: how many independent recoverable copies must exist.

| UI name | Internal level | Target |
| --- | --- | --- |
| One copy | `disposable` | 1 verified copy |
| Standard | `normal` | 2 verified copies on 2 devices |
| Important | `important` | 3 verified copies, including a remote copy across 2 places |
| Critical | `critical` | 3 verified copies on 3 devices, including a remote copy across 2 places |

Standard is the default. A folder sets the inherited level; an individual file may override it.

A copy counts only if Mochimono can identify the physical destination and has enough evidence that the recovery data is intact. A destination marked **Do not rely on** remains visible but does not satisfy a protection target.

### 2. Availability

Availability is where the convenient working copy lives.

Examples:

- Local + Cloud
- Cloud-only
- Local-only source browsing

Cloud-only is **not** a weaker protection level. Removing a local source is allowed only when the copies that remain still satisfy that file's protection target using destinations reachable for the operation.

This keeps “free disk space” separate from “accept more risk.”

### 3. Representation

Representation is fidelity/storage cost.

- **Original** — exact bytes.
- **Squished** — smaller derived media representation.

A destination may store Original plus Squished for faster/smaller media use. Destructive Squished-only storage needs stronger integration with Protection before it belongs in the main Backup UI.

Required invariant for future Squished-only support:

- a verified Squished copy can satisfy one recovery-copy slot only when that destination explicitly permits reduced-fidelity recovery;
- copies are deduplicated by physical destination, so Original + Squished on one drive is still one independent destination;
- at least one verified Original must remain somewhere before an Original is removed;
- the UI must disclose when protection includes reduced-fidelity recovery copies.

### 4. Destination eligibility

Eligibility answers whether Mochimono may use a destination to satisfy a target.

The simple control is:

- **Counts toward protection**
- **Do not rely on**

Future power-user constraints can add include/exclude rules, preferred destinations, capacity reserves, or “keep Important files here.” These must be implemented in the same protection planner. There must not be a second per-drive planner with contradictory rules.

## Recovery copy model

Every file should eventually expose one canonical recovery picture:

- protection target;
- whether the target is met;
- each known copy;
- destination/device/place;
- Original or Squished;
- verified state and last verification;
- whether the copy currently counts toward protection;
- whether it is reachable now;
- why another copy is needed, if applicable.

The aggregate Backup screen is just a summary of this same model. It should never calculate “protected” differently from the per-file view.

## Automatic behavior

Background Protection should:

1. inventory reachable sources and destinations;
2. evaluate every active file against its inherited/overridden protection target;
3. choose an eligible destination that improves the missing copy/device/place/remote requirements;
4. copy and verify data;
5. update the same canonical copy inventory used by the UI;
6. repeat until all satisfiable targets are met.

When a destination is offline, Mochimono remembers its last verified copies. Offline copies may still describe durability, but destructive actions such as freeing a local source must use a stricter reachable-copy check.

## Placement policy

The current backup-drive `Everything / smart collection` scope predates automatic Protection. Automatic Protection does not currently honor it, so it must not be presented as an authoritative normal backup control.

The replacement should be destination eligibility inside the Protection planner. If a future rule says “Photos may use Archive Drive,” the planner itself must filter Archive Drive for non-photo objects. One planner owns placement.

## Safety rules

- Never remove the last verified Original because a Squished derivative exists.
- Never free a local source unless the remaining reachable copies meet the file's protection target.
- Never count two representations on one physical device as two independent copies.
- Never count a destination marked Do not rely on.
- Never call an unverified copy protected.
- Verification and recovery status must survive UI restarts and destination disconnects.
- Trash/deletion propagates deliberately; backup replication must not resurrect intentionally deleted objects.

## UI

### Storage screen

The Backup section should lead with a single health statement, for example:

- `Everything is protected`
- `183 files need another safe copy`

Below it, show protection-level counts and a single **Protect now** action. Detailed settings live under **Manage**.

### Backup → Manage

Keep four small groups:

1. **Protection** — explain the four targets and show counts.
2. **Folders** — inherited protection per protected source folder.
3. **Destinations** — Cloud, backup drives, and friend storage; show status, verification, representation, and whether Mochimono may rely on each.
4. **Automatic work** — background mode.

### File details

Show the inherited/overridden protection level with its concrete target, then every known copy. “Important” by itself is not enough; the UI should say what it means.

## Current implementation debt

Two existing systems need convergence:

1. **Backup drive scope vs Protection planner.** The old drive scope is used by legacy backup desired-file APIs, while automatic Protection chooses files independently.
2. **Squished-only vs Protection.** Compact presence is recorded in `representation_presence`; Protection currently counts original `replicas`. Removing the Original from a compact-only backup therefore removes the protection replica from its calculation even though a verified Squished copy remains.

Until those are unified, the main Backup UI should not expose controls whose promises the planner cannot keep.

## Next implementation order

1. Ship the unified Backup status/Manage UI and concrete per-file protection labels.
2. Make one canonical copy inventory representation-aware and use it for summary, file details, planning, and safe local removal.
3. Move destination eligibility into the protection planner and retire the legacy per-drive scope contract.
4. Add explicit local availability controls (`Keep local`, `Cloud-only`, later `Automatic`) on top of protection.
5. Add power-user placement constraints only after the simple automatic path is trustworthy.
6. Add recovery-focused views: what is recoverable if this PC, this drive, or this site disappears.
