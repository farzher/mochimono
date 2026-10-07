# Backup UX redesign — proposal

Status: implementation started. This document describes the full target design; `BACKUP.md` describes shipped behavior.

### First implementation slice

Implemented:

- Library/Backup navigation; native scan/review before upload; All files defaults for new native/browser folders; labeled goals and content selection.
- Selected/unselected/One-copy/scan-unknown coverage, including browser permission/scan failures; one file Copies panel.
- Original-only goals; physical disk/partition grouping on supported Windows/Linux storage; hardware machine identity; conservative independence by explicitly confirmed physical places; unknown source-drive handling.
- Consolidated place/reliance/media controls; remembered disconnected local locations remain visible; location-impact checks fail closed.
- New local/friend replica completion waits for recovery metadata; source inventory is unverified during incomplete publication; Friend uploads verify plaintext Original hashes and require acknowledgement of an externally saved recovery key.
- Automatic pause applies to source and destination transfers; Normal source backup is independent of thumbnail-idle settings; Back up now includes browser folders and Friend destinations.
- Source/selection removal retains bytes; permanent managed deletion does not schedule working-source deletion; explicit source freeing checks the current source hash.

Focused disposable checks passed for same-disk rejection, separate-disk and off-site qualification, smaller-copy/key rejection, native pause/Normal resume, retained bytes after scope changes, and browse-only selection removal. A headless browser Backup screen was rendered and inspected. No test suite or CI was added.

Still to implement: genuine local-only backups/direct transfers, inherited subfolder/destination rules, ordinary-folder and independent recovery, history/retention/pinning, Friend recovery kits, per-file source-drive inventory, richer priority/capacity planning, and the disaster-impact view. Scoped Friend-provider deletion and raw local-index suppression/status merging also need completion. These are not advertised as already available.

## 1. The central promise

**Choose what matters. Mochimono keeps the required copies and shows exactly where they are.**

The interface should answer, without opening settings:

1. What have I chosen to back up?
2. What is deliberately not backed up?
3. Are the latest originals recoverable, and from where?
4. What needs my attention?

Minimize decisions, not information. A short interface that hides exclusions, reduced quality, or missing copies is not a simple interface; it is a misleading one.

Do not start by drawing a dashboard over the existing controls. First separate the decisions those controls currently conflate.

## 2. What exists today, and where it gets confusing

The existing foundation is useful:

- Content-hash deduplication, origin paths, local indexing, and folder sync.
- Explicit backup intent, remembered offline destinations, verification, repair, and destructive-action checks.
- Local backup repositories and encrypted Friend Drives.
- Original/Squished representation tracking.

But the UI and model need changes:

| Current issue | Consequence | Proposed direction |
| --- | --- | --- |
| Source cards use icon-only Cloud and Media/All controls | A critical decision resembles a display preference | Labeled backup intent; display filters stay separate |
| Media scope restricts the actual indexed/backed-up set | Documents can disappear from the user's mental backup picture | Show excluded file types and counts; never silently choose media-only backup |
| Local-only means browsing, not a local-drive-only backup plan | Avoiding uploads also prevents ordinary automatic protection | Allow a genuine local-only backup plan |
| Protection uploads sources to primary storage before placing additional copies | Server storage/bandwidth is effectively mandatory | Primary storage becomes a destination, not a mandatory transfer hub |
| One copy can be called protected | This may mean only the working source remains | Call it “One copy,” never ordinary “Backed up” |
| Squished copies can satisfy ordinary copy targets | A green result need not mean the originals meet the requested redundancy | Separate original protection from smaller recovery copies |
| Copy/device/place rules depend on IDs and supplied labels | Two folders on one disk, or a local server, can look more independent than they are | Use actual physical failure domains; do not infer off-site safety from a URL |
| File details have separate Where and Backup copy lists | Different inventories can appear to disagree | One canonical “Copies” panel |
| Storage, Backup settings, and friend management overlap | Users must learn several places to manage the same destination | One destination detail surface |
| Restore currently focuses on putting originals back into Mochimono | “I can recover my files if the server is gone” is not a clear user journey | Restore to an ordinary folder, including independent repository recovery |
| Old contents become an Unlinked review queue | Deleted files, replaced versions, and removed sources lack clear distinct stories | Separate history from deliberate source-removal review |

These are behavioral gaps as well as presentation gaps. Renaming controls alone will not solve them.

