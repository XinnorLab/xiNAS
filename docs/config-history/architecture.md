# Configuration History and Rollback -- Architecture

## 1. Overview

The config-history subsystem adds snapshot-based configuration tracking and
rollback to xiNAS. Every meaningful change to the system -- RAID layout, NFS
exports, network tuning, role defaults -- is captured as an immutable snapshot
before and after the operation completes. If the change fails validation, the
subsystem automatically reverts to the pre-change state.

The feature is implemented as a standalone Python library (`xinas_history/`)
that is consumed by four separate entry points:

| Entry Point | Runtime | Transport |
|-------------|---------|-----------|
| **xinas_menu** (Textual TUI) | Python | Direct `import` |
| **xiNAS-MCP** (AI/automation server) | TypeScript | `subprocess` (JSON on stdout) |
| **Installer** (Ansible post-task) | Python | Direct `import` |
| **CLI** | Python | `python3 -m xinas_history` |

All four share the same library, the same on-disk format, and the same locking
protocol. There is exactly one source of truth for configuration state:
`/var/lib/xinas/config-history/`.

---

## 2. System Architecture

```
┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌────────────┐
│  xinas-menu │  │  xiNAS-MCP  │  │  Installer   │  │    CLI     │
│  (Textual)  │  │ (TypeScript)│  │  (Ansible)   │  │            │
└──────┬──────┘  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘
       │                │               │                  │
       │  import        │  subprocess   │  import          │  import
       ▼                ▼               ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                      xinas_history (Python)                      │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ │
│  │ Engine │ │ Runner │ │Collector │ │Validator │ │Classifier │ │
│  └───┬────┘ └───┬────┘ └────┬─────┘ └────┬─────┘ └───────────┘ │
│      │          │           │             │                      │
│  ┌───┴────┐ ┌───┴────┐ ┌───┴──────┐ ┌────┴─────┐               │
│  │ Store  │ │  Lock  │ │gRPC Insp.│ │  Drift   │               │
│  └───┬────┘ └────────┘ └──────────┘ └──────────┘               │
└──────┼──────────────────────────────────────────────────────────┘
       │
       ▼
/var/lib/xinas/config-history/
```

The library is pure Python with no external dependencies beyond the standard
library and packages already present in the xiNAS venv (PyYAML, grpcio). Every
module is importable independently so consumers can pull in only the pieces they
need.

---

## 3. Module Descriptions

### engine.py -- SnapshotEngine

Central orchestrator. Exposes the public API consumed by all entry points:

- `create_snapshot(label, snapshot_type)` -- collect state, write to store, run GC.
- `list_snapshots(limit, type_filter)` -- enumerate stored snapshots.
- `get_snapshot(snapshot_id)` -- load a single snapshot and its manifest.
- `diff_snapshots(a_id, b_id)` -- compute structural and semantic diff between two snapshots.
- `rollback(target_id)` -- delegate to Runner for dependency-ordered rollback.

All methods are synchronous. The TUI wraps them via `asyncio.to_thread()`.

### store.py -- FilesystemStore

Low-level CRUD for the on-disk snapshot tree under
`/var/lib/xinas/config-history/`. Responsibilities:

- Atomic directory creation (write to temp, rename into place).
- Manifest serialisation and deserialisation (YAML).
- Content-addressed file deduplication via SHA-256 checksums.
- Enumeration and deletion of snapshot directories.

### models.py -- Data Classes

Immutable data containers shared across the library:

| Class | Purpose |
|-------|---------|
| `Snapshot` | Full snapshot record (id, label, type, status, timestamp, manifest) |
| `Manifest` | Ordered dict of collected artefacts with checksums |
| `DiffResult` | Structured delta between two manifests (added, removed, changed) |
| `SnapshotType` | Enum: `baseline`, `rollback_eligible`, `ephemeral` |
| `RollbackClass` | Enum: `destroying_data`, `changing_access`, `non_disruptive` |
| `OperationType` | Enum: `install`, `raid_modify`, `export_modify`, `network`, `tuning` |
| `SnapshotStatus` | Enum: `pending`, `applied`, `failed`, `rolled_back` |

