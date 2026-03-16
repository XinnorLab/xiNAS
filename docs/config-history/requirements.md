# xiNAS Configuration History and Rollback — Requirements

## Table of Contents

- [1. Objective](#1-objective)
- [2. Architectural Requirement](#2-architectural-requirement)
- [3. Snapshot Model](#3-snapshot-model)
- [4. Snapshot Creation Rules](#4-snapshot-creation-rules)
- [5. Canonical Configuration Content](#5-canonical-configuration-content)
- [6. Exact Settings Stored](#6-exact-settings-stored)
- [7. Rollback Classification Model](#7-rollback-classification-model)
- [8. Rollback Type per Configuration Area](#8-rollback-type-per-configuration-area)
- [9. Preflight Behavior](#9-preflight-behavior)
- [10. Confirmation Requirements](#10-confirmation-requirements)
- [11. Transaction and Ordering](#11-transaction-and-ordering)
- [12. Notification Requirements](#12-notification-requirements)
- [13. History UI](#13-history-ui)
- [14. Recommended Snapshot Layout](#14-recommended-snapshot-layout)
- [15. Acceptance Criteria](#15-acceptance-criteria)
- [16. Recommended Implementation Note](#16-recommended-implementation-note)
- [17. Backend Execution and Rollback Orchestration](#17-backend-execution-and-rollback-orchestration)
- [18. Snapshot Garbage Collection](#18-snapshot-garbage-collection)
- [19. gRPC Implementation Priority](#19-grpc-implementation-priority)
- [20. Concurrency and Locking](#20-concurrency-and-locking)
- [21. Filesystem Full / Disk Full](#21-filesystem-full--disk-full)
- [22. Manual Drift Detection](#22-manual-drift-detection)
- [23. Additional UX Notifications](#23-additional-ux-notifications)
- [24. Updated Acceptance Criteria](#24-updated-acceptance-criteria)

---

## 1. Objective

Configuration history subsystem for xiNAS that records installation profile selection and effective system configuration during install, and records all subsequent major configuration changes (RAID, Filesystem, NAS share, Network).

## 2. Architectural Requirement

Single canonical backend used by installer, post-install management, and any future UI/API layer. Must not diverge between installer scripts and deployed management console.

## 3. Snapshot Model

Named snapshots with the following attributes:

- Unique ID
- Timestamp
- User
- Operation source (installer / post_install_menu / xinas_menu / api / MCP Server)
- Preset name
- Parent snapshot ID
- Operation type
- Rollback classification
- Status (pending / applied / rolled_back / failed / partial)
- Full config bundle copy
- Resolved diff
- Validation results
- Checksums

**Retention policy:** immutable baseline + 10 rolling rollback-eligible + 1 ephemeral pre-change.

## 4. Snapshot Creation Rules

### 4.1 Installer

Two records:

1. **Selected profile snapshot** — captured before the playbook runs.
2. **First installed config snapshot** — captured after a successful install completes.

### 4.2 Post-install

- New rollback-eligible snapshot after every successful major change.
- Pre-change recovery snapshot created before each change.
- Auto-rollback on failure.

## 5. Canonical Configuration Content

### 5.1 Desired Config Bundle

| File | Source Role / Location |
|------|----------------------|
| `common/defaults/main.yml` | common role defaults |
| `net_controllers/defaults/main.yml` | net_controllers role defaults |
| `net_controllers/templates/netplan.yaml.j2` | netplan template |
| `nvme_namespace/defaults/main.yml` | nvme_namespace role defaults |
| `raid_fs/defaults/main.yml` | raid_fs role defaults |
| `exports/defaults/main.yml` | exports role defaults |
| `nfs_server/defaults/main.yml` | nfs_server role defaults |
| `playbooks/site.yml` | top-level playbook |

### 5.2 Profile Metadata

- Preset name
- Repo commit
- Playbook path
- Extra vars
- Hostname
- Hardware ID
- Auto-detection flag

### 5.3 Runtime-resolved State

- xicli/gRPC `raid show`
- xicli/gRPC `pool show`
- Filesystem labels
- systemd mount units
- `/etc/exports` checksum
- `/etc/nfs.conf` checksum
- Mount state
- `nfs-server` service state

## 6. Exact Settings Stored

### 6.1 RAID

- Array name
- Level
- Strip size
- Parity count
- Device list
- Spare pool
- Extended config details

### 6.2 Filesystem

- Label
- Data device
- Log device
- `su_kb`
- `sw`
- Log size
- Sector size
- Mountpoint
- Mount options
- systemd unit name
- Enabled state

### 6.3 Share

- Path
- Client scope
- Export options

### 6.4 Network

- Hostname
- IP pool enabled / start / end / prefix
- Manual IPs
- MTU mode / value
- Netplan checksum

### 6.5 NFS Service

- Thread count
- RDMA port
- `nfs-server` enabled / active

## 7. Rollback Classification Model

Three types:

| Type | Description |
|------|-------------|
| **Destroying data** | Operation will irreversibly destroy stored data |
| **Changing access behaviour** | Operation alters how clients reach or use data |
| **Non-disruptive** | Operation has no impact on data or access |

When an operation spans multiple classification types, the **highest-risk class wins**.

## 8. Rollback Type per Configuration Area

### 8.1 RAID

| Operation | Classification |
|-----------|---------------|
| Create / delete / level change / device change / parity change | `destroying_data` |
| Restriping / parameter change | `non_disruptive` |

### 8.2 Filesystem

| Operation | Classification |
|-----------|---------------|
| Create + format / delete / reformat / device change / label change requiring reformat | `destroying_data` |
| Mountpoint / mount option / unit enable change | `changing_access` |

### 8.3 Share

| Operation | Classification |
|-----------|---------------|
| Create / delete / path / scope / options change | `changing_access` |

Deleting a share must **NOT** delete user data files.

### 8.4 Network / Service

| Operation | Classification |
|-----------|---------------|
| Hostname / IP / MTU / thread / port / netplan changes | `changing_access` |

### 8.5 Metadata

| Operation | Classification |
|-----------|---------------|
| Labels / comments / annotations | `non_disruptive` |

## 9. Preflight Behavior

The preflight screen must show:

- Current snapshot ID
- Proposed change
- Affected objects
- Rollback type
- Service interruption expected
- Data destruction possible
- Auto-rollback available
- Blockers

For **destructive operations**, additionally show the exact arrays, filesystems, shares, devices, mountpoints, and export paths affected.

Block execution until dependency order is validated.

## 10. Confirmation Requirements

### 10.1 Destroying Data

- Two confirmations
- Typed resource name or phrase
- Explicit rollback warning
- Audit reason

### 10.2 Changing Access

- One confirmation
- Client impact statement
- NFS reload warning

### 10.3 Non-disruptive

- Simple or no confirmation

## 11. Transaction and Ordering

### 11.1 Destructive Rollback Order

1. Remove shares
2. Unexport NFS
3. Stop mounts
4. Unmount
5. Remove / recreate filesystem
6. Remove / recreate RAID
7. Recreate filesystem
8. Recreate mounts
9. Reapply shares

### 11.2 Validation

- Refuse RAID destroy if a filesystem depends on it.
- Refuse filesystem remove if a share targets its path.

### 11.3 Partial Failure

- Stop workflow at the failed step.
- Mark the snapshot as `failed`.
- Auto-rollback to the pre-change snapshot.
- Mark as `rolled_back` or `partial`.
- Show the failed layer to the user.

## 12. Notification Requirements

### 12.1 Before Apply

- What changes
- Risk class
- Service impact
- Rollback target

### 12.2 After Success

- Completed
- New snapshot ID / label
- Rollback class
- Changed resources

### 12.3 After Failure

- Failed step
- Rollback success
- Current effective snapshot
- Manual recovery tasks

All events must be written to `/var/log/xinas/audit.log`.

## 13. History UI

The history view must display:

- Immutable baseline
- Last 10 rollback-eligible snapshots
- Current effective snapshot
- Timestamp
- Initiator
- Operation type
- Rollback class
- Status
- Diff summary

Per-snapshot detail view:

- Full diff
- Affected resources
- Validation notes
- Rollback eligibility
- Dependency blockers

## 14. Recommended Snapshot Layout

```
/var/lib/xinas/config-history/
  baseline/
    manifest.yml
    common.defaults.yml
    network.defaults.yml
    netplan.template.j2
    nvme_namespace.defaults.yml
    raid_fs.defaults.yml
    exports.defaults.yml
    nfs_server.defaults.yml
    playbook.site.yml
    runtime/
      raid-show.json
      pool-show.json
      mounts.json
      exports.checksum
      nfs.conf.checksum
  snapshots/
    20260316T145500Z-raid-modify/
      manifest.yml
      ...
```

## 15. Acceptance Criteria

- Installer stores both profile snapshot and first installed config snapshot.
- A snapshot is created for every CRUD change.
- Retention is baseline + 10 rolling rollback-eligible.
- Every snapshot and rollback carries a classification.
- Invalid dependency sequences are blocked.
- Pre-change snapshot is created before every change.
- Auto-rollback triggers on failure.
- User data files are never deleted.
- All actions are logged.
- Clear notifications are provided at every stage.

## 16. Recommended Implementation Note

Formalize existing preset/backup/audit/systemd patterns into a transactional snapshot engine rather than bolting on a separate mechanism.

## 17. Backend Execution and Rollback Orchestration

### 17.1 Runner

Wrap Ansible with transactional control:

- Lock acquisition
- Pre-change snapshot
- Execution context
- Post-validation
- Rollback trigger
- State recording

A snapshot is marked `applied` **only** after all post-playbook validations pass.

### 17.2 Execution Phases

1. Acquire lock
2. Validate space / health
3. Create pre-change snapshot
4. Mark `pending`
5. Execute
6. Validate
7. Mark `applied` or `failed`
8. Garbage collect
9. Release lock

### 17.3 State Persistence

Persist transaction state to disk to survive crashes. Persisted fields:

- Operation ID
- Pre-change snapshot
- Target snapshot
- Phase
- Rollback status

## 18. Snapshot Garbage Collection

### 18.1 Retention

- Baseline + 10 rollback-eligible + 1 ephemeral per active transaction.
- Purge the 11th oldest rollback-eligible snapshot when a new snapshot is created.

### 18.2 Purge Rules

- Never delete baseline, current effective, or in-progress rollback reference.
- Verify snapshot is not locked.
- Remove metadata + artifacts.
- Log all purges.

### 18.3 Crash Handling

- Scan for stale ephemeral snapshots on startup.
- Clean up or convert to `failed`.
- Stale snapshots must be visible in the UI.

## 19. gRPC Implementation Priority

### 19.1 Rationale

Avoid CLI shell-out latency, brittle parsing, and ambiguous errors.

### 19.2 Prefer gRPC For

- RAID state
- Pool state
- Filesystem dependency inspection
- Validation
- Post-apply verification

### 19.3 CLI Fallback

When gRPC is unavailable, the CLI fallback must handle:

- Timeout handling
- Schema validation
- Transport vs. semantic error mapping
- Retry for read-only operations only

## 20. Concurrency and Locking

### 20.1 Global Mutex

A single global mutex across all entry points: CLI, menu, API, installer, daemon.

### 20.2 Contention Behavior

- Refuse or queue the second operation.
- Show active transaction info to the blocked caller.

### 20.3 Lock Durability

- Locks survive restarts.
- Inspect transaction state on stale lock.
- Never silently discard a lock.

## 21. Filesystem Full / Disk Full

### 21.1 Preflight Disk-space Validation

Validate available disk space before creating a snapshot or applying a change.

### 21.2 Graceful Failure

Fail gracefully with a clear error message.

### 21.3 Safety Margin

Reserve a minimum safety margin sufficient for:

- Snapshot storage
- Failed state recording
- Rollback artifacts
- Audit log

### 21.4 Mid-operation Failure

- Mark the operation as `failed`.
- Attempt rollback.
- Record incomplete state.

## 22. Manual Drift Detection

### 22.1 Definition

Drift occurs when an administrator changes managed artifacts outside xiNAS.

### 22.2 Detection Mechanism

Detect via checksums + semantic comparison on the next snapshot creation or preflight check.

### 22.3 User Notification

Flag to the user:

- Which files drifted
- Semantic vs. checksum difference
- Rollback safety impact
- Option to adopt or refuse

### 22.4 Policy per Artifact Class

Per-artifact-class policy options:

- Adopt
- Block
- Overwrite

Safety-critical default: detect + warn + confirm.

### 22.5 Audit

All drift events must be audited.

## 23. Additional UX Notifications

The following events require user-facing notifications:

- Lock contention
- Low-space failure
- Drift detected
- Interrupted transaction recovery
- Garbage collection result

## 24. Updated Acceptance Criteria

- Ansible is wrapped by the transactional runner.
- Snapshots are marked `applied` only after strict validation.
- A global lock prevents concurrent interleaving.
- Garbage collection auto-purges beyond the retention limit.
- Stale ephemeral snapshots are cleaned up on startup.
- gRPC is the preferred backend for xicli interactions.
- Disk-full conditions are handled safely.
- Manual drift is detected and surfaced.
- No concurrent operations may interleave.