## 3. The user model: folders, goals, destinations, copies

### Folders: what belongs in the library

Adding a folder initially **scans locally without uploading file contents**. Then show one compact review:

- Folder name and full path.
- Contents: counts/bytes for photos, videos, documents, and other files.
- Backup selection: **All files**, **Photos & videos**, or **Choose subfolders**.
- Goal: **Browse only**, **Back up**, or **Important**.
- Estimated new backup storage and upload, excluding exact duplicates where hashes are known.
- One action: **Start backup**, or **Add for browsing**.

Default backup selection: **All files within the chosen root**. A media display filter must never change this selection.

Drag many folders in together: scan them together and present a compact list with shared settings and per-folder exceptions. Do not open a wizard for every folder. Keep unconfirmed folders visible as “Not backed up.” No automatic upload before confirmation.

If deduplication requires more hashing, say “Estimating” or show an upper bound, not a fabricated exact saving. Count unreadable and unscanned areas explicitly. Checking an inaccessible subfolder must not make it appear empty.

Loose-file drops follow the same upload review rather than silently gaining different backup semantics. They become explicitly stored files, not invented source folders.

### Goals: how safe the originals should be

Expose only three everyday choices:

| Goal | Promise | Ordinary UI |
| --- | --- | --- |
| Browse only | No automatic backup or upload | Not backed up |
| Back up | Two verified Original copies on separate physical drives/storage failure domains; at least one is a managed backup | Backed up / Needs backup |
| Important | Three verified Original copies on separate storage failure domains, including a managed off-site copy | Backed up / Needs off-site copy |

A working source may count as one Original copy while it is still known to exist. Two source folders alone do not constitute an automatic backup. Different drives on one PC can survive a drive failure, but not necessarily loss of the PC; disclose that distinction.

Advanced: custom target constraints and an explicit **One copy** archival/storage choice. Do not expose Standard/Important/Critical plus independent representation knobs as the first-run decision. Retire the existing preset ladder rather than layer new presets over it.

Goals specify originals. A smaller recovery copy is useful, but does not quietly weaken these promises.

When the required destinations do not exist, keep the requested goal and say what is missing. Never downgrade the goal to make the dashboard green.

### Destinations: where Mochimono may place backups

Treat these together:

- Server storage, with its actual name, host, physical location, and capacity.
- Local backup drives, with stable drive identity, mount path, and capacity.
- Friend Drives, with friend identity, encryption, shared quota, and availability.

A source folder is not a managed destination. A local cache is not a recovery copy. Space offered to friends is not protection for my own files.

For each backup plan, destination selection defaults to **Automatic: use the locations shown below**. This is a simple selection of allowed destinations, not a manual copy-count assignment to every drive. A folder can use a different selection when needed.

**Local only** is a destination restriction: use local backup drives; do not upload contents or full-size derivatives. It is not a synonym for Browse only. Separately describe any catalog/preview metadata the connected library sends to the server; do not promise “nothing leaves this PC” unless that is actually enforced.

### Copies: what actually exists

One physical-copy record feeds folder status, file details, dashboard, planning, and deletion checks. Include:

- Physical storage/failure domain, device, and place.
- Original or Smaller copy.
- Verified state and last verification.
- Available now or offline; last confirmed presence.
- Managed backup or working source.
- Whether it satisfies the selected goal, and why not if it does not.

A historical origin path is not evidence that a live copy still exists. Original + Smaller on the same disk is one storage failure domain. Multiple backup directories on one disk are also one domain.

## 4. A small navigation redesign

Main navigation: **Library · Backup**. Settings and Activity remain secondary. No parallel Sources/Protection/Storage dashboards.

### Library

Keep existing browsing tools. View controls such as Photos, Videos, Documents, and All files change **only the view**.

Folder and file status:

- Not backed up
- Backing up
- Backed up
- Needs backup

Add specific compact qualifiers where needed: “Offline copy,” “Smaller copies only,” or “Scan incomplete.” Do not compress all of these into one ambiguous colored dot.

Filters open the exact sets represented in Backup: Selected for backup, Needs backup, Not backed up, Stored without a source, History, and Needs review. Bulk goal changes are possible, with an impact preview.

### Backup overview

Show health first, then folders, then destinations. No large decorative percentage as the main assurance.

Example layout (illustrative numbers, not current data):