### runner.py -- TransactionalRunner

Wraps Ansible playbook execution in a transactional envelope:

1. Acquire global lock.
2. Create ephemeral pre-change snapshot.
3. Run Ansible via subprocess with streaming output.
4. Run post-apply validation.
5. On success: create rollback-eligible snapshot, mark applied.
6. On failure: auto-rollback to pre-change snapshot, mark failed.
7. Release lock.

Journal state is persisted to disk after each step so crash recovery can
resume or roll back an incomplete transaction.

### lock.py -- GlobalConfigLock

File-based PID lock using `fcntl.flock()`:

- **Kernel-level advisory lock** -- survives interpreter crashes; released
  automatically when the process exits or the file descriptor is closed.
- **Stale lock recovery** -- reads PID from `lock.meta`, checks
  `/proc/<pid>/cmdline`; if the process is gone the lock is reclaimed.
- **Transaction state inspection** -- callers can query whether a transaction
  is in progress and who holds the lock without attempting to acquire it.

### collector.py -- ConfigCollector + RuntimeCollector

Two collectors run in sequence during snapshot creation:

| Collector | Sources | Output |
|-----------|---------|--------|
| `ConfigCollector` | Role `defaults/main.yml`, preset templates, `playbook.site.yml` | YAML/J2 files copied verbatim |
| `RuntimeCollector` | gRPC (`raid_show`, `pool_show`, `config_show`, `config_backup`), `/proc/mounts`, `exportfs -v`, `systemctl` | JSON artefacts in `runtime/` |

### validator.py -- PreflightValidator + PostApplyValidator

| Validator | When | Checks |
|-----------|------|--------|
| `PreflightValidator` | Before any change | Dependency versions, disk space on `/var/lib/xinas`, service availability, blocker detection (e.g. rebuild in progress) |
| `PostApplyValidator` | After Ansible completes | gRPC state matches target snapshot, mounts present, exports active, services running |

### drift.py -- DriftDetector

Compares the live system against the last rollback-eligible snapshot:

- File-level: SHA-256 checksums of managed config artefacts.
- Semantic-level: structural diff of RAID topology, export rules, network
  config.
- Returns a list of drifted artefacts with human-readable descriptions.

Used by the TUI to show a warning badge and by the MCP server to surface drift
alerts in automation workflows.

### gc.py -- GarbageCollector

Retention policy:

| Category | Retained |
|----------|----------|
| `baseline` | 1 (immutable, never deleted) |
| `rollback_eligible` | 10 most recent |
| `ephemeral` | 1 most recent (pre-change recovery only) |

On every snapshot creation the GC runs and purges the oldest snapshots that
exceed the retention limits. It also cleans up incomplete directories left
behind by crashes (detected via missing `manifest.yml`).

### classifier.py -- RollbackClassifier

Analyses the diff between the current state and a rollback target and assigns
a risk class:

| Risk Class | Examples | UI Treatment |
|------------|----------|--------------|
| `destroying_data` | Removing a RAID array, deleting namespaces | Red confirmation, type-to-confirm |
| `changing_access` | Modifying exports, changing network config | Yellow confirmation |
| `non_disruptive` | Tuning parameters, adding an export | Green confirmation |

Classification is based on the `OperationType` tags stored in the snapshot
manifest and the structural diff between current and target states.

### grpc_inspector.py -- gRPC State Queries

Thin wrapper around the existing `XiRAIDClient` pattern. Methods:

- `raid_show()` -- current RAID array topology.
- `pool_show()` -- storage pool membership.
- `config_show()` -- active xiRAID configuration.
- `config_backup()` -- serialised configuration for restore.

Results are cached per snapshot creation to avoid redundant gRPC round-trips.

### __main__.py -- CLI Entry Point

Enables `python3 -m xinas_history <command> [options]` invocation. Supports
`--format json` for machine-readable output (used by xiNAS-MCP subprocess
calls). Commands mirror the Engine API: `snapshot create`, `snapshot list`,
`snapshot show`, `snapshot diff`, `rollback`, `drift`.

