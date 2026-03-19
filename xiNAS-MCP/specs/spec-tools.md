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
| `network.list` | viewer | — | — | — | networkInfo | — |
| `network.configure` | admin | plan/apply | — | — | networkInfo (preflight) | — |
| `health.run_check` | viewer | — | — | raidShow, poolShow, driveFaultyCountShow, licenseShow | Python health engine (subprocess) | — |
| `health.get_alerts` | viewer | — | — | — | — | — |
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
| `job.get` | viewer | — | — | — | JobManager | — |
| `job.list` | viewer | — | — | — | JobManager | — |
| `job.cancel` | operator | — | — | — | JobManager | — |
| `config.list_snapshots` | viewer | — | — | — | config-history subprocess | — |
| `config.show_snapshot` | viewer | — | — | — | config-history subprocess | — |
| `config.diff_snapshots` | viewer | — | — | — | config-history subprocess | — |
| `config.check_drift` | operator | — | — | — | config-history subprocess | — |
| `config.get_status` | viewer | — | — | — | config-history subprocess | — |
| `config.rollback` | admin | plan/apply | — | — | config-history subprocess | — |

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
| Any | xiRAID gRPC UNAVAILABLE ×5 | INTERNAL |
| Any | array locked by another operation | CONFLICT |
| Any | insufficient role | PERMISSION_DENIED |