```text
Backup                                      Back up now

18,420 of 18,432 selected files backed up
12 need an off-site copy                     Review
3 folders not backed up                     Review
Last complete scan today, 10:42

Folders                                    Add folders
Photos         Important   Backed up        3 Original copies
Documents      Important   Needs backup     12 need off-site copies
Game saves     Back up     Backed up        Local only
Downloads      Browse only Not backed up

Locations                                  Add location
Photo drive    Connected   640 GB used / 1.4 TB available
Server         Connected   180 GB used / 320 GB available
Alex's drive   Offline     75 GB stored · last seen yesterday
```

“All selected files backed up” is acceptable only when the scan is complete and the latest selected versions meet the goal. Always keep the separate “Not backed up” count visible. Never say “Everything is safe” while only a selected subset is being measured.

One meaningful attention list groups problems by action, not by thousands of individual errors:

- Connect Photo drive — 240 pending files.
- Add off-site storage — 12 Important files.
- Server has insufficient space — 32 GB needed.
- Allow folder access — latest contents unknown.
- Save the Friend Drive recovery kit.
- Review files from a removed source.

Scan freshness and byte-copy integrity are different. An offline verified archive is remembered; an unreadable source means current contents are unknown, not fully checked. Background backup being paused is visible beside the last successful update.

### Folder detail

One page/drawer, not several dialogs:

1. Goal and current result.
2. Backup selection, exclusions, and selected/not-selected counts.
3. “Where” rows: actual originals and smaller copies, missing copies, availability.
4. Destination selection, with “Local only” where applicable.
5. Last complete scan/update; current work or blockage.
6. History and Restore.

Common action: change the goal. Advanced actions: subfolder exceptions, specific destinations, excludes by pattern, and one-copy/custom goals.

Use a tree with inherited settings. Selecting a saves folder inside a game installs a simple subfolder rule, not a generated pile of extension filters. New files inherit their parent; unrelated new siblings do not silently enter a choose-subfolders plan.

### File detail

Replace duplicate inventories with one **Copies** section:

```text
Original protection: 2 of 3 · Needs an off-site Original

This PC        C:\Photos\trip.jpg          Original · seen today
Photo drive    E:\Mochimono                Original · verified today
Alex's drive   Offline · last seen Monday  Smaller copy · verified Monday
```

Then show inherited goal (“Important — from Photos”), an override action, history, and restore. Keep origin history separate from recovery copies. If a file has no backups, say that even if a preview is visible.

### Destination detail

One surface for contents, capacity/limit, connection, last backup, verification, restore, and placement settings. “What is here?” opens the actual file list filtered to that destination and representation.

Default: automatic placement, originals, explicit space reserve, no eviction. Advanced: permitted folder plans, maximum storage, preference, and extra smaller copies. Show overlap as well as exclusive copies before removing a destination.

On setup, ask where the destination physically lives: **Same PC/home**, **Another place**, or **Unknown**. Server hostnames and peer networking do not establish off-site safety. A drive moved between places retains its drive identity but its place can change.

Friend storage I offer goes in a distinct “Space shared with friends” subsection, not among my recovery locations.

## 5. Mixed folders, duplicates, bandwidth, and unequal capacity

### Clean folders

Photos: All files + Important. This retains sidecars, RAW files, edits, and documents alongside images. “Photos & videos” is an explicit alternative with excluded contents visible.

Documents: All files + Important. A media-first gallery must not imply media-first backup.

### Messy folders and installed apps

Keep the broad folder browseable. Choose the saves/projects/personal subfolders for backup; leave reinstallable program files outside the backup plan.

Offer recognizable junk candidates only as review suggestions. Do not silently exclude files because they look like caches or app data; save files can live there too. Pattern rules belong in Advanced, with a preview of affected paths.

Excluding a file stops future automatic backup; it does not erase an existing copy. Historical copies and associated storage remain visible until deliberately cleaned up.

### Exact duplicates

Store identical bytes once **per managed destination**, preserving all source paths for reconstruction. Do not create extra logical backup objects for duplicate folders. Do not count ten duplicates on one disk as ten independent copies.

If the same bytes occur in folders with different goals, use the strongest included goal and union of allowed destinations; explain “Also required by Photos.” Excluding a path never suppresses another included path. A byte-identical file that is selected for a server-backed plan may still be uploaded despite another occurrence being local-only; disclose that during review. “Do not transmit these bytes anywhere” would be a separate strict content restriction, not an ordinary folder exclusion.