---

## 4. Consumer Integration

| Consumer | Method | Transport | Notes |
|----------|--------|-----------|-------|
| xinas_menu | `import xinas_history` | Direct Python import | Async wrappers via `asyncio.to_thread()` for non-blocking TUI |
| xiNAS-MCP | `subprocess: python3 -m xinas_history <cmd> --format json` | JSON on stdout | Matches the existing nfs-helper subprocess pattern |
| Installer | `import xinas_history` | Direct Python import | Called from Ansible `post_tasks` after playbook completion |
| CLI | `python3 -m xinas_history` | Direct Python import | Thin wrapper around Engine; intended for operator use and scripting |

All consumers share the same lock, the same store path, and the same GC
policy. Concurrent access is serialised by the global file lock.

---

## 5. Data Flow Diagrams

### 5.1 Snapshot Creation Flow

```
User triggers change
  │
  ▼
Engine.create_snapshot(label, type)
  │
  ├─► Lock.acquire()
  │
  ├─► ConfigCollector.collect()
  │     ├── Copy role defaults/main.yml for each role
  │     ├── Copy preset templates (netplan.yaml.j2, etc.)
  │     └── Copy playbook.site.yml
  │
  ├─► RuntimeCollector.collect()
  │     ├── gRPC: raid_show, pool_show, config_show, config_backup
  │     ├── System: /proc/mounts, exportfs -v
  │     └── Services: systemctl status for managed units
  │
  ├─► Store.write_snapshot()
  │     ├── Create temp directory
  │     ├── Write manifest.yml with SHA-256 checksums
  │     ├── Write collected artefacts
  │     └── Atomic rename into snapshots/<id>/
  │
  ├─► GC.run()
  │     └── Purge if > 10 rollback-eligible snapshots
  │
  └─► Lock.release()
```

### 5.2 Transactional Change Flow

```
User requests configuration change
  │
  ▼
Runner.execute(playbook, extra_vars)
  │
  ├─► Lock.acquire()
  │
  ├─► Validator.preflight()
  │     ├── Check dependency versions
  │     ├── Check disk space on /var/lib/xinas
  │     └── Detect blockers (rebuild in progress, etc.)
  │
  ├─► Engine.create_snapshot(type=ephemeral)
  │     └── Pre-change recovery point
  │
  ├─► Runner.mark_pending()
  │     └── Write journal.yml with operation details
  │
  ├─► Runner.run_ansible()
  │     └── subprocess with streaming stdout/stderr
  │
  ├─► Validator.post_apply()
  │     ├── gRPC state matches expected target
  │     ├── Mounts present and accessible
  │     ├── NFS exports active
  │     └── systemd services running
  │
  ├─► [SUCCESS PATH]
  │     ├── Engine.create_snapshot(type=rollback_eligible)
  │     └── Runner.mark_applied()
  │
  ├─► [FAILURE PATH]
  │     ├── Runner.auto_rollback()
  │     │     └── Engine.apply_snapshot(pre_change_ephemeral)
  │     └── Runner.mark_failed()
  │
  ├─► GC.run()
  │
  └─► Lock.release()
```

### 5.3 Rollback Flow

```
User requests rollback to snapshot X
  │
  ▼
Engine.rollback(target_id)
  │
  ├─► Classifier.classify(current, target)
  │     └── Returns: destroying_data | changing_access | non_disruptive
  │
  ├─► Validator.preflight_rollback()
  │     ├── Check dependency compatibility
  │     └── Detect blockers
  │
  ├─► [UI/API: show confirmation per risk class]
  │
  ├─► Lock.acquire()
  │
  ├─► Engine.create_snapshot(type=ephemeral)
  │     └── Pre-rollback recovery point
  │
  ├─► Runner.execute_rollback(target)
  │     ├── Dependency-ordered teardown of current state
  │     └── Dependency-ordered rebuild to target state
  │
  ├─► Validator.post_apply()
  │     └── Verify target state has been reached
  │
  ├─► [SUCCESS] Engine.mark_applied(target)
  │   [FAILURE] Engine.mark_failed(target)
  │
  └─► Lock.release()
```

