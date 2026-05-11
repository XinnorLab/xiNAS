# MCP Tools Specification

All tools are registered in `src/registry/toolRegistry.ts` and implemented in `src/tools/`.

---

## Tool Summary Table

| Tool | Min Role | Plan/Apply | Locking | gRPC | OS | NFS |
|---|---|---|---|---|---|---|
| `system.get_server_info` | viewer | — | — | — | — | — |
| `system.list_controllers` | viewer | — | — | — | — | — |
| `system.get_controller_capabilities` | viewer | — | — | settings, license | — | — |
| `system.get_status` | viewer | — | — | settings, license | systemInfo, serviceState | — |
| `system.get_inventory` | viewer | — | — | — | systemInfo, diskInfo, networkInfo | — |
| `system.get_performance` | viewer | — | — | — | prometheusClient | — |
| `system.get_logs` | viewer | — | — | — | journalctl | — |
| `network.list` | viewer | — | — | — | networkInfo | — |
| `network.configure` | admin | plan/apply | — | — | networkInfo (preflight) | — |
| `health.run_check` | viewer | — | — | raidShow, poolShow, driveFaultyCountShow, licenseShow | Python health engine (subprocess) | — |
| `health.get_alerts` | viewer | — | — | — | — | — |
| `health.fix_nfs_conf` | admin | — | — | — | — | fixNfsConf (writes /etc/nfs.conf, restarts nfs-server) |
| `disk.list` | viewer | — | — | raidShow | diskInfo | — |
| `disk.get_smart` | viewer | — | — | — | diskInfo (NVMe sysfs) | — |
| `disk.run_selftest` | operator | — | — | — | — | — |
| `disk.set_led` | operator | — | — | driveLocate | — | — |
| `disk.secure_erase` | admin | plan/apply | — | driveClean | — | — |
| `raid.list` | viewer | — | — | raidShow | — | — |
| `raid.create` | admin | plan/apply | array_id | raidCreate | — | — |
| `raid.modify_performance` | admin | plan/apply | array_id | raidModify | — | — |
| `raid.lifecycle_control` | operator/admin | apply | array_id | raidInit/ReconStart/Stop | — | — |
| `raid.unload` | admin | apply | array_id | raidUnload | — | — |
| `raid.restore` | admin | apply | — | raidRestore | — | — |
| `raid.delete` | admin | plan/apply | array_id | raidDestroy | /proc/mounts | listExports |
| `share.list` | viewer | — | — | — | — | listExports |
| `share.get_active_sessions` | operator | — | — | — | — | getSessions |
| `share.create` | operator | plan/apply | — | — | fs.existsSync | addExport, reload |
| `share.update_policy` | operator | plan/apply | — | — | — | updateExport, reload |
| `share.set_quota` | operator | — | — | — | — | setQuota |
| `share.delete` | operator | plan/apply | — | — | — | removeExport, getSessions, reload |
| `auth.get_supported_modes` | viewer | — | — | settingsAuthShow | fs.existsSync | — |
| `auth.validate_kerberos` | admin | — | — | — | fs.existsSync | — |
| `auth.list_users` | viewer | — | — | — | getent passwd | — |
| `auth.create_user` | admin | plan/apply | — | — | useradd, chpasswd | — |
| `auth.delete_user` | admin | plan/apply | — | — | userdel | getSessions |
| `auth.set_quota` | operator | — | — | — | — | setQuota |
| `auth.list_quotas` | viewer | — | — | — | repquota -a | — |
| `auth.change_password` | admin | plan/apply | — | — | chpasswd | — |
| `auth.set_user_lock` | admin | plan/apply | — | — | usermod -L/-U, passwd -S | — |
| `auth.change_shell` | admin | plan/apply | — | — | chsh | — |
| `auth.add_to_group` | admin | plan/apply | — | — | usermod -aG, getent group | — |
| `auth.remove_from_group` | admin | plan/apply | — | — | gpasswd -d, getent group | — |
| `mail.list_recipients` | viewer | — | — | mailShow | — | — |
| `mail.add_recipient` | admin | plan/apply | — | mailAdd | — | — |
| `mail.remove_recipient` | admin | plan/apply | — | mailRemove | — | — |
| `mail.get_settings` | viewer | — | — | settingsMailShow | — | — |
| `mail.update_settings` | admin | plan/apply | — | settingsMailModify | — | — |
| `mail.send_test` | operator | — | — | — | xicli mail send | — |
| `job.get` | viewer | — | — | — | JobManager | — |
| `job.list` | viewer | — | — | — | JobManager | — |
| `job.cancel` | operator | — | — | — | JobManager | — |
| `config.list_snapshots` | viewer | — | — | — | config-history subprocess | — |
| `config.show_snapshot` | viewer | — | — | — | config-history subprocess | — |
| `config.diff_snapshots` | viewer | — | — | — | config-history subprocess | — |
| `config.check_drift` | operator | — | — | — | config-history subprocess | — |
| `config.get_status` | viewer | — | — | — | config-history subprocess | — |
| `config.rollback` | admin | plan/apply | — | — | config-history subprocess | — |
| `pool.list` | viewer | — | — | poolShow | — | — |
| `pool.create` | admin | plan/apply | — | poolCreate | — | — |
| `pool.delete` | admin | plan/apply | — | poolDelete | — | — |
| `pool.add_drives` | admin | plan/apply | — | poolAdd | — | — |
| `pool.remove_drives` | admin | plan/apply | — | poolRemove | — | — |
| `pool.activate` | operator | — | — | poolActivate | — | — |
| `pool.deactivate` | operator | — | — | poolDeactivate | — | — |
| `pool.acquire` | admin | — | — | poolAcquire | — | — |