Similar photos, edits, re-encodes, and lookalike videos are not exact duplicates. Never delete or merge these automatically. Only associate a smaller rendition with its Original when the relationship is recorded or explicitly confirmed.

Duplicate cleanup is optional and separate from protection. Removing a local duplicate is a filesystem action; deleting a deduplicated library object can affect many paths. The dialog must distinguish them.

### Placement and limited space

Use one planner for foreground and background work:

1. Refresh source intent without treating disconnected/unreadable folders as deleted.
2. Prioritize files with no managed Original backup.
3. Within that urgency, prioritize Important over ordinary plans.
4. Fill missing Original redundancy and off-site requirements.
5. Place optional smaller copies only after required originals are handled.

Choose only allowed destinations, and only copies that advance the target. Prefer local transfer and already-available bytes over redundant network transfer, while preserving required off-site placement. Deterministic preferences are enough; no generalized optimizer is needed initially.

When destinations have different sizes, they need not contain identical libraries. Show which folders/files each actually protects. A small friend quota can hold Important documents while a large local drive holds the whole selected library.

Capacity planning includes metadata, encryption overhead, reserves, retained history, and temporary working space. Where estimates are uncertain, show that uncertainty. Unknown capacity is not unlimited capacity.

No silent eviction, target downgrading, or Original-to-Squished conversion when storage fills. Stop affected work, continue other feasible work, and show the exact shortfall and useful actions. Initial capacity support is limits/reserves and clear blockage, not automatic eviction.

Before starting a plan, show expected new upload and destination usage. Deduplicate before transmission. “Local only” must bypass the primary upload path. Low-impact/paused backup, upload-rate limit, and pause-on-metered-network controls affect scheduling, not the protected-file denominator. Metered detection is offered only where reliable; otherwise provide an explicit pause control.

## 6. Originals and smaller media copies

Use **Original** and **Smaller copy** in backup management. The creative/media tool may keep the name Squish, but explain once that its smaller copies can lose quality. Ordinary lossless packaging is not the same as a lossy re-encode.

Defaults:

- Originals are the backup promise.
- Previews are disposable; they never count as recovery copies.
- Do not automatically create Original + Smaller everywhere.
- Optional smaller copies have a separate stated purpose: portable/offline viewing or additional reduced-quality recovery.

If a user wants a smaller-copy-only destination, expose it as an advanced setting with the actual effect: “Originals will not be stored here.” It cannot satisfy an Original target. Files that cannot be reduced do not disappear from that destination's accounting.

Replacing a managed Original with a smaller copy requires verification of the smaller copy **and** the remaining Original target to stay satisfied. Never touch the user's source bytes during representation management. Budget conversion scratch space; do not require staging an entire Original backup on a destination meant only for smaller copies.

If only smaller copies survive, make that exceptional state explicit and allow recovering them. Do not describe it as Original recovery. Show restored size/quality and distinguish the rendition hash from its Original's hash.

Keep quality controls and visual comparison in the media tool, not in every backup setup. Per-file processing results feed the same copy inventory. No automatic near-duplicate deletion or speculative “best quality” detection.

## 7. File changes, history, deletion, and recovery

### Versions and missing sources

Separate three cases that currently risk being folded into Unlinked:

- A changed/deleted file inside an active backup plan: **History**.
- A source deliberately removed from Mochimono: **Needs review**.
- A file deliberately retained without a working source: **Stored without a source**.

Proposed initial history policy: retain replaced/deleted Original versions for 30 days after a confirmed successful scan, and allow “Keep” to pin a version. Show the deadline and history storage separately. This is a proposed new product behavior, not an existing guarantee.

History consumes quota and must follow the folder's destination restrictions. An expired version is eligible for cleanup only when no current path, other history entry, or pin needs those bytes. Offline copies may delay physical cleanup; show pending cleanup rather than claim reclaimed space.

A failed/incomplete scan, missing drive, permission loss, or temporarily disconnected browser folder is not proof of deletion. Do not alter the desired set or start retention expiry based on those conditions.

Turning backup off or removing a source does not erase managed copies. Show affected paths, resulting protection, and what remains stored. Offer Keep stored or Review later; make deletion separate.

Freeing local space is another separate action. Require reachable, verified remaining Originals satisfying the goal and recoverable folder metadata. Explain any changed recovery availability.