---

## 6. Snapshot Storage Layout

```
/var/lib/xinas/config-history/
│
├── baseline/                              # Immutable first-install snapshot
│   ├── manifest.yml
│   ├── common.defaults.yml
│   ├── network.defaults.yml
│   ├── netplan.template.j2
│   ├── nvme_namespace.defaults.yml
│   ├── raid_fs.defaults.yml
│   ├── exports.defaults.yml
│   ├── nfs_server.defaults.yml
│   ├── playbook.site.yml
│   └── runtime/
│       ├── raid-show.json
│       ├── pool-show.json
│       ├── mounts.json
│       ├── exports.json
│       ├── nfs-conf.checksum
│       ├── netplan.checksum
│       └── services.json
│
├── snapshots/                             # Rolling snapshots
│   ├── 20260316T140000Z-install/
│   │   ├── manifest.yml
│   │   └── ...                            # Same structure as baseline
│   └── 20260316T145500Z-raid-modify/
│       ├── manifest.yml
│       └── ...
│
└── state/                                 # Lock + transaction journal
    ├── lock                               # PID lock file (fcntl.flock)
    ├── lock.meta                          # Lock metadata (JSON: pid, holder, timestamp)
    └── journal.yml                        # Active transaction state
```

### Manifest Format

Each snapshot contains a `manifest.yml` that records metadata and checksums:

```yaml
id: "20260316T140000Z-install"
label: "install"
type: rollback_eligible          # baseline | rollback_eligible | ephemeral
status: applied                  # pending | applied | failed | rolled_back
operation: install               # install | raid_modify | export_modify | network | tuning
created_at: "2026-03-16T14:00:00Z"
artefacts:
  common.defaults.yml:
    sha256: "a1b2c3..."
  raid_fs.defaults.yml:
    sha256: "d4e5f6..."
  runtime/raid-show.json:
    sha256: "789abc..."
  # ...
```

---

## 7. Existing Code Reuse

The `xinas_history` library reuses the following utilities already present in
the xiNAS codebase rather than re-implementing them:

| Code | Path | Reuse in xinas_history |
|------|------|------------------------|
| `AuditLogger` | `xinas_menu/utils/audit.py` | Append audit records to `/var/log/xinas/audit.log` for every snapshot and rollback operation |
| `OpTracker` / `OpResult` | `xinas_menu/utils/op_tracker.py` | Structured operation logging with timing, success/failure, and context |
| `cfg_read` / `cfg_write` | `xinas_menu/utils/config.py` | Atomic JSON I/O pattern reused for manifest and journal persistence |
| `XiRAIDClient` | `xinas_menu/api/grpc_client.py` | gRPC calls: `raid_show`, `pool_show`, `config_show`, `config_backup` |
| `ServiceController` | `xinas_menu/utils/service_ctl.py` | Inspect systemd unit status for runtime state collection |
| `run_cmd` / `run_cmd_stream` | `xinas_menu/utils/subprocess_utils.py` | Execute Ansible playbooks with streaming output |
| `NavigableMenu` | `xinas_menu/widgets/menu_list.py` | History list UI in Phase 4 TUI screens |
| `ConfirmDialog` | `xinas_menu/widgets/confirm_dialog.py` | Risk-class-aware confirmation dialogs in Phase 4 |

---

## 8. Phased Implementation

### Phase 1 -- Snapshot Engine and Store (Foundation)

**Modules:** `models.py`, `store.py`, `collector.py`, `grpc_inspector.py`,
`engine.py`, `gc.py`, `classifier.py`, `__main__.py`

**Deliverables:**
- Create, list, get, and diff snapshots from the CLI.
- Garbage collection enforces retention policy.
- Risk classification of snapshot diffs.
- Ansible role deploys the package and creates the directory structure.

**Exit criteria:** `python3 -m xinas_history snapshot create --label test`
produces a valid snapshot directory; `snapshot list` and `snapshot diff` return
correct results; GC purges oldest when limit is exceeded.