---

## RAID Preflight Logic

### `raid.create` preflight
1. `memory_limit >= 1024` MiB
2. `drives.length >= MIN_DRIVES[level]`: 0→2, 1→2, 5→3, 6→4, 7→4, 10→4, 50→6, 60→8, 70→8
3. `group_size` required for levels 50, 60, 70
4. `drives.length % group_size === 0` (warning if not)
5. Level 7 + >20 drives → warning about Level 7.3 (N+M)

### `raid.delete` preflight
1. Check `/proc/mounts` for `/dev/xi_<name>` — block if mounted
2. Call `listExports()` — block if any export path under the array's mountpoint
3. `dangerous=true` required — block if absent

---

## Auth User Management Preflight Logic

### `auth.create_user` preflight
1. Validate username matches `^[a-z_][a-z0-9_-]{0,31}$` — block if invalid (INVALID_ARGUMENT)
2. Check `getent passwd <username>` — block if user already exists (CONFLICT)
3. Check home_dir parent exists (`fs.existsSync`) — block if missing (PRECONDITION_FAILED)

### `auth.delete_user` preflight
1. Check `getent passwd <username>` — block if user doesn't exist (NOT_FOUND)
2. Call `getSessions()` — warn if user has active NFS sessions
3. Check UID >= 1000 — block if attempting to delete system user (PRECONDITION_FAILED)

### `auth.change_password` preflight
1. Check user exists via `getent passwd` — block if not found (NOT_FOUND)
2. Check UID >= 1000 — block if system user (PRECONDITION_FAILED)
3. Validate `password === password_confirm` — block if mismatch (INVALID_ARGUMENT)

### `auth.set_user_lock` preflight
1. Check user exists via `getent passwd` — block if not found (NOT_FOUND)
2. Check UID >= 1000 — block if system user (PRECONDITION_FAILED)
3. Check current lock state via `passwd -S` — warn if already in requested state

### `auth.change_shell` preflight
1. Check user exists via `getent passwd` — block if not found (NOT_FOUND)
2. Check UID >= 1000 — block if system user (PRECONDITION_FAILED)
3. Check shell binary exists via `fs.existsSync` — block if not found (PRECONDITION_FAILED)

### `auth.add_to_group` preflight
1. Check user exists via `getent passwd` — block if not found (NOT_FOUND)
2. Check UID >= 1000 — block if system user (PRECONDITION_FAILED)
3. Check group exists via `getent group` — block if not found (NOT_FOUND)
4. Check user not already a member — block if duplicate (CONFLICT)