### Restore first, not restore as an afterthought

Restore entry points: Backup overview, folder/file detail, and destination detail.

Small flow:

1. What: file, folder, or stored library; current or available history date.
2. From: available verified copies, with Original/Smaller clearly labeled.
3. To: an ordinary destination folder; restore to a new folder by default.
4. Preview: bytes, paths, conflicts, unavailable files, and reduced-quality files.
5. Restore, verify restored bytes, and report omissions.

Do not overwrite working files by default. Reconstruct original paths without materializing duplicates inside the repository; users can choose which source trees to restore. Full machine/OS images and application-consistent database snapshots are outside this file-backup scope. Changing/open files must be settled or retried rather than falsely reported complete.

A local repository must be recoverable without a live primary server. A Friend Drive needs its saved recovery kit and an available peer, not the lost PC's configuration. Smaller-copy recovery must work too before such copies are marketed as recoverable. Existing restores that re-import into Mochimono remain a secondary explicit action, not the only recovery workflow.

### Recovery metadata and keys

A backup is recoverable bytes **plus** filenames/paths/catalog and any necessary keys. Verify metadata integrity, not just object hashes. Publish copy completion only after the destination's catalog/manifest can recover the recorded objects; incomplete metadata writes remain incomplete work.

Friend Drive setup includes **Save recovery kit**. The kit includes the decryption key and the identity/connection information needed to locate and reconnect to the backup. Track whether the user saved it; do not confuse acknowledgment with a successful recovery check. Never upload the secret to the storage host or expose it in ordinary logs.

Show “Encrypted to Alex; Alex cannot read your files” only for the existing application-encrypted friend path. Do not imply the same confidentiality guarantee for ordinary server/local storage. Local encryption is a separate future decision, not a cosmetic lock icon.

### Dangerous actions

Use scoped, consequence-based wording:

- Stop backing up this folder.
- Remove this location from the plan.
- Delete this local path.
- Move this file to library Trash.
- Permanently delete all managed copies.

Show the number of affected files, remaining Originals, and whether off-site protection is lost. In a deduplicated library, disclose other affected paths. Repository purge should not delete working source paths by default; source deletion requires a separate explicit selection. Deferred deletion on offline destinations stays visible, and replication must not resurrect intentionally purged data.

These are distinct operations, not variants of one ambiguous Delete button.

## 8. Confidence should come from evidence

Useful assurances:

- Latest complete scan and last completed backup.
- Per-folder selected, excluded, pending, and unknown counts.
- Actual verified Original copies by physical destination.
- Separate online availability and remembered offline protection.
- Last integrity check, corruption/repair state, and metadata recoverability.
- Explicit remaining Original protection versus optional smaller-copy coverage.

Provide one “What if this is lost?” view from a destination/device/place. Evaluate loss of a disk, this PC, or a place against the same copy model. Show separately: originals recoverable, smaller copies only, and no recovery copy. Include keys/catalog requirements. Unknown physical placement must yield unknown disaster coverage, not invented confidence.

This is more useful than introducing another score or protection tier. It can come after the main UI and failure-domain model are in place.

## 9. Implementation sequence

Ship vertically, replacing existing surfaces rather than adding another layer of DOM decorators.

### A. Honest status and shared vocabulary

- One canonical copy/status response for dashboard, folder, file, destination, and impact checks.
- Separate original protection, smaller-copy coverage, availability, and scan completeness.
- Resolve physical-drive identity and known device/place grouping; expose unknowns.
- Labeled source settings; separate display filters from backup selection.
- Visible Not backed up count; no unqualified “Everything is protected.”
- Consolidated file Copies panel and honest restore limitations.

This immediately improves trust without claiming unimplemented local-only backup or history.

### B. Folder setup and backup plans

- Scan/review before upload, multi-folder review, counts and estimates.
- Browse only / Back up / Important goals with inherited subfolder rules.
- Folder detail as the single editor for intent, content selection, and destinations.
- Persist the selected plan independently of whether primary content exists.
- Local-only backup flow: copy directly from known-good sources to local repositories.
- Primary/server and Friend Drives participate in the same placement rules; direct transfers must still verify hashes.

Do not show a functional “Local only backup” option until the data path enforces it.

### C. Unified Backup and destination management

