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

---

## 1. Snapshot Manifest Schema

Every snapshot is stored as a directory under `/var/lib/xinas/config-history/snapshots/<id>/`.
The manifest lives at `manifest.yml` inside that directory.

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
  nfs_conf: string       # sha256:<hex>
  netplan: string        # sha256:<hex>

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
- `parent_id` forms a singly-linked chain. The baseline snapshot has `parent_id: null`.
- `checksums` values always use the prefix `sha256:` followed by 64 lowercase hex characters.
- `validation.blockers` is non-empty only when `validation.passed` is `false`.
- `diff_summary` is `null` for baseline snapshots.

---

## 2. Configuration Files Collected

Each snapshot directory contains copies of the Ansible role defaults and templates that define the system's desired state.

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

---

## 7. Garbage Collection Rules

### 7.1 Retention Policy

| Snapshot Type | Retention Rule |
|---|---|
| `baseline` | Always retained (immutable) |
| `rollback_eligible` | Last 10 retained |
| `ephemeral` | 1 per active transaction, cleaned up after completion |
| Currently effective | Always retained, even if it would be the 11th rollback-eligible snapshot |

### 7.2 Purge Trigger

After every successful snapshot creation:

1. Count `rollback_eligible` snapshots (excluding baseline).
2. If count exceeds 10: identify the oldest `rollback_eligible` snapshot.
3. Verify the candidate is not locked, not the currently effective snapshot, and not referenced by an in-progress rollback.
4. Remove the snapshot directory (manifest and all collected files).
5. Log the purge event to `audit.log`.

### 7.3 Stale Ephemeral Cleanup (on startup)

1. Scan `snapshots/` for entries with `type: ephemeral`.
2. For each, check whether an associated transaction is active (via `journal.yml`).
3. If no active transaction exists:
   - If the operation never started applying: delete the ephemeral snapshot.
   - If the operation had begun executing: convert to `status: failed` and keep for forensics.
4. Mark as visible in the UI as "interrupted by daemon crash".

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

---

## 10. Confirmation Requirements by Risk Class

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

The CLI is invoked as a Python module and supports the following subcommands:

```
python3 -m xinas_history snapshot list [--format json|table]
```
List all snapshots with ID, timestamp, operation, status, and rollback class.

```
python3 -m xinas_history snapshot show <id> [--format json|yaml]
```
Display the full manifest and collected file listing for a single snapshot.

```
python3 -m xinas_history snapshot create --source <source> --operation <op> [--preset <name>]
```
Create a new snapshot of the current system state.

```
python3 -m xinas_history snapshot diff <id1> <id2> [--format json|unified]
```
Show differences between two snapshots. Unified format produces a human-readable diff; JSON format produces a structured diff suitable for programmatic consumption.

```
python3 -m xinas_history snapshot rollback <target_id> [--yes] [--reason <text>]
```
Roll back the system to the state captured in the target snapshot. The `--yes` flag skips interactive confirmation (for scripted use). The `--reason` flag records the rollback motivation in the audit log.

```
python3 -m xinas_history gc run
```
Manually trigger garbage collection of expired snapshots.

```
python3 -m xinas_history drift check [--format json|table]
```
Compare the live system against the last applied snapshot and report any drifted artifacts.

```
python3 -m xinas_history lock status
```
Show the current lock state, including holder PID, operation, and duration.

```
python3 -m xinas_history lock clear --force
```
Emergency lock release. Requires `--force` to confirm. Logs the forced release to the audit log.

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