### `auth.remove_from_group` preflight
1. Check user exists via `getent passwd` — block if not found (NOT_FOUND)
2. Check UID >= 1000 — block if system user (PRECONDITION_FAILED)
3. Check group exists via `getent group` — block if not found (NOT_FOUND)
4. Check user IS a member — block if not a member (PRECONDITION_FAILED)
5. Check group is not user's primary group — block if primary (PRECONDITION_FAILED)

---

## Pool Preflight Logic

### `pool.create` preflight
1. Validate `name` matches `^[a-zA-Z0-9_-]+$` — block if invalid (INVALID_ARGUMENT)
2. `drives.length >= 1` — block if empty (INVALID_ARGUMENT)
3. Cross-check drives against `raidShow()` — block if any drive is a RAID member (CONFLICT)
4. Cross-check drives against `poolShow()` — block if any drive is in another pool (CONFLICT)

### `pool.delete` preflight
1. Verify pool exists via `poolShow(name)` — block if not found (NOT_FOUND)
2. Cross-check against `raidShow()` — block if pool is assigned to any RAID array (PRECONDITION_FAILED)
3. `dangerous=true` required — block if absent (PRECONDITION_FAILED)

### `pool.add_drives` preflight
1. Verify pool exists via `poolShow(name)` — block if not found (NOT_FOUND)
2. `drives.length >= 1` — block if empty (INVALID_ARGUMENT)
3. Cross-check drives against `raidShow()` — block if any drive is a RAID member (CONFLICT)
4. Cross-check drives against `poolShow()` — block if any drive is in another pool (CONFLICT)

### `pool.remove_drives` preflight
1. Verify pool exists via `poolShow(name)` — block if not found (NOT_FOUND)
2. Verify all specified drives are members of the pool — block if any are not (INVALID_ARGUMENT)

---

## Health Check Details

### Architecture

`health.run_check` uses a hybrid approach:

1. **gRPC checks (TypeScript)** — xiRAID-specific checks that require the xiRAID gRPC API: RAID integrity, license validity, spare pools, faulty drive counts.
2. **Python health engine (subprocess)** — OS-level checks delegated to `python3 -m xinas_menu.health` via subprocess bridge (`src/os/healthEngine.ts`). Follows the same subprocess pattern as `configHistory.ts`.

The Python engine is the single source of truth for all OS-level health checks. Status mapping: `PASS`→`OK`, `WARN`→`WARN`, `FAIL`→`CRIT`, `SKIP`→filtered out.

### Subprocess Protocol

- Command: `python3 -m xinas_menu.health <profile_path> /tmp --json --no-save`
- Timeout per profile: quick=60s, standard=300s, deep=600s
- Success: exit 0, stdout = JSON report (`EngineReport`)
- Error: exit non-zero — reported as single `UNKNOWN` check (non-fatal)

### Profile Coverage

#### gRPC Checks (TypeScript)

| Check | quick | standard | deep |
|---|---|---|---|
| RAID integrity (raidShow) | ✓ | ✓ | ✓ |
| License validity (licenseShow) | ✓ | ✓ | ✓ |
| Spare pools (poolShow) | — | ✓ | ✓ |
| Faulty drive counts (driveFaultyCountShow) | — | ✓ | ✓ |

#### Python Engine Checks (subprocess)

| Section | Check | quick | standard | deep |
|---|---|---|---|---|
| Services | NFS daemons, systemd units | ✓ | ✓ | ✓ |
| Network | Link state, MTU, somaxconn, SunRPC slots | ✓ | ✓ | ✓ |
| VM (sysctl) | dirty_ratio, swappiness, MGLRU, watermark_scale | ✓ | ✓ | ✓ |
| NVMe Health | Temperature, spare, media errors | — | ✓ | ✓ |
| Memory | Pressure, huge pages | ✓ | ✓ | ✓ |
| Filesystem | XFS mount options, stripe alignment | — | ✓ | ✓ |
| PerfTuning | NVMe poll_queues, read_ahead, CPU c-state, IRQ balance, I/O scheduler | ✓ | ✓ | ✓ |
| RDMA | IB device state, GID table | — | — | ✓ |
| Kerberos | Keytab, time sync, krb5.conf | — | — | ✓ |