### Phase 2 -- Transactional Runner and Rollback

**Modules:** `lock.py`, `runner.py`, `validator.py`

**Deliverables:**
- Global file lock with stale recovery.
- Transaction journal with crash recovery.
- Atomic Ansible execution: pre-snapshot, run, validate, post-snapshot.
- Auto-rollback on validation failure.
- Dependency-ordered rollback to any rollback-eligible snapshot.

**Exit criteria:** a deliberately failing playbook triggers automatic rollback
to the pre-change ephemeral snapshot; crash during transaction is recovered on
next invocation.

### Phase 3 -- Drift Detection and Preflight

**Modules:** `drift.py`, enhanced `validator.py`

**Deliverables:**
- Drift detection comparing live state against last snapshot.
- Disk space validation before snapshot creation.
- Confirmation dialogs per risk class (API-level; UI in Phase 4).
- Full audit log integration for all operations.

**Exit criteria:** manual edit of a managed file is detected as drift;
insufficient disk space blocks snapshot creation with a clear error.

### Phase 4 -- TUI Screens and MCP Tools

**New screens in xinas_menu:**
- `config_history` -- list snapshots with status badges.
- `snapshot_detail` -- view manifest, artefacts, diff against current.
- `preflight` -- pre-change validation summary with proceed/abort.

**New MCP tools in xiNAS-MCP:**
- `snapshot_list` -- list snapshots (JSON).
- `snapshot_show` -- single snapshot detail (JSON).
- `snapshot_diff` -- diff two snapshots (JSON).
- `rollback` -- initiate rollback with confirmation (JSON).

**Deliverables:**
- Full TUI integration with navigation, detail views, and notifications.
- MCP tools for AI-driven and automated rollback workflows.

**Exit criteria:** end-to-end flow from TUI: view history, select snapshot,
see diff, confirm rollback, observe progress, verify result.

---

## 9. Deployment

A new Ansible role `xinas_history` is added to `site.yml` immediately after
the `xinas_menu` role:

```yaml
# playbooks/site.yml (excerpt)
roles:
  # ... existing roles ...
  - role: xinas_menu
  - role: xinas_history    # <-- new
```

The role performs the following tasks:

1. **Copy package** -- Copies `xinas_history/` to `/opt/xiNAS/xinas_history/`.
2. **Install into venv** -- Runs `pip install -e /opt/xiNAS/xinas_history/`
   in the shared venv at `/opt/xiNAS/venv/`.
3. **Create directory structure** -- Creates
   `/var/lib/xinas/config-history/{baseline,snapshots,state}` with ownership
   `root:root` and mode `0700`.
4. **Install CLI wrapper** -- Creates `/usr/local/bin/xinas-history` as a
   shell script that activates the venv and invokes `python3 -m xinas_history`.
5. **Baseline snapshot** -- If no baseline exists, creates the initial baseline
   snapshot capturing the current system state.

---

## 10. Security Considerations

| Concern | Mitigation |
|---------|------------|
| **File permissions** | `/var/lib/xinas/config-history/` owned by `root:root`, mode `0700`. Only root can read or write snapshots. |
| **Lock integrity** | `fcntl.flock()` provides kernel-level advisory locking that survives interpreter crashes. The lock is released automatically when the owning process exits. |
| **Stale lock recovery** | `lock.meta` records the PID and command line of the holder. If the process no longer exists, the lock is reclaimed on next acquisition attempt. |
| **Audit trail** | All snapshot and rollback operations are logged to the append-only audit log at `/var/log/xinas/audit.log` via the existing `AuditLogger`. |
| **gRPC transport** | gRPC calls to xiRAID use the existing TLS certificate infrastructure. No new certificates or trust stores are introduced. |
| **Secret exclusion** | No secrets are stored in snapshots. The xiRAID license resides at `/tmp/license` (transient, cleared on reboot) and is explicitly excluded from collection. Role defaults and templates contain no credentials. |
| **Atomic writes** | Snapshot directories are written to a temporary location and atomically renamed into place, preventing partial snapshots from being visible to readers. |
