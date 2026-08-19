# Configuration History and Rollback -- Detailed Specifications

> **Status:** Draft
> **Last updated:** 2026-03-16
> **Scope:** Snapshot schema, collection targets, rollback classification, dependency ordering, locking, garbage collection, drift detection, confirmation UX, CLI, and MCP tool interfaces.

---

## Table of Contents

1. [Snapshot Manifest Schema](#1-snapshot-manifest-schema)
2. [Configuration Files Collected](#2-configuration-files-collected)
3. [Runtime State Collected](#3-runtime-state-collected)
4. [Rollback Classification Rules](#4-rollback-classification-rules)
5. [Dependency Order for Destructive Rollback](#5-dependency-order-for-destructive-rollback)
6. [Lock and Transaction Journal](#6-lock-and-transaction-journal)
7. [Garbage Collection Rules](#7-garbage-collection-rules)
8. [Disk Space Safety](#8-disk-space-safety)
9. [Drift Detection](#9-drift-detection)
10. [Confirmation Requirements by Risk Class](#10-confirmation-requirements-by-risk-class)
11. [CLI Interface](#11-cli-interface)
12. [MCP Tools Interface](#12-mcp-tools-interface)
13. [Post-Apply and Post-Restore Validation](#13-post-apply-and-post-restore-validation)

---

## 1. Snapshot Manifest Schema

Every snapshot is stored as a directory under `/var/lib/xinas/config-history/snapshots/<id>/`.
The manifest lives at `manifest.yml` inside that directory.

The store itself (`/var/lib/xinas/config-history/` and its `snapshots/`,
`baseline/`, and `state/` subdirectories) is created idempotently by the
`xinas_history` Ansible role -- directories are created only if absent -- and
is never deleted by install or re-install. A day-2 `site.yml` re-run leaves
existing snapshots, the baseline, and lock/journal state untouched. The only
things that ever remove snapshots are the library's garbage collector
(Section 7, subject to the configured retention policy, which never purges
the baseline) and explicit, doubly-confirmed operator action -- e.g. the
TUI's Config History "Replace Baseline" flow
(`SnapshotEngine.purge_and_create_baseline`) -- which is the only path that
also removes the baseline itself.

```yaml
# manifest.yml -- Full schema definition

id: string               # Format: "YYYYMMDDTHHMMSSZ-<operation>"
                         # Example: "20260316T145500Z-raid-modify"

parent_id: string|null   # ID of previous snapshot, null for baseline

timestamp: string        # ISO 8601 with timezone
                         # Example: "2026-03-16T14:55:00Z"

user: string             # OS username (from os.getlogin() or getpass.getuser())

source: enum             # One of:
                         #   installer
                         #   post_install_menu
                         #   xinas_menu
                         #   api
                         #   mcp

preset: string           # Preset name: "default", "xinnorVM", or custom

operation: enum          # One of:
                         #   install
                         #   profile_select
                         #   raid_create
                         #   raid_delete
                         #   raid_modify
                         #   fs_create
                         #   fs_delete
                         #   fs_modify
                         #   share_create
                         #   share_delete
                         #   share_modify
                         #   network_modify
                         #   nfs_modify
                         #   rollback

rollback_class: enum     # One of:
                         #   destroying_data
                         #   changing_access
                         #   non_disruptive

status: enum             # One of:
                         #   pending
                         #   applied
                         #   rolled_back
                         #   failed
                         #   partial

type: enum               # One of:
                         #   baseline
                         #   rollback_eligible
                         #   ephemeral

repo_commit: string      # Output of `git rev-parse HEAD` in repo root

playbook: string         # Relative path
                         # Example: "playbooks/site.yml"

extra_vars: dict         # Key-value pairs passed as --extra-vars to ansible-playbook

hostname: string         # Current system hostname

hardware_id: string|null # xiRAID hardware key (from xicli or gRPC)

auto_detected: bool      # Whether nvme_auto_namespace was used

checksums:
  etc_exports: string    # sha256:<hex>
  nfs_conf: string       # sha256:<hex>  (kept for back-compat; ADR-0005 superseded
                         #  it as the NFS profile target, but manual edits to the
                         #  file remain drift-worthy)
  idmapd_conf: string    # sha256:<hex>  (/etc/idmapd.conf — NFSv4 id mapping; S3)
  netplan: string        # sha256:<hex>
  # ADR-0005 effective NFS files (docs/control-path/adr/0005-nfs-profile.md);
  # empty/omitted when the file is absent or the snapshot predates these fields
  nfsd_conf: string                  # sha256:<hex>  (/etc/nfs/nfsd.conf)
  nfs_kernel_server_defaults: string # sha256:<hex>  (/etc/default/nfs-kernel-server)
  lockd_conf: string                 # sha256:<hex>  (/etc/modprobe.d/lockd.conf)
  nfs_common_defaults: string        # sha256:<hex>  (/etc/default/nfs-common)

validation:
  passed: bool
  blockers: list[string] # e.g. ["RAID 'data' has active reconstruction"]
  warnings: list[string] # e.g. ["NFS export /mnt/data has active sessions"]

diff_summary: string|null
                         # Human-readable summary
                         # Example: "Added RAID array 'backup' (RAID5, 4 drives)"
```

### Field Constraints

- `id` is globally unique and monotonically increasing by timestamp prefix.
- `id` MUST match the allowlist `^[A-Za-z0-9._-]+$` and MUST NOT contain a `..`
  path segment or be an absolute path (see "Snapshot ID and Store-Path Safety"
  below).
- `parent_id` forms a singly-linked chain. The baseline snapshot has `parent_id: null`.
- `checksums` values always use the prefix `sha256:` followed by 64 lowercase hex characters.
- `validation.blockers` is non-empty only when `validation.passed` is `false`.
- `diff_summary` is `null` for baseline snapshots.
- `timestamp` MUST be generated from a timezone-aware UTC clock (not a naive
  clock treated as UTC); the serialized form is unchanged: ISO 8601 with a
  `Z` suffix.

### Snapshot Status Lifecycle

`status` tracks where a snapshot is in its lifecycle, independently of
`type` (`baseline` / `rollback_eligible` / `ephemeral`, which governs
retention — see Section 7):

| Status | Meaning |
|---|---|
| `pending` | A pre-change snapshot has been created but the operation it precedes has not yet reached a terminal outcome. |
| `applied` | The operation the snapshot represents completed and passed post-apply validation. |
| `rolled_back` | The snapshot was the rollback target of a completed rollback/restore, or is a pre-change snapshot consumed by an auto-rollback. |
| `failed` | The operation failed, or a pre-change snapshot's forward operation failed and the snapshot is retained for forensic review. |
| `partial` | The operation partially completed and neither a clean `applied` nor a clean `rolled_back` state could be reached. |

Every transactional operation (`requirements.md` §17) creates an **ephemeral
pre-change snapshot** before executing. That snapshot MUST NOT remain
indefinitely without a terminal status: the transactional runner MUST move
it to a terminal status (`applied`, `rolled_back`, or `failed`, as
appropriate to the outcome) once the operation it precedes concludes, so
that garbage collection and the startup stale-ephemeral cleanup (§7.3) can
reclaim it. An ephemeral snapshot that never reaches a terminal status is a
lifecycle bug: it is structurally excluded from the count/age-based purge
in §7.2 (which only considers `rollback_eligible`-type snapshots), and the
ephemeral-specific cleanup path in §7.3 cannot reclaim it either. See
`requirements.md` §3 and §18 for the requirement-level statement of this
contract.

### Snapshot ID and Store-Path Safety

Snapshot ids are generated in the `YYYYMMDDTHHMMSSffffffZ-<operation>` form
(microsecond-resolution timestamp + operation slug), so they remain unique
even when two snapshots are created within the same wall-clock second — for
example, a pre-change snapshot immediately followed by the applied
snapshot for the same operation.

Regardless of how an id is produced, any code path that turns a snapshot id
into a filesystem path (store reads, writes, or deletes) MUST validate the
id against the allowlist `^[A-Za-z0-9._-]+$` and MUST reject an id
containing a `..` path segment or an absolute path, before joining it onto
the store root. This is defense-in-depth: ids are normally derived from the
internal id generator and never taken directly from untrusted input, but
the store MUST NOT rely on that as its only safeguard.

`list_snapshots` (and any other enumeration consumed by the CLI, TUI, or
MCP layer) MUST NOT return an uncommitted snapshot. A crash between writing
a snapshot's files into a temporary staging directory and the atomic rename
into its final `snapshots/<id>/` location MUST NOT surface that staging
directory as a real snapshot — the listing MUST skip `.tmp-*` staging
directories (and/or require an explicit committed marker), so a
partially-written directory is never mistaken for a completed one.

---

## 2. Configuration Files Collected

Each snapshot directory contains copies of the Ansible role defaults and templates that define the system's desired state, plus the live configuration overlay (see [docs/superpowers/specs/2026-08-18-preset-overlay-design.md](../superpowers/specs/2026-08-18-preset-overlay-design.md) §5, §10).

| Snapshot File | Source Path | Role | When Collected |
|---|---|---|---|
| `common.defaults.yml` | `collection/roles/common/defaults/main.yml` | common | Always |
| `network.defaults.yml` | `collection/roles/net_controllers/defaults/main.yml` | net_controllers | Always |
| `netplan.template.j2` | `collection/roles/net_controllers/templates/netplan.yaml.j2` | net_controllers | Always |
| `nvme_namespace.defaults.yml` | `collection/roles/nvme_namespace/defaults/main.yml` | nvme_namespace | Always |
| `raid_fs.defaults.yml` | `collection/roles/raid_fs/defaults/main.yml` | raid_fs | Always |
| `exports.defaults.yml` | `collection/roles/exports/defaults/main.yml` | exports | Always |
| `nfs_server.defaults.yml` | `collection/roles/nfs_server/defaults/main.yml` | nfs_server | If modified from role default |
| `playbook.site.yml` | `playbooks/site.yml` | orchestration | Always |
| `overlay.preset.yml` | `playbooks/group_vars/all/10-preset.yml` | preset apply | If present |
| `overlay.local.yml` | `playbooks/group_vars/all/20-local.yml` | config editors | If present |
| `netplan.live.j2` | `.xinas-local/netplan.yaml.j2` | net_controllers (manual mode) | If present |

The eight rows above `overlay.preset.yml` are the immutable base: role defaults and the tracked netplan template are never written at runtime, only by a release, so they stay in the list because a diff spanning an update should still show them changing. The last three rows are the live layers that now carry the desired state those files used to carry — `overlay.preset.yml` is rewritten by every preset apply, `overlay.local.yml` by the config editors (and wins over `overlay.preset.yml` on conflict), and `netplan.live.j2` pairs with `netplan.template.j2` above: it is the untracked override `configure_network.sh`'s manual mode writes, used instead of the tracked template only while `net_netplan_template` points at it. A host that has never applied a preset has none of the three and they are simply absent from the snapshot, the same as any other missing source.

Files are copied verbatim. Checksums for each collected file are computed at copy time and stored alongside the manifest so that tampering between snapshot creation and rollback can be detected.

---

## 3. Runtime State Collected

In addition to desired-state configuration, each snapshot captures the live runtime state of the system at the moment of creation. All runtime artifacts are stored under `runtime/` within the snapshot directory.

| Snapshot File | Method | Data Format | Purpose |
|---|---|---|---|
| `runtime/raid-show.json` | gRPC `raid_show(extended=True)` | JSON dict keyed by array name | RAID topology with device health |
| `runtime/pool-show.json` | gRPC `pool_show()` | JSON dict keyed by pool name | Spare pool membership |
| `runtime/config-show.json` | gRPC `config_show()` | JSON | xiRAID stored config on drives |
| `runtime/mounts.json` | `systemctl` + mount inspection | JSON array of mount units | systemd mount unit state |
| `runtime/exports.json` | Parse `/etc/exports` | JSON with entries + sha256 | NFS export set |
| `runtime/nfs-conf.checksum` | sha256 of `/etc/nfs.conf` | Plain text sha256 | NFS server config integrity |
| `runtime/netplan.checksum` | sha256 of `/etc/netplan/99-xinas.yaml` | Plain text sha256 | Network config integrity |
| `runtime/services.json` | ServiceController queries | JSON array | Service states (nfs-server, xiraid-server) |

### Collection Failure Handling

If a runtime data source is unavailable (e.g., xiraid-server is not running), the corresponding file is omitted and a warning entry is added to `validation.warnings` in the manifest.

---

## 4. Rollback Classification Rules

Every operation is assigned exactly one rollback class. The class determines the confirmation flow (Section 10) and the rollback strategy.

The three classes, in descending severity:

| Class | Meaning |
|---|---|
| `destroying_data` | Operation erases, reformats, or irreversibly alters stored data |
| `changing_access` | Operation changes how clients reach or interact with data, but data itself is preserved |
| `non_disruptive` | Operation has no impact on data or client access |

### 4.1 RAID Operations

| Operation | Classification | Reason |
|---|---|---|
| RAID create | `destroying_data` | New array may format devices |
| RAID delete | `destroying_data` | Removes array and data |
| RAID level change | `destroying_data` | Requires recreation |
| Device membership change | `destroying_data` | May require recreation |
| Parity count change | `destroying_data` | May require recreation |
| Spare pool reassignment (requiring recreation) | `destroying_data` | Array recreation needed |
| Namespace/layout change (causing recreation) | `destroying_data` | Array recreation needed |
| Restriping | `non_disruptive` | Online operation |
| RAID parameter change | `non_disruptive` | Online modification |

### 4.2 Filesystem Operations

| Operation | Classification | Reason |
|---|---|---|
| FS create (formats device) | `destroying_data` | Erases device content |
| FS delete | `destroying_data` | Removes filesystem |
| FS reformat | `destroying_data` | Erases all data |
| Data device change | `destroying_data` | New device, data lost |
| Log device change | `destroying_data` | May require reformat |
| Label change (requiring reformat) | `destroying_data` | Reformat needed |
| `su_kb`/`sw`/`sector_size`/`log_size` change (requiring reformat) | `destroying_data` | Reformat needed |
| Mountpoint change | `changing_access` | Affects client paths |
| Mount option change | `changing_access` | Affects access behavior |
| systemd mount unit enable/disable | `changing_access` | Affects availability |
| Switching exported path between FS | `changing_access` | Client path change |
| Metadata-only annotation | `non_disruptive` | No system change |

### 4.3 Share Operations

| Operation | Classification | Reason |
|---|---|---|
| Share create | `changing_access` | New export visible to clients |
| Share delete | `changing_access` | Export removed (data files are NOT deleted) |
| Share path change | `changing_access` | Client access path changes |
| Client scope change | `changing_access` | Access permissions change |
| Export options change | `changing_access` | Access behavior changes |

### 4.4 Network and Service Operations

| Operation | Classification | Reason |
|---|---|---|
| Hostname change | `changing_access` | May affect client resolution |
| IP pool change | `changing_access` | Client connectivity affected |
| Manual IP change | `changing_access` | Client connectivity affected |
| MTU change | `changing_access` | May affect connectivity |
| NFS thread count change | `changing_access` | Performance/availability |
| NFS RDMA port change | `changing_access` | Client connectivity |
| Netplan/export rendered changes | `changing_access` | Client access affected |

### 4.5 Metadata Operations

| Operation | Classification | Reason |
|---|---|---|
| Snapshot labels | `non_disruptive` | Annotation only |
| Operator comments | `non_disruptive` | Annotation only |
| Retention metadata | `non_disruptive` | Annotation only |
| Audit annotations | `non_disruptive` | Annotation only |

### 4.6 Multi-class Resolution

When a single operation spans multiple classification levels, the highest-severity class wins:

```
destroying_data > changing_access > non_disruptive
```

For example, an operation that both reformats a filesystem (`destroying_data`) and changes an NFS export (`changing_access`) is classified as `destroying_data`.

### 4.7 Unknown-Operation Fail-Safe

An operation whose type does not match any entry in the classification
tables above — including an operation string that does not parse to a known
operation type at all — MUST be classified at the **most** destructive
tier, `destroying_data`, never `non_disruptive`. This is the opposite of
what "default to the safest option" naively suggests: an operation the
classifier cannot recognize is the case where the system knows the *least*
about what it will do, so it MUST receive the two-screen `destroying_data`
confirmation gate (§10.1), not the auto-proceed / simple-`[OK]` path
reserved for `non_disruptive` changes (§10.3).

This fail-safe direction applies at every site that falls through to a
default classification when the classifier cannot fully determine an
operation's or change's risk, including (but not limited to):

- the classifier's terminal fallthrough when an operation is absent from
  the static lookup table;
- any caller-side fallback (e.g. a runner catching an operation string that
  fails to parse to a known operation type) that substitutes a default
  classification instead of propagating the classifier's result;
- the diff/change-entry classifier's terminal fallthrough, reached when a
  change entry's `change_type` neither parses to a known operation type nor
  matches any file-path heuristic.

Each of these sites MUST default to `destroying_data`, never
`non_disruptive` — consistent with the existing (correct)
unrecognized-detail-key defaults already used for `RAID_MODIFY` and
`FS_MODIFY` refinement (§4.1, §4.2). Relatedly, when classifying the risk
of restoring to a target snapshot and there is no current-effective
snapshot to diff against, the risk MUST be derived from the target snapshot
alone (its own recorded class/operation), never silently reported as
`non_disruptive`.

---

## 5. Dependency Order for Destructive Rollback

Rolling back to a previous snapshot that involves destructive changes must follow a strict dependency order to avoid leaving the system in an inconsistent state.

### 5.1 Teardown Order (current state to target state)

```
Step 1: Remove/update share exposure    -- exports role variables
Step 2: Unexport/reload NFS             -- exportfs -r
Step 3: Stop dependent mount units      -- systemctl stop <unit>.mount
Step 4: Unmount filesystems             -- umount <mountpoint>
Step 5: Remove filesystem definitions   -- (if target requires different FS)
Step 6: Remove RAID definitions         -- gRPC raid_destroy / xicli raid destroy
```

### 5.2 Rebuild Order (apply target state)

```
Step 7:  Create target RAID arrays      -- gRPC raid_create / xicli raid create
Step 8:  Create target filesystems      -- mkfs.xfs with parameters
Step 9:  Create/enable mount units      -- deploy systemd .mount + enable
Step 10: Reapply share exposure         -- render /etc/exports + exportfs -r
```

### 5.3 Dependency Validation Rules

The rollback engine must refuse to proceed if dependency constraints are violated:

- **REFUSE RAID destroy** if a configured filesystem still depends on it, OR a mounted filesystem depends on it.
- **REFUSE FS remove** if a share/export targets its path, OR a managed mount unit is active for it.

These checks are performed during the preflight phase. Violations are reported as `validation.blockers` in the manifest.

---

## 6. Lock and Transaction Journal

All configuration changes are serialized through a single global lock. A transaction journal tracks operation progress to enable crash recovery.

### 6.1 Lock File

```
Path:      /var/lib/xinas/config-history/state/lock
Mechanism: fcntl.flock(fd, LOCK_EX | LOCK_NB)
```

The lock is non-blocking. If the lock cannot be acquired, the operation fails immediately with a descriptive error including the current lock holder's metadata.

### 6.2 Lock Metadata

Written immediately after acquiring the lock:

```json
{
  "pid": 12345,
  "operation": "raid_create",
  "user": "root",
  "source": "xinas_menu",
  "started": "2026-03-16T14:55:00Z",
  "pre_change_snapshot": "20260316T145500Z-pre-raid-create"
}
```

Path: `/var/lib/xinas/config-history/state/lock.meta`

### 6.3 Transaction Journal

Tracks the lifecycle of the in-flight operation:

```yaml
# /var/lib/xinas/config-history/state/journal.yml

transaction_id: "tx-20260316T145500Z"
operation: "raid_modify"
phase: "executing"          # One of: preflight | snapshot_created | executing
                            #         | validating | completed | failed | rolling_back
pre_change_snapshot: "20260316T145459Z-pre-raid-modify"
target_snapshot: "20260316T145500Z-raid-modify"
user: "root"
source: "xinas_menu"
started: "2026-03-16T14:55:00Z"
last_updated: "2026-03-16T14:55:30Z"
steps_completed:
  - lock_acquired
  - pre_snapshot_created
  - ansible_started
steps_remaining:
  - ansible_complete
  - post_validate
  - mark_applied
error: null
```

The journal is updated atomically (write to temp file, then rename) after every phase transition.

### 6.4 Stale Lock Recovery (on startup)

When the config-history subsystem initializes, it performs the following recovery sequence:

1. Check if lock file exists.
2. Read `lock.meta` to obtain the PID.
3. Check if the PID is alive (`os.kill(pid, 0)`).
4. If the process is dead, read `journal.yml`.
5. If journal phase is `executing` or `rolling_back`: mark the transaction as interrupted, log a warning, and preserve the pre-change snapshot for forensic review.
6. If journal phase is `preflight` or `snapshot_created`: safe to clean up any ephemeral snapshots and release the lock.
7. Clear `lock.meta` and `journal.yml`.
8. Log the recovery event to `audit.log`.

### 6.5 Stale Lock Recovery Contract

Stale-lock recovery (§6.4) MUST NOT create a window where a second process
can acquire the lock and have its just-written `lock.meta`/`journal.yml`
deleted out from under it:

- Clearing `lock.meta` and `journal.yml` (§6.4 step 7) MUST happen while
  still holding the `flock` acquired to detect the stale lock in the first
  place — the recovery routine MUST NOT release the `flock` (or skip taking
  it) before removing those files. Only after the metadata is cleared, and
  the `flock` released, may another process's `acquire()` observe a clean
  slate.
- The liveness check in step 3 (`os.kill(pid, 0)`) MUST distinguish "the
  process no longer exists" (`ESRCH` / `ProcessLookupError`) from "the
  process exists but is owned by another user" (`EPERM` /
  `PermissionError`). Only the former means the lock is stale. `EPERM` MUST
  be treated as "the process is alive" — the lock is NOT stale — even
  though both currently surface as generic `OSError` subclasses; they MUST
  be handled as distinct outcomes, not folded into a single "gone" branch.

---

## 7. Garbage Collection Rules

### 7.1 Retention Policy

Retention is configurable via `/etc/xinas-mcp/config.json` (key: `retention`):

| Parameter | Default | Range | Description |
|---|---|---|---|
| `max_snapshots` | 40 | 1–1000 | Maximum rollback-eligible snapshots retained |
| `max_age_days` | 0 | 0–3650 | Delete snapshots older than N days (0 = disabled) |

| Snapshot Type | Retention Rule |
|---|---|
| `baseline` | Always retained (immutable); GC never considers it for purge |
| `rollback_eligible` | Oldest purged when count > `max_snapshots` OR age > `max_age_days` |
| `ephemeral` | Not retained under a fixed count. Reclaimed via the transactional lifecycle (§1 "Snapshot Status Lifecycle"): once the operation it precedes reaches a terminal status, it becomes eligible for cleanup by GC / the startup stale-ephemeral cleanup (§7.3). An ephemeral snapshot that never reaches a terminal status MUST NOT be retained forever — that is a lifecycle bug, not an intended retention outcome. |
| Currently effective | Always retained regardless of policy |

Settings can be changed via TUI (Config History → Retention Settings) or MCP (`config.set_retention`).

### 7.2 Purge Trigger

After every successful snapshot creation:

1. Count `rollback_eligible` snapshots (excluding baseline).
2. If count exceeds `max_snapshots`: mark oldest excess snapshots for purging.
3. If `max_age_days` > 0: mark snapshots older than the cutoff for purging.
4. For each candidate: verify not protected (not locked, not currently effective, not in-progress).
5. Remove the snapshot directory (manifest and all collected files).
6. Log the purge event to `audit.log`.

### 7.3 Stale Ephemeral Cleanup (on startup)

1. Scan `snapshots/` for entries with `type: ephemeral`.
2. For each, check whether an associated transaction is active (via `journal.yml`).
3. If no active transaction exists:
   - If the operation never started applying: delete the ephemeral snapshot.
   - If the operation had begun executing: convert to `status: failed` and keep for forensics.
4. Mark as visible in the UI as "interrupted by daemon crash".

### 7.4 GC Concurrency and Mutual Exclusion

Garbage collection MUST be mutually exclusive with any in-flight
transactional operation (apply, rollback, or restore):

- Before deleting any snapshot, GC MUST acquire the global configuration
  lock (§6.1) — or otherwise guarantee, by construction, that no apply or
  restore is concurrently in flight. **GC MUST NOT delete a snapshot while
  holding no lock if a transactional operation could concurrently be
  reading or writing store state.**
- GC MUST NOT delete a snapshot that is the source of an in-flight
  `snapshot restore` (§11.6) — a snapshot another in-progress operation is
  actively reading files out of — even if that snapshot would otherwise be
  eligible for purge by count or age. This protection is in addition to,
  and does not replace, the existing baseline / currently-effective
  protections in §7.1.
- The snapshot-directory removal itself (deleting a snapshot's files from
  disk) MUST never execute against a snapshot that another operation
  (restore, diff, or show) is actively reading.

The specific mechanism — holding the global configuration lock for the
duration of the GC pass, passing an in-flight restore's source snapshot id
into GC's protected-id set, or an equivalent guarantee — is an
implementation detail. The contract is: **no lock-free deletion, and an
active restore's source snapshot is always protected.**

---

## 8. Disk Space Safety

### 8.1 Minimum Margin

- **Reserved:** 50 MB for config-history operations.
- **Path:** same filesystem as `/var/lib/xinas/config-history/`.

### 8.2 Preflight Check

```python
def check_disk_space(store_path: str) -> tuple[bool, str]:
    stat = os.statvfs(store_path)
    free_mb = (stat.f_bavail * stat.f_frsize) / (1024 * 1024)
    # Estimate snapshot size from last snapshot + 20% buffer
    estimated_mb = get_last_snapshot_size_mb() * 1.2
    required_mb = estimated_mb + 50  # snapshot + safety margin
    if free_mb < required_mb:
        return (
            False,
            f"Insufficient space: {free_mb:.0f}MB free, {required_mb:.0f}MB required",
        )
    return True, ""
```

### 8.3 Mid-Operation Failure

If disk space is exhausted during an operation:

1. Mark the transaction as `failed` in `journal.yml`.
2. Attempt rollback to the pre-change snapshot.
3. If rollback also fails due to space constraints: record in the journal that rollback is incomplete.
4. Surface prominently in the UI and `audit.log`.

---

## 9. Drift Detection

Drift occurs when a managed artifact on disk no longer matches the last applied snapshot. This can happen if an operator edits a file directly (e.g., `vim /etc/exports`) outside of xiNAS tooling.

### 9.1 Managed Artifacts

| Artifact | Detection Method | Policy |
|---|---|---|
| `/etc/exports` | sha256 checksum + semantic parse | Detect, warn, confirm |
| `/etc/nfs.conf` | sha256 checksum | Detect, warn, confirm |
| `/etc/idmapd.conf` | sha256 checksum | Detect, warn, confirm |
| `/etc/nfs/nfsd.conf` (ADR-0005 effective file) | sha256 checksum | Detect, warn, confirm |
| `/etc/default/nfs-kernel-server` (ADR-0005 effective file) | sha256 checksum | Detect, warn, confirm |
| `/etc/modprobe.d/lockd.conf` (ADR-0005 effective file) | sha256 checksum | Detect, warn, confirm |
| `/etc/default/nfs-common` (ADR-0005 effective file) | sha256 checksum | Detect, warn, confirm |
| `/etc/netplan/99-xinas.yaml` | sha256 checksum | Detect, warn, confirm |
| systemd mount units (xiNAS-managed) | Unit file checksum + enabled state | Detect, warn, confirm |
| Role defaults YAML files | sha256 checksum | Adopt into snapshot |
| `playbooks/site.yml` | sha256 checksum | Adopt into snapshot |

### 9.2 Detection Flow

On preflight or snapshot creation:

1. Load the last applied snapshot's checksums.
2. Compute current checksums for all managed artifacts.
3. Compare checksums.
4. If a mismatch is found, generate a `DriftReport`.
5. The `DriftReport` contains:
   - `artifact` -- path or identifier of the drifted file
   - `previous_checksum` -- checksum from the last applied snapshot
   - `current_checksum` -- checksum computed from the live system
   - `is_semantic` -- whether the change affects behavior (vs. whitespace/comments)
   - `safety_impact` -- the rollback class that would apply if this artifact were rolled back
6. Surface the report to the user via the TUI or API.
7. Require explicit confirmation before proceeding.

### 9.3 Audit

All drift events are logged with:

- Artifact path
- Previous snapshot reference
- Current checksum
- Detection timestamp
- Operator action taken (confirmed, rejected, deferred)

### 9.4 Systemd Mount-Unit Drift Decision

For xiNAS-managed systemd mount units (the "systemd mount units" row in
§9.1), "Unit file checksum + enabled state" is the decision path — not
merely the live `ActiveState`/`SubState` reported by `systemctl show`:

- Drift detection MUST compare the checksum of the unit file on disk
  (`/etc/systemd/system/<unit>.mount`) against the checksum captured in the
  reference snapshot.
- Drift detection MUST additionally query and compare the unit's
  enabled/disabled state (`systemctl is-enabled`) against the state
  recorded in the snapshot.
- A changed unit file that has not been re-activated (i.e. live
  `ActiveState`/`SubState` still match the snapshot) MUST still register as
  drift — a content or enabled-state change is drift on its own; it is NOT
  masked by a liveness check that happens to still match.
- Live `ActiveState`/`SubState` MAY be reported as supplementary detail (as
  today) but MUST NOT be the sole basis for the drift decision.

---

## 10. Confirmation Requirements by Risk Class

> **The risk class is not displayed in the TUI (2026-08-15).** The
> classification still runs and is still stored on every manifest — only its
> rendering is suppressed, in the Configuration History list, the snapshot
> detail metadata, both diff views, and the restore confirmation dialog.
>
> The reason is that in practice it reads `destroying_data` for everything,
> which makes the field worse than absent: two fail-safe paths fire on
> ordinary operations. `classify_operation` is called without `details`
> ([engine.py](../../xinas_history/engine.py) step 5), so every `raid_modify`
> takes the "no details — assume worst case" branch in
> [classifier.py](../../xinas_history/classifier.py) even when the change was
> a live tuning parameter; and the control path records its own operation
> kinds (`xiraid.array.modify`), which do not parse as `OperationType`, so
> they take the unknown-operation fail-safe. A column where every row is red
> stops carrying information, and trains the operator to click past the
> confirmation it is meant to gate.
>
> The confirmation flows below are unaffected: nothing in the TUI branches on
> the class today, so hiding it removes no gate. Restoring the display means
> fixing the classification first — tracked in [docs/TODO.md](../TODO.md).

### 10.1 Destroying Data

Two-screen confirmation flow:

**Screen 1:**

```
This operation will DESTROY DATA on the following resources:

  - <list of affected arrays/filesystems/shares>

Rollback from this change may also be destructive.

                              [Cancel]  [Continue ->]
```

**Screen 2:**

```
Type the name of the resource to confirm: ___________
  (must match exactly)

Reason for change (audit log): ___________

                              [Cancel]  [Confirm Destruction]
```

### 10.2 Changing Access

Single-screen confirmation:

```
This operation will CHANGE CLIENT ACCESS:

  - <list of affected exports/mountpoints/IPs>

NFS service will be reloaded/restarted.
Active client sessions may be interrupted.

                              [Cancel]  [Confirm]
```

### 10.3 Non-Disruptive

Confirmation depends on the source:

| Source | Behavior |
|---|---|
| `xinas_menu` | Simple `[OK]` dialog |
| CLI with `--yes` flag | Auto-proceed |
| MCP | Auto-proceed |

---

## 11. CLI Interface

The CLI is invoked as a Python module (`python3 -m xinas_history`) and
supports the subcommands below. Every subcommand accepts three global
options (placed before the subcommand name):

```
--store-path <path>         Override the store root (default: /var/lib/xinas/config-history)
--repo-root <path>          xiNAS repo root (default: /opt/xiNAS)
--grpc-address <host:port>  xiRAID gRPC address (default: localhost:6066)
```

### 11.1 `snapshot list`

```
python3 -m xinas_history snapshot list [--format json|table]
```

List all snapshots with ID, timestamp, operation, status, and rollback
class. `--format json` additionally tags each entry with `restorable`
(whether the snapshot has a non-empty `system/` payload or tombstoned
files, i.e. is a valid target for `snapshot restore`).

### 11.2 `snapshot show`

```
python3 -m xinas_history snapshot show <id> [--format json|yaml]
```

Display the full manifest for a single snapshot.

### 11.3 `snapshot create`

```
python3 -m xinas_history snapshot create --source <source> --operation <op>
    [--preset <name>] [--type baseline|rollback_eligible|ephemeral]
    [--summary <text>] [--format json|text]
```

Create a new snapshot of the current system state. `--type` selects the
snapshot type (default `rollback_eligible`); `--type baseline` creates the
baseline instead. `--summary` sets the diff summary recorded on the
manifest. `--format json` prints `{"id": "<snapshot-id>"}` for machine
consumers (the agent bridge).

### 11.4 `snapshot diff`

```
python3 -m xinas_history snapshot diff <id1> <id2> [--format json|unified]
```

Show differences between two snapshots. `unified` produces a
human-readable diff; `json` produces a structured diff suitable for
programmatic consumption.

### 11.5 `snapshot reset-to-baseline`

```
python3 -m xinas_history snapshot reset-to-baseline --reason <text>
    [--yes] [--source <source>] [--format json|text]
```

Reset system configuration to the initial baseline. Without `--yes`, prints
a plan (baseline id, timestamp, preset, risk class, and — if a current
effective snapshot exists — a diff against it) and exits without changing
anything. With `--yes`, executes the reset through the transactional
runner's 8-step sequence (`requirements.md` §17), including auto-rollback
on validation failure. `--reason` records the audit motivation; `--source`
defaults to `api`.

### 11.6 `snapshot restore`

```
python3 -m xinas_history snapshot restore <snapshot_id> --reason <text>
    [--yes] [--source <source>] [--format json|text]
```

Targeted file-level restore of an arbitrary snapshot's captured NFS/network
configuration (S11, ADR-0013) — an **observed recovery**, not a change to
desired state: it writes the target snapshot's captured file bytes back to
their live system paths and reconverges the affected NFS/network services,
without re-running Ansible. This is the real verb that a hypothetical
`snapshot rollback` command would have described; there is no separate
`rollback` subcommand. Without `--yes`, prints a plan and exits. With
`--yes`, executes through the lock / pre-snapshot / reconverge / validate
sequence, with an automatic file-level rollback to the pre-restore state if
reconvergence or post-restore validation fails (§13.2). `--reason` is
required and recorded in the audit trail; `--source` defaults to `api`.

### 11.7 `gc run`

```
python3 -m xinas_history gc run
```

Manually trigger garbage collection under the currently configured
retention policy (§7). Prints the ids of any purged snapshots.

### 11.8 `gc policy`

```
python3 -m xinas_history gc policy [--format json|text]
    [--set [--max-snapshots <n>] [--max-age-days <n>]]
```

Without `--set`, shows the effective retention policy. With `--set`,
updates `/etc/xinas-mcp/config.json` (`retention.max_snapshots` and/or
`retention.max_age_days`) and then shows the resulting policy.
`--max-snapshots` is clamped to a minimum of 1; `--max-age-days` is
clamped to a minimum of 0 (`0` = disabled).

### 11.9 `status`

```
python3 -m xinas_history status [--format json|table]
```

Show a history summary: whether a baseline exists (and its id/timestamp),
total snapshot count, rollback-eligible count, and the current effective
snapshot (id, operation, applied timestamp).

### 11.10 Removed from this spec (never implemented)

The following subcommands appeared in an earlier draft of this spec but
were never built, and are not part of the CLI contract:

- `snapshot rollback <target_id>` — superseded by `snapshot restore`
  (§11.6), which is the real, implemented verb for recovering a prior
  state.
- `drift check` — drift detection (§9) is a library class
  (`DriftDetector`) consumed by the TUI and MCP layers; it is not exposed
  as a standalone CLI subcommand.
- `lock status` — covered by `status` (§11.9).
- `lock clear --force` — not implemented; stale-lock recovery (§6.4, §6.5)
  runs automatically on startup instead of through an operator-invoked CLI
  command.

---

## 12. MCP Tools Interface

The following MCP tools are exposed for programmatic access by AI agents and external automation:

### config_history_snapshot_list

- **Input:** none
- **Returns:** JSON array of snapshot summaries (id, timestamp, operation, status, rollback_class)

### config_history_snapshot_show

- **Input:** `{ id: string }`
- **Returns:** Full snapshot manifest and diff summary

### config_history_snapshot_diff

- **Input:** `{ from_id: string, to_id: string }`
- **Returns:** Unified diff between the two snapshots

### config_history_rollback

- **Input:** `{ target_id: string, reason: string }`
- **Returns:** Operation result including new snapshot ID, status, and any validation warnings

### config_history_drift_check

- **Input:** none
- **Returns:** Drift report -- either clean status or a list of drifted artifacts with checksums and safety impact

---

## 13. Post-Apply and Post-Restore Validation

### 13.1 Post-Apply Validation Contract

Post-apply validation is the gate between "the apply function returned
success" and "the snapshot is marked `applied`" (`requirements.md` §17.1:
*"A snapshot is marked `applied` only after all post-playbook validations
pass"*). To make that gate meaningful:

- The post-apply validator MUST receive the **expected post-change state**
  for the operation that just ran -- the RAID arrays, mounts, exports, and
  services the operation was supposed to produce or change -- not the
  pre-change manifest, and not an empty/default expected state.
- The validator MUST check the resources the operation actually changed. A
  blanket "is `nfs-server`/`xiraid` active" liveness check is not a
  substitute for checking that, e.g., a `raid_modify` actually produced the
  expected array level, or that a `share_create` actually produced the
  expected export path. The liveness check MAY remain as one of several
  checks, but MUST NOT be the only check capable of running for every
  operation type.
- A failed post-apply validation MUST trigger auto-rollback to the
  pre-change snapshot (already the case -- this spec does not change that
  mechanism, only what feeds the validation decision).

### 13.2 Post-Restore Validation Contract

The S11/ADR-0013 targeted restore path (`snapshot restore`, §11.6) MUST
also validate before declaring success, on the same principle as §13.1:
post-restore validation MUST check that the reconverge step actually
produced the expected state for the restored files (e.g. `exportfs`/NFS
service state matches the restored exports; netplan state matches the
restored network config), not assume success once the reconverge commands
return a zero exit code. An always-`True` post-restore validation stub is
a gap, not a valid implementation of this contract: a reconverge command
can exit `0` while leaving the system in a state that does not match what
was restored, and that case MUST be caught before the restore is reported
as successful.