- Overview, grouped attention list, consolidated destination setup/details.
- Explicit quota/reserve controls and shortages; predictable priority/preference ordering.
- Upload cost preview and scheduling controls.
- Friend recovery-kit workflow; offered space kept separate.
- Remove the old backup collection scope and duplicated settings/hidden-card action routing.

### D. Recovery and history

- Restore selected originals to a new ordinary folder.
- Independent local repository recovery and Friend Drive recovery from a kit.
- Support and verify Smaller-copy recovery.
- Distinguish current versions, retained history, stored files, and source-removal review.
- Add the proposed retention/pinning behavior and scoped deletion actions.

Capacity includes history when this behavior ships; don't advertise rollback before then. Until recovery metadata is complete, do not count a destination as a fully recoverable backup.

### E. Optional efficiency and disaster view

- Opt-in smaller-copy destination plans with safe, goal-aware Original removal.
- Advanced folder destination restrictions and preferences where actual usage needs them.
- Disk/device/place loss view.
- Optional local duplicate cleanup, never automatic.

No automatic eviction, advanced rotation schemes, generalized policy language, parity subsystem, or near-duplicate merging in the initial redesign. These would distract from making today's core backup paths understandable and trustworthy.

### Likely implementation touchpoints

- `agent-web/backup-center.js`, `storage-source-controls.js`, `storage-locations-ui.js`, `folder-modes.js`, `source-exclusions.js`: replace overlapping controls/surfaces.
- `web/file-info.js`, `protection-actions.js`, `protection-indicators.js`, `source-folder-scope.js`: consume the shared state and separate view scope.
- `protection-server.js`, `lib/protection-agent.js`: goals, copy/failure-domain evaluation, scan-safe intent, destination restrictions, priority.
- `lib/agent-sync.js`, `lib/browse-folders.js`, `lib/local-locations.js`: staged folder setup, selection, local-only transfer inputs.
- `lib/representation-reconciler.js`, `representation-policy-server.js`: goal-aware Original retention and separate reduced-quality coverage.
- `lib/restore.js`, `lib/agent-backups.js`, `lib/friend-storage.js`: recoverability, independent restore, metadata completion, friend kit, smaller copies.
- History needs deliberate path/version associations and retention; existing provenance alone is not a complete versioning UX.

Use plain JavaScript and existing repository services. Replace old models directly; do not introduce compatibility paths or a generalized backup framework. Update `BACKUP.md` as each behavioral slice actually ships.

## 10. Manual walkthroughs that define success

Use a small disposable folder set and temporary repositories, not a new test suite:

1. Add Photos, Documents, random duplicates, and a game folder together. Nothing uploads before review. Sidecars/documents do not silently disappear.
2. Back up only game saves to a local drive. No Original/full-size rendition upload to the server or friends occurs.
3. Add exact duplicates across roots. One object per destination, all paths restorable, goals do not weaken.
4. Use large local, smaller server, and tiny friend storage. Important/no-backup files get priority; shortages remain visible without downgrading goals.
5. Put two repositories on one disk and run a server on the source disk. Neither makes independent-drive coverage look better.
6. Unplug a backup, disconnect a source, deny browser-folder permission, and interrupt scanning. Remember verified backups, but never infer source deletion or scan completion.
7. Keep a smaller image/video copy on a destination. It never turns missing Original redundancy green; its own recovery works and reports reduced quality.
8. Change/delete a file, remove a source, stop a plan, and free local space. Each produces its own clear consequence and retention/review state.
9. Restore a folder into a new directory with the server unavailable. Recover exact paths and bytes from the repository; do not depend on missing primary content.
10. Recover a Friend Drive using only the saved kit and the available peer. Lose or corrupt an object/catalog and show repair or an explicit unrecoverable result.

## 11. Recommended decisions to approve before implementation

1. Original-only promises for Back up and Important; smaller copies are separately disclosed.
2. Local scan/review before upload; All files by default when enabling folder backup.
3. Real local-only backups, not merely browse-only sources.
4. Three everyday goals, one Backup surface, one canonical Copies panel.
5. No silent eviction, junk exclusion, target downgrades, or lossy replacement.
6. Restore to ordinary folders and independent recovery are core features.
7. The proposed 30-day history default, once history/recovery is implemented.

The largest tradeoff is intentional: safe originals cost more than counting Squished copies as equivalent backups. Users can still choose cheaper storage and reduced-quality extra copies, but the interface must show exactly what that choice protects.
