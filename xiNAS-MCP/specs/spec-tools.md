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
| `health.run_check` | viewer | — | — | raidShow, poolShow, driveFaultyCountShow, licenseShow | systemInfo, diskInfo, networkInfo | — |
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
| `job.get` | viewer | — | — | — | JobManager | — |
| `job.list` | viewer | — | — | — | JobManager | — |
| `job.cancel` | operator | — | — | — | JobManager | — |

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

## Health Check Details

### Profile Coverage

| Check | quick | standard | deep |
|---|---|---|---|
| RAID integrity (raidShow) | ✓ | ✓ | ✓ |
| NFS daemons | ✓ | ✓ | ✓ |
| Network links | ✓ | ✓ | ✓ |
| Memory pressure | ✓ | ✓ | ✓ |
| License validity | ✓ | ✓ | ✓ |
| Spare pools | — | ✓ | ✓ |
| Faulty counts | — | ✓ | ✓ |
| Drive health (NVMe sysfs) | — | ✓ | ✓ |

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
| Any | xiRAID gRPC UNAVAILABLE ×5 | INTERNAL |
| Any | array locked by another operation | CONFLICT |
| Any | insufficient role | PERMISSION_DENIED |