### Alert Deduplication
Alerts are keyed by `check_id`. A new check run updates `last_seen` if the alert already exists (same `check_id`, not acknowledged). New alerts are pushed to ring buffer (max 100).

### `health.fix_nfs_conf`

Targeted remediation for the NFS-related findings of `health.run_check`. Edits `/etc/nfs.conf` in place via `xinas-nfs-helper` (op: `fix_nfs_conf`), preserving Ansible blockinfile markers and unrelated keys, and optionally restarts `nfs-server`.

Parameters (at least one of `threads`, `rdma`, or `updates` is required):
- `threads`: `number | "auto"` — sets `[nfsd] threads` and `[exportd] threads`. `"auto"` resolves to the physical CPU core count (same calculation the `nfs_server` Ansible role uses).
- `rdma`: `boolean | "y" | "n" | …` — sets `[nfsd] rdma`.
- `updates`: `{ section: { key: value } }` — free-form additional settings.
- `restart_service`: `boolean` (default `true`) — restarts `nfs-server` only when something changed.

Typical use: the Textual TUI remediation wizard collapses the `NFS.threads_config` + `NFS.rdma_enabled` health findings into a single call to this tool.

---

## Long-Running Jobs

### Creation
- `disk.run_selftest` — creates job, uses `setTimeout` to simulate completion
- `raid.lifecycle_control` (start) — creates job, polls `raidShow` every 30s

### Polling
`job.get(job_id)` returns current `JobRecord` state.

### Cancellation
`job.cancel(job_id)` — sets `state='cancelled'`. Underlying operation continues (no interrupt mechanism in v1).

---

## Error Scenarios by Tool

| Tool | Scenario | Error Code |
|---|---|---|
| `raid.create` | memory_limit < 1024 | PRECONDITION_FAILED (plan) |
| `raid.create` | duplicate array name | CONFLICT (from gRPC) |
| `raid.delete` | filesystem mounted | PRECONDITION_FAILED (plan) |
| `raid.delete` | active NFS export | PRECONDITION_FAILED (plan) |
| `disk.get_smart` | SATA drive | UNSUPPORTED |
| `disk.get_smart` | device not found | NOT_FOUND |
| `share.create` | path not found | PRECONDITION_FAILED (plan) |
| `share.delete` | active sessions, dangerous=false | PRECONDITION_FAILED (plan) |
| `auth.create_user` | invalid username | INVALID_ARGUMENT |
| `auth.create_user` | user already exists | CONFLICT |
| `auth.create_user` | home dir parent missing | PRECONDITION_FAILED (plan) |
| `auth.delete_user` | user not found | NOT_FOUND |
| `auth.delete_user` | system user (UID < 1000) | PRECONDITION_FAILED (plan) |
| `auth.set_quota` | user not found | NOT_FOUND |
| `auth.set_quota` | share path not found | NOT_FOUND |
| `auth.change_password` | user not found | NOT_FOUND |
| `auth.change_password` | system user (UID < 1000) | PRECONDITION_FAILED (plan) |
| `auth.change_password` | passwords don't match | INVALID_ARGUMENT |
| `auth.set_user_lock` | user not found | NOT_FOUND |
| `auth.set_user_lock` | system user (UID < 1000) | PRECONDITION_FAILED (plan) |
| `auth.change_shell` | user not found | NOT_FOUND |
| `auth.change_shell` | shell binary not found | PRECONDITION_FAILED (plan) |
| `auth.add_to_group` | user not found | NOT_FOUND |
| `auth.add_to_group` | group not found | NOT_FOUND |
| `auth.add_to_group` | user already in group | CONFLICT |
| `auth.remove_from_group` | user not found | NOT_FOUND |
| `auth.remove_from_group` | group not found | NOT_FOUND |
| `auth.remove_from_group` | user not in group | PRECONDITION_FAILED (plan) |
| `auth.remove_from_group` | is primary group | PRECONDITION_FAILED (plan) |
| `system.get_logs` | journalctl not available | INTERNAL |
| Any | xiRAID gRPC UNAVAILABLE ×5 | INTERNAL |
| Any | array locked by another operation | CONFLICT |
| Any | insufficient role | PERMISSION_DENIED |
