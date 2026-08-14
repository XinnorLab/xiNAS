# xiNAS — RAID Management from the TUI

This document covers the *day-2* RAID management surface: the Textual TUI screens and the services they call. It is the counterpart to [Installer/raid-spec.md](../Installer/raid-spec.md), which describes how arrays are first created by Ansible.

The TUI never runs `xicli` directly. Since the S8/S9 control-path migration (ADR-0010, ADR-0011), **every array and pool operation — read and write — is a control-path API call** against `xinas-api`; writes go through `plan_apply_wait`. Two adjuncts remain: the xiRAID gRPC client, still used by the Physical Drives screen (§8) for `disk_list` / `drive_locate`, and a small XFS helper module that runs `findmnt` synchronously from the TUI process. The `xinas-nfs-helper` socket is **no longer** on the RAID path at all.

Sources:

- Screens: [xinas_menu/screens/storage.py](../../xinas_menu/screens/storage.py), [raid.py](../../xinas_menu/screens/raid.py), [spare_pools.py](../../xinas_menu/screens/spare_pools.py), [drives.py](../../xinas_menu/screens/drives.py)
- Control-path client: [xinas_menu/api/control_client.py](../../xinas_menu/api/control_client.py) (`ControlClient.result` / `.get` / `.plan_apply_wait`, `quote_id`)
- gRPC helper: [xinas_menu/api/grpc_client.py](../../xinas_menu/api/grpc_client.py)
- NFS helper client: [xinas_menu/api/nfs_client.py](../../xinas_menu/api/nfs_client.py)
- XFS helpers: [xinas_menu/utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)
- Audit + snapshot helpers: [xinas_menu/utils/audit.py](../../xinas_menu/utils/audit.py), [xinas_menu/utils/snapshot_helper.py](../../xinas_menu/utils/snapshot_helper.py)
- Drive picker widget: [xinas_menu/widgets/drive_picker.py](../../xinas_menu/widgets/drive_picker.py)
- Control-path contract: [docs/control-path/api-v1.yaml](../control-path/api-v1.yaml), [s8-clients-spec.md](../control-path/s8-clients-spec.md) (§6 is the authoritative teardown contract), [ADR-0011](../control-path/adr/0011-config-history-audit-pools.md) (pools)
- gRPC service contract: [xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto), [message_raid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/message_raid.proto), [message_pool.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/message_pool.proto)
- NFS helper daemon: [xiNAS-MCP/nfs-helper/nfs_helper.py](../../xiNAS-MCP/nfs-helper/nfs_helper.py), [xinas-nfs-helper.service](../../xiNAS-MCP/nfs-helper/xinas-nfs-helper.service)

---

## 1. Where this lives in the TUI

`xinas-menu` (entry point `xinas_menu/__main__.py`) launches the Textual app with `ControlClient` mounted as `self.app.control`, `XiRAIDClient` as `self.app.grpc`, and `NFSHelperClient` as `self.app.nfs`. RAID Management and Spare Pools use `self.app.control` exclusively; Physical Drives is the one screen in this document that still uses `self.app.grpc`, and none of the three touch `self.app.nfs`. The user reaches RAID via:

```
Main Menu → Storage (StorageScreen) → 1 RAID Management (RAIDScreen)
                                    → 5 Spare Pools     (SparePoolScreen)
                                    → 3 Physical Drives (PhysicalDrivesScreen)
                                    → 4 Filesystem      (FilesystemScreen, covered in storage/fs spec)
```

`StorageScreen` is just a router — see [storage.py](../../xinas_menu/screens/storage.py). All real work happens in the child screens.

### RAIDScreen menu

| Key | Action | Handler in `raid.py` |
|---|---|---|
| 1 | Quick Overview | `_show_quick()` → `GET /api/v1/arrays` |
| 2 | Extended Details | `_show_extended()` → `GET /api/v1/arrays` (same call; renders `spec.tuning` too) |
| 3 | Spare Pools | pushes `SparePoolScreen` |
| 4 | Create Array | `_create_array_wizard()` |
| 5 | Edit Array | `_modify_array()` |
| 6 | Delete Array | `_delete_array()` |

`on_mount` runs Quick Overview immediately, so opening the screen kicks a `GET /api/v1/arrays` against `xinas-api`.

---

## 2. The service layer behind RAID Management

RAID and pool work crosses exactly one boundary — never `subprocess('xicli …')`. The TUI is a thin presenter; **`xinas-api`** is the service layer, and the agent behind it is what reaches the xiRAID daemon.

```
┌──────────────────────┐
│  xinas-menu (TUI)    │
│   Python / Textual   │
│   runs as root       │
└─────┬──────────┬─────┘
      │          │
      │ HTTP     │ gRPC :6066
      │ (control │ (Physical Drives
      │  path)   │  screen only)
      ▼          │
┌──────────────┐ │
│  xinas-api   │ │
│  plan/apply  │ │
│  + task wait │ │
└──────┬───────┘ │
       │         │
       ▼         │
┌──────────────┐ │
│  xinas-agent │ │
└──────┬───────┘ │
       │         │
       ▼         ▼
┌────────────────────┐
│  xRAID gRPC daemon │
│  (xiRAID-Classic)  │
└─────────┬──────────┘
          │ ioctl + xicli
          ▼
     xiRAID kmod
     /dev/xi_<name>
```

Writes are never fire-and-forget: `ControlClient.plan_apply_wait(method, path, spec, …)` submits the intent, applies the resulting plan (with `dangerous=True` where the endpoint demands it), and blocks on the task, streaming stage transitions to an `on_progress` callback and honouring a `cancel_check`. Plan blockers surface as `ControlPathError` before anything is touched.

The one in-process helper left on the RAID path is `xinas_menu/utils/xfs_helpers.py` — no separate service; it shells out to `findmnt` via `asyncio.create_subprocess_exec` (§2.4).

### 2.1 `XiRAIDClient` — gRPC bridge to xiRAID

Source: [xinas_menu/api/grpc_client.py](../../xinas_menu/api/grpc_client.py).

**Scope note.** Of the screens in this document, only Physical Drives (§8) still calls this client — `disk_list()` and `drive_locate()`. RAID Management and Spare Pools do not import it. The client's remaining RAID/pool methods are described below because they are still the contract the *agent* speaks on the far side of `xinas-api`, and because the client keeps them available; they are not the TUI's call path.

- **Address:** `localhost:6066` (hardcoded, `_GRPC_ADDRESS`).
- **Transport:** `grpc.aio` channel. Secure by default — TLS root cert resolved in this order:
  1. `tls_cert` / `cert_path` from `/etc/xinas-mcp/config.json` (matches the MCP TS client's path priority).
  2. `/etc/xraid/crt/ca-cert.pem` (primary fallback).
  3. `/etc/xraid/crt/ca-cert.crt` (alternate extension).
  4. `/etc/xiraid/server.crt` (legacy).
  5. `/etc/xinas-mcp/server.crt`.
  6. **Insecure channel** with a `UserWarning` (dev-mode only).
- **Stub:** `XRAIDServiceStub` — generated at install time by the `xinas_menu` Ansible role from the protos at `/opt/xiNAS/xiNAS-MCP/proto/xraid/gRPC/protobuf/` (see [collection/roles/xinas_menu/defaults/main.yml](../../collection/roles/xinas_menu/defaults/main.yml) `xinas_menu_proto_files`). Until stubs exist, every call returns `(False, None, "gRPC stubs not available: <ImportError>")`.
- **Channel options:** `initial_reconnect_backoff_ms=500`, `max_reconnect_backoff_ms=2000`, `enable_retries=0`. Reconnects are bounded; retries are off so the UI sees real failures instead of silent retransmits.
- **Response convention:** every RPC returns `ResponseMessage { optional string message = 1 }`. The TUI parses `message` as JSON; if it isn't valid JSON, the raw string passes through. All public methods return the same shape:
  ```python
  (ok: bool, data: Any, error: str)
  ```
  Errors never raise into the UI layer.
- **RPC naming gotcha:** the service is `XRAIDService` (capital `XRAID`), but request messages live in `message_*_pb2`, **not** `service_xraid_pb2`. The client's `_import_stubs()` imports the message modules separately.

### 2.2 The RAID/pool endpoints the TUI uses

Every array and pool operation in these screens is one of these calls. Reads go through `control.result(path)` (or `control.get(path)` when the screen needs the envelope's `warnings` — §3.1); writes through `control.plan_apply_wait(...)`. Ids are always percent-encoded as a single path segment with `quote_id()` (s8-clients-spec §6).

| Operation | Call | Used by |
|---|---|---|
| List arrays | `GET /api/v1/arrays` | Quick / Extended overview, every edit/delete pre-check |
| Create array | `POST /api/v1/arrays` | Create wizard (§4) |
| Modify array | `PATCH /api/v1/arrays/{id}` | Edit Array (§5) |
| Destroy array | `DELETE /api/v1/arrays/{id}` (`dangerous=True`) | Delete Array (§6), teardown step 3 |
| List disks | `GET /api/v1/disks` | Create wizard, spare-pool drive picker |
| List shares | `GET /api/v1/shares` | Delete Array dependency discovery |
| Delete share | `DELETE /api/v1/shares/{id}` | Delete Array, teardown step 1 |
| List filesystems | `GET /api/v1/filesystems` | Delete Array dependency discovery |
| Unmount filesystem | `PATCH /api/v1/filesystems/{id}` `{"mounted": false}` | Delete Array, teardown step 2 |
| Unmanage filesystem | `DELETE /api/v1/filesystems/{id}` | Delete Array, teardown step 2 |
| Pools | `GET` / `POST` / `PATCH` / `DELETE /api/v1/pools[/{name}]` | Spare Pools (§7), spare-pool pickers in §4 / §5.2 |

The array create spec (`XiraidArray.spec`, [api-v1.yaml](../control-path/api-v1.yaml)) carries `name`, `level` (`"raid<N>"`), `member_disk_ids`, `strip_size_kib`, and optionally `group_size` and `spare_disk_ids`. `force_metadata` is **not** set from the TUI — that flag is reserved for Ansible re-creates where stale metadata is expected.

#### 2.2.1 The daemon-side RPCs behind those endpoints

Retained for reference: the `XiRAIDClient` methods and the protos in [service_xraid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto) that the agent's executors ultimately drive. **No screen in this document calls these** (see the §2.1 scope note) except the two marked *drives screen*.

| Python method | RPC | Request message |
|---|---|---|
| `disk_list()` | `disk_list` | — (*drives screen*, §8) |
| `drive_locate(drives)` | `drive_locate` | — (*drives screen*, §8) |
| `raid_show(units, name, extended)` | `raid_show` | `RaidShow` |
| `raid_create(name, level, drives, **kwargs)` | `raid_create` | `RaidCreate` |
| `raid_modify(name, **kwargs)` | `raid_modify` | `RaidModify` |
| `raid_destroy(name, force)` | `raid_destroy` | `RaidDestroy` |
| `raid_unload(name)` | `raid_unload` | `RaidUnload` |
| `raid_init_start` / `raid_init_stop` / `raid_recon_start` / `raid_recon_stop` | matching RPCs | — |
| `pool_show` / `pool_create` / `pool_delete` / `pool_add` / `pool_remove` / `pool_activate` / `pool_deactivate` | matching RPCs | matching messages |

### 2.3 `NFSHelperClient` — Unix-socket bridge to xinas-nfs-helper

Source: [xinas_menu/api/nfs_client.py](../../xinas_menu/api/nfs_client.py).

- **Socket:** `/run/xinas-nfs-helper.sock` (created by the systemd `RuntimeDirectory=xinas-nfs-helper`).
- **Protocol:** newline-delimited JSON.
  - Request: `{"op": "<name>", "request_id": "<uuid>", ...fields}\n`
  - Response: `{"ok": true|false, "result": ..., "request_id": "<uuid>"}\n`
- **Timeout:** `10.0 s` per call.
- **Synchronous** — calls block; the TUI uses it from `@work(exclusive=True)` Textual workers which already run off the UI thread.

The helper itself is a small Python daemon running as `root`, started by `xinas-nfs-helper.service` ([source](../../xiNAS-MCP/nfs-helper/xinas-nfs-helper.service)). It is the **only** writer of `/etc/exports` and `/etc/nfs.conf` outside of Ansible — both the TUI and the MCP server go through it so the audit story stays consistent. It runs `After=network.target nfs-kernel-server.service`, `Requires=nfs-kernel-server.service`, and sets `ProtectHome=true` (but not `ProtectSystem=full` — see the comment in the unit file).

Ops it exposes (one Python handler each, from [nfs_helper.py](../../xiNAS-MCP/nfs-helper/nfs_helper.py)):

| `op` | Behavior |
|---|---|
| `list_exports` | Parses `/etc/exports` and returns the rule list |
| `add_export` | Validates + appends a rule, runs `exportfs -ra` |
| `remove_export` | Removes a rule by path, runs `exportfs -ra` |
| `update_export` | Patches a rule's fields, runs `exportfs -ra` |
| `list_sessions` / `get_sessions` | Reads `/proc/fs/nfsd/clients/*` |
| `set_quota` | `xfs_quota` wrapper (user + project; no group) |
| `reload` | `exportfs -r` |
| `fix_nfs_conf` | Re-writes the managed block in `/etc/nfs.conf`, restarts `nfs-server` |

**No RAID screen reaches this client.** Share removal during a RAID teardown is `DELETE /api/v1/shares/{id}` (§6.3). The helper is documented here because it is still the writer of `/etc/exports` on the far side of that call — the agent's NFS executor talks to the same socket ([agent/task/nfs-helper-client.ts](../../xiNAS-MCP/src/agent/task/nfs-helper-client.ts)) — and because other TUI screens (Shares, Users) call it directly.

### 2.4 `xfs_helpers` — async subprocess helpers

Source: [xinas_menu/utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py). Pure Python, no daemon. The RAID screen imports exactly two of its functions, both **read-only**:

- `find_mounts_using_raid(array_name)` — finds every XFS mount whose **data** device is `/dev/xi_<name>` *or* whose mount options carry `logdev=/dev/xi_<name>`. The second case matters: the data array and the log array are separate xiRAID volumes, and `mnt-data.mount` references the log via `Options=…,logdev=/dev/xi_log,…`. Deleting `xi_log` without unmounting `/mnt/data` first would leave the XFS log dangling. This local `findmnt` read is kept alongside `GET /api/v1/filesystems` because the API does not model log-device usage as a `backing_device` (§6.1).
- `is_path_under(path, mountpoint)` — the containment test that decides which shares a mountpoint owns.

The mutating helpers in the same file — `unmount_filesystem` / `mount_filesystem` (the `systemctl stop/start <unit>` wrappers, see [Installer/fs-exports-spec.md §1.8](../Installer/fs-exports-spec.md#18-mountpoint-and-systemd-mount-unit)) — and the geometry / mkfs / mount-unit helpers belong to the Filesystem screen. The RAID screen does **not** call them: unmounting during a teardown is `PATCH /api/v1/filesystems/{id}` (§6.3), and there is no re-mount path at all (§6.4).

### 2.5 Cross-cutting helpers: audit + snapshots

Every RAID write (create / modify / destroy) goes through two side-channel helpers:

- **Audit log** ([utils/audit.py](../../xinas_menu/utils/audit.py)) — appends one line per action to `/var/log/xinas/audit.log` in the format `YYYY-MM-DD HH:MM:SS | user | action | STATUS | detail`. `action` strings are stable identifiers like `raid.create`, `raid.modify`, `raid.destroy`, `nfs.remove`, `fs.unmount`, `fs.unmanage`. The logger never raises into the UI.
- **Snapshot helper** ([utils/snapshot_helper.py](../../xinas_menu/utils/snapshot_helper.py)) — best-effort `await app.snapshots.record("<operation>", diff_summary=…)`. Backed by `xinas_history.SnapshotEngine` (see [Installer/spec.md §3.11](../Installer/spec.md#311-xinas_history--config-snapshots--rollback)). Failures are logged but never propagate; snapshots are advisory, not transactional.

The audit line is written **after** the apply task reports success. The snapshot is recorded **after** the audit line. Either can fail without affecting the user-visible result.

---

## 3. Read paths — Quick Overview / Extended Details

`_show_quick()` and `_show_extended()` are nearly identical: both `GET /api/v1/arrays` (since S8 — see §3.1), adapt the API rows to the legacy renderer dict with `_arrays_from_api()`, and feed that into `_format_raid_overview()` with `extended=False` / `True`.

`_arrays_from_api()` is the only place the API shape is known. It maps
`spec` → `level` / `strip_size` / `block_size` / `sparepool` /
`member_disk_ids`, `status` → `state` / `size` / `init_progress` /
`volume_path` / `memory_usage_mb`, and **flattens `spec.tuning` onto the
top level** so the renderer reads one flat dict. A key the API does not
carry is left **absent** — the renderer must then print a placeholder,
never a plausible-looking default (§3.2).

Per-member states come from `status.member_states` (S3 spec §5.2): each
entry is `{index, device, states}` with `device` in the same control-path
`Disk` identity as `member_disk_ids`. `_arrays_from_api()` matches them to
the members **by `device` id** and fills the renderer's per-member state
lists — the field `_count_states()` reads. Absent or empty `member_states`
(the fake transport, or an array observed without per-member detail) leaves
those state lists empty, and the breakdown falls back to a bare total.

Quick Overview shows: level, capacity, state list, device counts (online / degraded / offline derived from the per-member `status.member_states`), strip size, spare pool, and an initialisation progress bar when any state is `initing`.

Extended adds three blocks, all sourced from observed `spec.tuning`:

- **Priorities** — `init_prio`, `recon_prio`, `restripe_prio`, `sdc_prio`
- **Performance** — `memory_limit`, `memory_prealloc`, `request_limit`, `cpu_allowed`, plus `block_size` (`spec`) and `memory_usage_mb` (`status`)
- **I/O Scheduler & Merge** — `sched_enabled`, `merge_read_enabled`, `merge_write_enabled`, `adaptive_merge`, plus the four merge timing knobs `merge_read_max`, `merge_read_wait`, `merge_write_max`, `merge_write_wait`

Those are the **control-path** names (ADR-0006 `spec.tuning`), not the daemon's. The daemon→control-path rename happens once, in the agent parser [lib/parse/raid.ts](../../xiNAS-MCP/src/lib/parse/raid.ts):

> **Field names verified against the live daemon** (`xicli raid show --format json [--extended]`, xiRAID Classic on this build). Reconciliations vs earlier drafts of this spec (finding #18):
> - Memory/timing fields carry their unit suffix on the daemon side: **`memory_limit_mb`**, **`memory_prealloc_mb`**, and **`merge_*_usecs`** — the parser strips the suffix to reach the ADR-0006 `tuning` names (`memory_limit`, `memory_prealloc`, `merge_*`) and also accepts the unsuffixed spelling, since the gRPC *request* fields are unsuffixed.
> - **`sdc_prio`** is emitted (Priorities block) and is now documented.
> - **`resync_enabled`** is **not** emitted by the current daemon — removed from this spec, and the Extended block no longer renders a `Resync` row it could only ever fill with a guess. (It is create-only on the gRPC side too — `RaidModify` has no such field — so it is absent from `_MODIFY_PARAMS` as well.)
> - **`memory_usage_mb`** and **`block_size`** appear in the **base** payload, so they survive on `status` / `spec` rather than under `tuning`.

If the row includes `devices_health` or `devices_wear` arrays, a per-device row is appended showing state icon + health + wear%. The control-path `XiraidArray` object carries **neither** today (the daemon returns them only under `extended`, and they are per-drive SMART data that belongs on `Disk`, not on the array), so the block is currently never rendered — it is kept for the day those land.

### 3.1 Degraded-backend honesty

Since the S8 control-path migration the read path rides `GET /api/v1/arrays`
(not `grpc.raid_show()` directly), so `_show_quick()` / `_show_extended()`
fetch the full envelope (`control.get`, not `control.result`) and inspect its
`warnings`. When the envelope carries `DEGRADED_BACKEND_UNAVAILABLE` — the
`XiraidArray` collector is errored, e.g. the xiRAID daemon is unreachable
(control-path contract: [s8-clients-spec §5.1](../control-path/s8-clients-spec.md)) —
the screen renders a distinct banner above any rows
(`⚠ xiRAID backend unavailable — array list may be empty or stale`), and when
the list is empty it **replaces** the `(no RAID arrays configured)`
empty-state with that message. An empty list under a degraded backend must
never read as "genuinely no arrays".

State → icon/colour mapping (from `_state_icon` / `_state_color`):

| State | Icon | Colour |
|---|---|---|
| `online` / `initialized` | `*` | green |
| `initing` / `rebuilding` | `~` | yellow |
| `degraded` | `!` | yellow |
| `offline` / `failed` | `x` | red |
| anything else | `o` | none |

### 3.2 Unobserved tuning values render as unknown

The Extended blocks are pure observation: whatever the agent's collector
read out of `raid_show(extended=true)` and stored in `spec.tuning`. A
value the control path does **not** have (`null`, or the key absent
because the daemon did not emit it — `resync_enabled`, for instance) is
rendered as a placeholder:

| Field kind | Unobserved renders as | Observed renders as |
|---|---|---|
| Priorities (`*_prio`) | `-` | `<n>%` |
| `memory_limit` / `request_limit` | `unknown` | `unlimited` when `0`, else the value |
| `memory_prealloc` | `unknown` | `disabled` when `0`, else `<n> MB` |
| `cpu_allowed` | `unknown` | `all` when empty, else the CPU list (`5-7`, `0,2,4-6`) |
| `block_size` (`spec`) | `unknown` | `<n> bytes` |
| Booleans (`sched_enabled`, `merge_*_enabled`, `adaptive_merge`) | `unknown` | `Enabled` / `Disabled` |
| Merge timings | row omitted when all four are unobserved | `<n> us` |
| `memory_usage_mb` (`status`) | `unknown` | `<n> MB` |

`0` is an observed value, not an absent one — it is exactly how xiRAID
spells "no limit" and "prealloc off" — so the unknown case keys off
`is None`, never off falsiness.

This is the array-detail case of the same rule as §3.1: **an unobserved
value must never render as a plausible default.** Printing `unlimited`,
`all`, or `Disabled` for a knob nobody read tells the operator the array
is configured a way it may not be — the failure mode that hid the missing
`extended: true` on the collector's `raid_show` call, so that Extended
Details reported `Memory Limit | unlimited` while an edit against the
same array was rejected with `Unable to set memory limit to '1028' MiBs.
RAID already has '2048' reserved MiBs.` The Priorities block, which had
no plausible default to fall back on, showed `-%` throughout and was the
only visible symptom.

---

## 4. Create Array wizard

`_create_array_wizard()` runs as a Textual `@work(exclusive=True)` async worker so the UI stays responsive. Like the NFS share wizards ([Storage/fs-shares-management-spec.md §4.3](fs-shares-management-spec.md#43-wizard-navigation-model)), it is built on the generic [xinas_menu/widgets/wizard.py](../../xinas_menu/widgets/wizard.py) driver: a flat list of `WizardStep`s (`name`, `level`, `drives`, `strip`, `group_size`, `spare`, `confirmed`) handed to `run_wizard()`, with `group_size` and `spare` marked conditional via an `applies=` predicate. `run_wizard` computes `allow_back` and `step_no` per step; **every step after the first (`name`) renders a Back button**, and `Back` returns the operator to the previous *applicable* step — skipping `group_size` when the level isn't 50/60, and skipping `spare` when no pools exist — with that step's prior answer pre-filled. Titles are driver-computed `f"Create Array — Step {step_no}"` (no `/N` denominator, unlike the NFS wizards) so a RAID-5 array (no `group_size` step) numbers its steps 1..6 contiguously, with no gap where step 5 would otherwise have been.

**Disks and pools are fetched up front**, before the wizard's step list is even built — this is what lets the `group_size`/`spare` `applies=` predicates and the drives step see their data on every entry, including after a Back:

1. `_list_api_disks(self.app.control)` (`GET /api/v1/disks`, cross-referenced against the arrays list to exclude already-claimed drives) enumerates NVMe drives. **If zero NVMe drives are available, the wizard aborts immediately with a "No available NVMe drives found." dialog — this check now runs before the name prompt is ever shown**, not after Step 3 as in the pre-Back-navigation flow.
2. `GET /api/v1/pools` (via `self.app.control.result`) lists spare pools. A failure here is swallowed (`pools = {}`) rather than aborting the wizard — it just means the `spare` step's `applies=lambda a: bool(pools)` predicate stays `False` and the step is skipped.

### Step — name

`InputDialog` validated by `_array_name_error(name)`, which returns the operator-facing reason or `None`:

- 1 ≤ length ≤ `_ARRAY_NAME_MAX` = **63**.
- Matches `_ARRAY_NAME_RE = ^[a-zA-Z0-9_-]+$`.

**The bound is the API contract, not a TUI preference.** `XiraidArray.spec.name` is `^[A-Za-z0-9_-]{1,63}$` ([api-v1.yaml](../control-path/api-v1.yaml)), so the two must agree: the wizard used to accept 64 characters, which meant a 64-character name passed every wizard step and was then rejected by `POST /api/v1/arrays` at dispatch. Any change to either bound must move both. Pinned by `tests/test_raid_overview.py`.

A failed validation re-prompts via the `while True:` loop until the user enters a valid name or cancels. This is the wizard's first step, so its dialog never renders a Back button.

### Step — RAID level

`SelectDialog` over `_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]`, pre-selecting the previously-chosen level on re-entry. xiRAID Classic accepts all seven; the TUI passes the string through to the array-create spec's `level` field.

**Engine-enforced minimum drive counts (finding #20).** xiRAID Classic enforces higher minimums than textbook RAID math, and `xicli raid create --help` does not document the numbers — an under-count is rejected with e.g. `Error: To create RAID level '5', a minimum of '4' disks are required.`:

| Level | Textbook min | xiRAID min |
|---|---|---|
| 0, 1 | 2 | 2 |
| 5 | 3 | **4** |
| 6 | 4 | 4 |
| 10 | 4 | 4 |
| 50 | 6 | **8** |
| 60 | 6–8 | **8** |

(Minimums per the installer-feedback observations; the RAID-5 value is the engine's own rejection message. They could not be re-probed live here because the engine validates device existence before drive count and no free devices were available.)

The Create wizard does **not** pre-validate drive count against the chosen level — an under-count is caught by the engine only *after* the confirmation step and surfaced as a failure dialog. Pre-checking count-vs-level in the drives step before dispatch (so the operator gets an immediate, actionable message) is a tracked follow-up.

Changing the level on a Back visit can flip whether `group_size` applies going forward — e.g. going from `50` back to `5` — in which case the driver prunes the now-inapplicable `group_size` answer and the wizard skips straight past it on the next advance.

### Step — drives

Drive groups are precomputed from the up-front disk fetch and binned by NUMA node and size category. Threshold for "small" vs "large" is `1 GB` (`SMALL_THRESHOLD = 1_000_000_000`). The split is what lets the wizard offer separate "log" (small `n1` namespaces) and "data" (large `n2` namespaces) groups out of the box.

**First entry** (no prior `drives` answer in this run): the user picks a **drive group** via a `SelectDialog`:

- `All small NVMe, NUMA 0` (etc.) — opens `DrivePickerScreen` pre-filtered to that group, with `preselected=` set to the whole group so the operator can review/deselect.
- `Pick individual drives` — opens `DrivePickerScreen` with all unassigned NVMe drives and no preselection.

Backing out of either picker (`allow_back=True` is hardcoded on both, since they're a sub-step of `drives`) returns to the group-select `SelectDialog`, not out of the `drives` step itself; a Back from the group-select is what returns `BACK` to the driver. Picking zero drives shows a "No drives selected." dialog and re-prompts the group select.

**Re-entry** (the operator already completed this step once and has now navigated Back into it from a later step, e.g. `strip`): the group-select `SelectDialog` is **skipped entirely** — the wizard jumps straight to `DrivePickerScreen` over all NVMe drives with the prior selection **pre-checked** (`preselected=prior`), so revising a drive pick doesn't force re-choosing a group.

`DrivePickerScreen` ([widgets/drive_picker.py](../../xinas_menu/widgets/drive_picker.py)) is the full-screen modal: filter by text/NUMA/size, sort by name/size/model/NUMA, multi-select with Space, `a` to select-all-visible, `d` for the detail dialog, and (when `allow_back` is set) `b` for Back — `Esc` always still cancels the whole wizard, never just this step.

Filters that exclude a drive from the picker:

- `system: True` (any OS-mounted partition on it)
- already a member of some RAID array, or already assigned to a spare pool
- `nvme` not in the name (anything that isn't NVMe — the wizard is NVMe-only)

### Step — strip size

`SelectDialog` over `_STRIP_SIZES = ["16", "32", "64", "128", "256"]` (KB), pre-selecting `"64"` (`selected=answers.get("strip", "64")`) so Enter on first entry still yields the historical default. **`Esc` now cancels the whole wizard**, the same as every other plain-`SelectDialog` step — there is no special-cased "dismiss without choosing silently defaults to 64" behavior anymore; the pre-selection is what makes the common case ("just press Enter") still land on 64.

### Step — group size (RAID 50/60 only, conditional)

`applies=lambda a: a.get("level") in ("50", "60")`. For levels `50` and `60` the wizard prompts for `group_size` as a positive integer; the validation loop re-prompts on bad input. For any other level this step is skipped in both directions — advancing past `strip` goes straight to `spare`/`confirmed`, and Back from a later step lands on `strip`, not on a hidden `group_size` prompt.

### Step — spare pool (conditional on pools existing)

`applies=lambda a: bool(pools)`. If any spare pools exist, a `SelectDialog` offers `(none)` + the sorted pool names, pre-selecting the prior choice on re-entry. If no pools exist at all, the step is skipped silently (no spare pool assigned) — same as before, just expressed as an `applies=` predicate now instead of an inline `if` in a hand-rolled step sequence.

### Confirmation + dispatch

The summary dialog (title `"Confirm Create"`, `allow_back=True`) renders all selections, so the operator can Back up from the summary to revise any earlier answer before creating. On confirm:

1. The spec is assembled from the collected `answers`: `name`, `level` (as `"raid<N>"`), `member_disk_ids` (drive names mapped to disk ids via the up-front disk fetch), `strip_size_kib`, plus `group_size` and `spare_disk_ids` when applicable.
2. `POST /api/v1/arrays` is submitted via `self.app.control.plan_apply_wait(...)`, with progress and cancellation surfaced through a `TaskWaitDialog`.
3. On success: `audit.log("raid.create", "<name> RAID-<level> (<n> drives)", "OK")` + `snapshots.record("raid_create", …)` + Quick Overview is refreshed.
4. On cancellation: a "Create cancelled — partial work rolled back." dialog is shown.
5. On failure: a `ConfirmDialog` shows the create error.

---

## 5. Edit Array

`_modify_array()` is parameter-by-parameter — the TUI does not let the operator edit multiple knobs in one round-trip (this matches `raid_modify`'s semantics of "set the fields you specify, leave the rest alone").

Steps:

1. **Pick an array.** `GET /api/v1/arrays` → `SelectDialog` over array names.
2. **Pick a parameter.** `SelectDialog` over `_MODIFY_PARAMS`, each tuple of `(key, label, kind, options, value_type)`. Parameters offered, in order: CPU Affinity, Spare Pool, Init Priority, Recon Priority, Scheduler Enabled, Memory Limit, Merge Read Enabled, Merge Write Enabled, Merge Read Max, Merge Write Max. (`resync_enabled` is create-only — xiRAID's `RaidModify` has no such field — so it is not offered.) The two merge-max knobs are **times in microseconds** (the daemon spells them `merge_*_usecs`), so their labels read `(us)` — they were mislabelled `(KB)` until the tuning surface became observable and read and write paths could be compared.
3. **Per-parameter prompt** — see §5.1.
4. **Confirm + dispatch.** Value is coerced to the declared `vtype` (`int` for the integer knobs, `str` for the rest) and mapped onto the ADR-0006 writable subset — `sparepool` becomes `{"spare_disk_ids": [...]}`, everything else `{"tuning": {key: value}}`. `PATCH /api/v1/arrays/{name}` is submitted via `plan_apply_wait`. On success: audit (`raid.modify`) + snapshot (`raid_modify`) + Quick Overview refresh. On `ControlPathError`: an OK-only `Edit failed.` dialog.

Step 1 guards the empty case: if the array listing fails or returns no arrays, the flow aborts on an **OK-only** dialog ("No RAID arrays configured." / "No arrays available."). Delete Array (§6) guards the same way. This is one instance of the screen-wide dialog convention — see §12.

### 5.1 CPU Affinity dialog (special case)

CPU affinity is the only knob with a multi-mode UI. The current value is read from the array dict (`arr["cpu_allowed"]`, defaulting to `"all"`). It arrives as a range-compressed CPU list (`5-7`, `0,2,4-6`) — the same spelling the Manual CPU List mode accepts — so what the dialog shows is what an operator would retype. The `"all"` default now means the knob was genuinely not observed; it used to also cover a pinned array whose affinity the parser dropped for arriving as an array of core ids rather than a string (see `docs/control-path/s3-xiraid-array-spec.md` §2).

- **All CPUs (reset)** — sends an empty string, which xiRAID interprets as "no restriction".
- **NUMA Node** — `_get_numa_topology()` reads `/sys/devices/system/node/node*/cpulist` for each node and maps NVMe drives to nodes via `disk_list()`'s `numa_node`. The dialog shows `NUMA 0 (CPUs 0-15) — nvme0, nvme1, …` so the operator can pin the array to the NUMA node hosting its drives.
- **Manual CPU List** — free-form text validated against `_CPU_LIST_RE = ^\d+(-\d+)?(,\d+(-\d+)?)*$` (e.g. `0,2,4-7`). Bad input shows an error dialog and aborts.

This is the only place where the TUI itself reads `/sys` rather than going through gRPC — NUMA topology is not part of the xiRAID API.

### 5.2 Spare-pool selection

`spare_pool` is also dynamic — instead of free-form input, `GET /api/v1/pools` is queried and a `SelectDialog` is offered. If no pools exist, the operator is told via `notify(severity="warning")` and the dialog aborts. The chosen pool's drive paths are mapped to disk ids (via `GET /api/v1/disks`) to build the PATCH's `spare_disk_ids`; a pool with no drives aborts with a warning rather than sending an empty list.

This is also the only knob in §5 whose PATCH spec is not under `tuning`.

---

## 6. Delete Array — ordered, stop-on-failure teardown

This is the most complex flow in the screen because deleting a RAID array can cascade into NFS shares and filesystems. The deletion path is a **sequence of control-path API operations**, each one a `plan_apply_wait` of its own; it is *not* a transaction, and there is no cross-step rollback (§6.4). The authoritative contract is [s8-clients-spec §6](../control-path/s8-clients-spec.md#6-tui-composite-teardown-t13).

### 6.1 Dependency discovery

For the selected array name `arr_name` (whose row already yields `volume_path`, defaulting to `/dev/xi_<name>`):

1. `find_mounts_using_raid(arr_name)` (from `xfs_helpers`) — a **local `findmnt` read**, returning every mount whose data device is `/dev/xi_<name>` *or* whose mount opts carry `logdev=/dev/xi_<name>`. Each result carries a `role` field (`"data"` or `"log"`). This read is kept alongside the API because the control path does not model log-device usage as `backing_device`, so a log array's dependents are invisible to `GET /api/v1/filesystems` alone.
2. `GET /api/v1/shares` — every share whose `spec.path` is under one of those mountpoints (`is_path_under`) goes into `affected_shares` as `{id, path}`. Skipped entirely when step 1 found no mountpoints.
3. `GET /api/v1/filesystems` — every filesystem whose `status.backing_device` equals the array's `volume_path`, **or** whose `status.mountpoint` is one of those mountpoints, goes into `affected_fs` as `{id, mountpoint, mounted}`.

A `ControlPathError` on either listing degrades to an empty list rather than aborting: the operator still sees the confirmation, with the un-listable dependents simply absent from it.

### 6.2 Two-stage confirmation

The first dialog shows the array summary, the list of NFS shares that will be removed, and the list of filesystems that will be unmounted/unmanaged. A mount found by `findmnt` but not present in `affected_fs` is still listed, annotated `(<role> device — not API-managed)`.

When the array has dependencies, a **second** `FINAL CONFIRMATION` dialog appears restating the counts. This is the only place in the screen where double confirmation is required. Together they are the `dangerous=True` consent that the array-delete apply requires — there is no separate dangerous prompt later.

### 6.3 The teardown order

Once both confirmations pass, the screen runs three steps **in order**, each rendered into the teardown progress view with its task's stage transitions:

```
Step 1: for each affected share       DELETE /api/v1/shares/{id}
Step 2: for each affected filesystem  PATCH  /api/v1/filesystems/{id} {"mounted": false}   (if mounted)
                                      DELETE /api/v1/filesystems/{id}                      (unmanage)
Step 3: the array itself              DELETE /api/v1/arrays/{id}  (dangerous=True)
```

The order matters: stopping the mount before the share is removed would orphan an active export; destroying the array before the mount is gone would leave systemd holding a stale device reference.

Step 3 additionally raises a `TaskWaitDialog` so the destroy — the long step — is cancellable; its `cancel_requested` is passed as the `cancel_check`.

### 6.4 Partial teardown — no cross-step rollback

**The sequence stops at the first failing step, and everything already completed stays completed.** Steps 1 and 2 are plain `for` loops over `plan_apply_wait` calls; a `ControlPathError` from any of them calls `_teardown_failed(...)` and returns. There is no bookkeeping of removed shares or unmounted filesystems to undo, and the screen never re-creates a share or re-mounts a filesystem — those paths do not exist in `raid.py`.

This is deliberate, per s8-clients-spec §6: rollback belongs to the task engine, one apply at a time. Each individual step's apply either lands or rolls itself back where its executor supports that; the TUI does not stack a second, weaker rollback layer on top of steps that already succeeded and were reported as successful.

**What the operator is told.** `_teardown_failed` appends two lines to the progress view —

```
  FAILED: <error>
  Teardown stopped — remaining steps were not run.
```

— and raises an OK-only dialog titled **`Delete Array — Stopped`** naming the step that failed, the error, and, verbatim: *"Teardown stopped at this step. No cross-step rollback; the failed task rolled itself back where supported."* The progress view above it still shows every step that did complete, in order.

Cancelling the step-3 destroy is reported separately: the progress view gets `Destroy CANCELLED — partial work rolled back (shares/filesystems already removed stay removed).` and a warning notification. The cancellation rolls back the destroy task only.

**Manual recovery.** The system is left in a valid but partially-torn-down state, and recovery is an ordinary forward operation, not an undo:

| Stopped at | State | Recovery |
|---|---|---|
| Step 1, share *k* | shares 1..*k-1* deleted; everything else intact | Re-create the missing shares from the Shares screen (or `POST /api/v1/shares`), or continue the teardown once the blocker is cleared. |
| Step 2, filesystem *k* | all shares deleted; filesystems 1..*k-1* unmounted + unmanaged | Fix the blocker (usually a busy mount — see §10), then either re-run Delete Array to finish, or re-manage/re-mount the filesystem and re-create its shares. |
| Step 3 (destroy) | all shares and filesystems gone; array still present | The array is intact and its data still readable. Re-run Delete Array once the daemon-side blocker is cleared, or re-create the filesystem and shares on top of it. |

The audit log records each completed step (§6.5), so the boundary between "done" and "not run" is reconstructable after the fact — that trail is what a recovery is driven from.

### 6.5 Side effects per step

| Step | Audit action | Snapshot recorded |
|---|---|---|
| 1 — `DELETE /api/v1/shares/{id}` | `nfs.remove` with detail `share=<path> (RAID teardown)` | — |
| 2a — `PATCH /api/v1/filesystems/{id}` `{"mounted": false}` | `fs.unmount` with detail `mountpoint=<mp> (RAID teardown)` | — |
| 2b — `DELETE /api/v1/filesystems/{id}` | `fs.unmanage` with detail `unit=<id> (RAID teardown)` | — |
| 3 — `DELETE /api/v1/arrays/{id}` (`dangerous=True`) | `raid.destroy` with detail `<name>` | `raid_delete` with diff summary |

Each audit line is written only after its own step succeeded, which is what makes the trail a faithful record of where a stopped teardown got to. Step 2a is skipped (and no `fs.unmount` line written) for a filesystem the API already reports as not mounted.

Snapshots are taken **only** on the final RAID destroy step, since the share + filesystem changes are subsumed by the array's disappearance. The snapshot's `diff_summary` counts the removed shares and filesystems for context. A teardown that stops early therefore records **no** snapshot.

---

## 7. Spare Pools (`SparePoolScreen`)

Source: [xinas_menu/screens/spare_pools.py](../../xinas_menu/screens/spare_pools.py). Reached from RAID Management → 3, or from Storage → 5.

Since S9 T11 (ADR-0011) the screen rides the control-path API end to end — it does not import the gRPC client. Reads are `GET /api/v1/pools`, returning rows of `{name, drives, active, referenced_by}`; every mutation is a `plan_apply_wait`.

### 7.1 Menu

A `PATCH` carries **exactly one** intent — `add_drives`, `remove_drives`, or `active`; the API rejects a body that mixes them.

| Key | Action | Control-path call |
|---|---|---|
| 1 | View Pools | `GET /api/v1/pools` |
| 2 | Create Pool | `POST /api/v1/pools` `{name, drives}` |
| 3 | Add Drives | `PATCH /api/v1/pools/{name}` `{add_drives: [...]}` |
| 4 | Remove Drives | `PATCH /api/v1/pools/{name}` `{remove_drives: [...]}` |
| 5 | Activate Pool | `PATCH /api/v1/pools/{name}` `{active: true}` |
| 6 | Deactivate Pool | `PATCH /api/v1/pools/{name}` `{active: false}` |
| 7 | Delete Pool | `DELETE /api/v1/pools/{name}` |

Pool names reach the path via `quote_id()` like every other id (s8-clients-spec §6). Failures render through `_pool_error(action, err)`, which shows a one-line reason plus the wrapped full error.

### 7.2 Drive selection rules

`_get_free_nvme_drives()` enforces the "no double-membership" invariant: a drive can be in **either** a RAID array **or** a spare pool, not both. The function:

1. Calls `_list_api_disks()` (`GET /api/v1/disks`, shared with the RAID Create wizard) for all block drives.
2. Calls `GET /api/v1/pools` and builds a set of paths already in any pool.
3. Filters out: anything missing `nvme` in its name, anything with `system=True`, anything not `safe_for_use`, anything `claimed` (already a member or spare of an observed array), and anything already in `pool_drives` — matched on both the `/dev/` path and the bare name, since pool rows and disk rows spell drives differently.

The result is fed into `DrivePickerScreen` so the operator can apply the same NUMA/size/text filters as in the RAID Create wizard.

### 7.3 Create Pool

Same flow as RAID Create up to the drive picker, then:

1. Pool name validated against `_POOL_NAME_RE = ^[a-zA-Z0-9_-]+$`.
2. Drive picker with `_get_free_nvme_drives()` as the source.
3. Confirmation summary.
4. Names normalised to `/dev/<name>` (`_to_dev_paths` — the picker returns bare names, the pool spec wants paths).
5. `POST /api/v1/pools` `{name, drives}` via `plan_apply_wait`.

No audit / snapshot calls are wired in the *screen* for pool operations — pool changes are not written to `/var/log/xinas/audit.log` by the TUI. They are recorded control-path-side, in the api's own `GET /audit` trail (ADR-0011), which the View Audit Log screen merges with the local trail (see [Management/audit-log-spec.md](../Management/audit-log-spec.md)).

### 7.4 Remove Drives — checklist style

Unlike Add Drives (which uses the full drive picker), Remove Drives uses a simpler `ChecklistDialog` of the current pool members. The operator ticks the drives to evict; `pool_remove` is called with their paths.

### 7.5 Activate / Deactivate

`pool_activate` loads the pool into the running xiRAID state so it can answer hot-spare requests. `pool_deactivate` unloads it — the drive assignments persist, but the pool will not auto-replace a failing member until reactivated.

The Deactivate dialog includes an explanatory note ("Drives will remain assigned but will not be available for automatic replacement.") because it is a non-obvious operation and the rollback story is "just activate it again."

### 7.6 Delete Pool

Single confirmation (no two-stage gate — pools have no downstream FS / NFS dependencies). All member drives are released back to the unassigned set.

---

## 8. Physical Drives screen — inventory, plus LED locate

Source: [xinas_menu/screens/drives.py](../../xinas_menu/screens/drives.py).

This is an inventory view: **no drive's contents or membership can be changed from it.** It is the one screen in this document that still calls the gRPC client directly (`self.app.grpc`, §2.1), not the control-path API.

It loads `grpc.disk_list()` (`lsblk` + `raid_show(extended=True)` membership join), plus the role classifier:

```
system → OS drive (root/boot/EFI partition present)
raid   → in a RAID array (carries raid_name)
pool   → in a spare pool
free   → none of the above
```

Everything else on the screen — sort (`s`), reverse (`r`), text filter (`f`), NUMA filter (`n`), detail (`Enter` / `d`), SMART summary (`m`), SMART full (`Shift+M`) — is local or a read.

**The one exception is `l` — Blink LED.** `action_locate_drive` sends `grpc.drive_locate([name])`, which is a **write RPC**: it changes device state on the enclosure, and on success the screen records an audit event, `audit.log("drive.locate", <name>, "OK")`. It is non-destructive and needs no confirmation dialog, but this screen is not "no RPCs are sent" — describing it that way is what let the claim go stale. A failure is reported through `notify(..., severity="error")` with `grpc_short_error(err)` and writes no audit line.

Apart from `drive_locate`, the screen issues no writes. It is the canonical "what does this box see right now" view, and its data source is what the wizards' drive filters depend on (the wizards read the same inventory through `GET /api/v1/disks`).

---

## 9. End-to-end traces

### 9.1 Operator clicks "Create Array"

```
RAIDScreen._create_array_wizard()
  ├─ _list_api_disks(control)           — GET /api/v1/disks (up front; aborts here if no NVMe)
  ├─ GET /api/v1/pools                  — up front (failure ⇒ spare step just skipped)
  ├─ run_wizard([name, level, drives, strip, group_size?, spare?, confirmed])
  │    ├─ InputDialog (name)                 — TUI only, no Back (first step)
  │    ├─ SelectDialog (level)               — TUI only, Back-enabled
  │    ├─ drives: SelectDialog (group) → DrivePickerScreen
  │    │       — first entry only; re-entry after Back jumps straight to
  │    │         DrivePickerScreen with the prior selection preselected
  │    ├─ SelectDialog (strip size, pre-selects 64)
  │    ├─ InputDialog (group size)           — only if level in {50, 60}
  │    ├─ SelectDialog (spare pool)          — only if pools exist
  │    └─ ConfirmDialog (summary, Back-enabled)
  ├─ POST /api/v1/arrays (name, level, member_disk_ids, strip_size_kib, [group_size], [spare_disk_ids])
  │    └─ plan_apply_wait → control-path API → xiRAID
  ├─ audit.log("raid.create", …, "OK")  — write /var/log/xinas/audit.log
  ├─ snapshots.record("raid_create", …) — xinas_history snapshot
  └─ _show_quick()                      → refresh Quick Overview
```

### 9.2 Operator clicks "Delete Array" on a live data array

```
RAIDScreen._delete_array()
  ├─ GET /api/v1/arrays                 — list arrays
  ├─ SelectDialog (pick array)
  ├─ find_mounts_using_raid("data")     — local findmnt read
  │    ├─ findmnt /dev/xi_data           → /mnt/data role=data
  │    └─ findmnt -t xfs (logdev scan)   → no extra mounts
  ├─ GET /api/v1/shares                 — filtered to paths under /mnt/data
  ├─ GET /api/v1/filesystems            — backing_device or mountpoint match
  ├─ first ConfirmDialog (warning)
  ├─ second ConfirmDialog (FINAL)       — together: the dangerous consent
  ├─ for each affected share:                                    [step 1]
  │    ├─ DELETE /api/v1/shares/{id}     — plan_apply_wait
  │    │    └─ api → agent → nfs-helper: /etc/exports + exportfs -ra
  │    └─ audit.log("nfs.remove", …)
  ├─ for each affected filesystem:                               [step 2]
  │    ├─ PATCH /api/v1/filesystems/{id} {"mounted": false}       (if mounted)
  │    │    └─ audit.log("fs.unmount", …)
  │    ├─ DELETE /api/v1/filesystems/{id}
  │    └─ audit.log("fs.unmanage", …)
  ├─ TaskWaitDialog (cancellable)                                [step 3]
  ├─ DELETE /api/v1/arrays/data          — plan_apply_wait(dangerous=True)
  │    └─ api → agent → xRAID daemon → xicli raid destroy
  ├─ audit.log("raid.destroy", "data", "OK")
  └─ snapshots.record("raid_delete", diff_summary=…)
```

If any step fails, the sequence **stops there** — `_teardown_failed` renders the error and the remaining steps are not run. Steps that already completed are not undone; see §6.4 for what the operator is told and how to recover.

---

## 10. Failure modes the TUI handles explicitly

| Failure | Where | Handling |
|---|---|---|
| `xinas-api` unreachable / apply rejected | every `control.result` / `plan_apply_wait` | Raises `ControlPathError`. Reads that only feed a confirmation degrade to an empty list (§6.1); reads that gate a flow abort on an OK-only dialog; writes abort the step. |
| xiRAID backend down behind a healthy api | `GET /api/v1/arrays` envelope | `DEGRADED_BACKEND_UNAVAILABLE` warning → the screen renders the degraded banner and never shows an empty list as "no arrays" (§3.1). |
| Plan blocked (e.g. pool active or referenced on delete) | api-side plan blockers | `plan_apply_wait` raises before anything is applied; Spare Pools renders it through `_pool_error` with the blocker's reason. |
| gRPC stubs not generated | `XiRAIDClient._import_stubs()` | First RPC returns `(False, None, "gRPC stubs not available: <ImportError>")`. Reaches the operator via the Physical Drives screen (§8); operator runs `--tags xinas_menu` to regenerate. |
| TLS cert missing | `_load_channel_credentials()` | Falls through to insecure channel with a `UserWarning`. Intended only for dev hosts; production should always find a cert. |
| xRAID daemon down | every gRPC RPC (§8 only) | `grpc.aio` raises `RpcError("StatusCode.UNAVAILABLE")`; `_call()` catches and returns `(False, None, str(exc))`. UI shows the short error. |
| Array / pool name too long or with invalid chars | `_array_name_error()` / `_POOL_NAME_RE` | InputDialog re-prompts. The array bound is the API's own `{1,63}` (§4), so a name that passes the wizard is not rejected downstream. |
| Under-count of drives for the chosen RAID level | xiRAID's own validation, via the api | Surfaced only after the confirm step, as a create failure carrying the engine's reason (§4). |
| RAID 10 with no spare pool when one is required | xiRAID's own validation, via the api | Create apply fails; the operator sees the daemon's reason. |
| Operator picks 0 drives in the picker | `action_confirm()` | Notify `"No drives selected."` and stay on the picker. |
| Share / filesystem / array step fails mid-teardown (busy FS, blocked plan, daemon refusal) | `_teardown_failed` | The sequence **stops**. Completed steps stay completed — there is no cross-step rollback. Progress view shows what ran; an OK-only `Delete Array — Stopped` dialog names the failing step and the error (§6.4). |
| Operator cancels the step-3 destroy | `TaskWaitDialog.cancel_requested` → `TaskCancelled` | The destroy task rolls itself back; already-removed shares and filesystems stay removed, and the progress view says so. No snapshot is recorded. |
| Snapshot creation fails | `SnapshotHelper.record` | Logged via `_log.warning(…)`; UI flow is unaffected (snapshots are advisory). |
| Audit log can't be written | `AuditLogger.log` | Silently swallowed (`OSError` is caught). The UI flow is never blocked by the audit channel. |

---

## 11. What the TUI does **not** do

- It does not call `xicli` directly. Every array and pool operation goes through `xinas-api`; the Physical Drives screen's inventory and LED locate go through the gRPC daemon at `localhost:6066`. If the service behind a screen is down, that screen is inert — there is no fallback path.
- It does not edit `/etc/exports` or `/etc/nfs.conf` itself, and no longer even speaks to the helper socket: NFS state mutations reached from a RAID teardown go `api → agent → /run/xinas-nfs-helper.sock`.
- It does not roll back across teardown steps. A failed step stops the sequence and leaves the completed ones in place (§6.4); recovery is a forward operation by the operator.
- It does not perform initialisation control (`raid_init_start` / `raid_init_stop`) or reconstruction control (`raid_recon_start` / `raid_recon_stop`). The RPCs exist in the gRPC client but no menu entry and no API call reaches them — they currently belong to xiRAID's automatic management.
- It does not expose non-force destroy semantics. `DELETE /api/v1/arrays/{id}` is always submitted with `dangerous=True`, on the assumption that the two-stage confirmation gate is the real safety.
- It does not edit `xiraid_arrays` or `xfs_filesystems` Ansible facts. Day-1 (installer) topology is owned by Ansible; day-2 mutations live in the gRPC daemon's state. The two are reconciled via xiraid's persistent config, not via Ansible re-runs.
- It does not multiplex drives between RAID and pool membership. The drive filters explicitly exclude drives that are already a member of either.

## 12. Dialog conventions — informational vs consent

`ConfirmDialog` ([widgets/confirm_dialog.py](../../xinas_menu/widgets/confirm_dialog.py)) renders **Yes / No** buttons by default and shows a single **OK** button only when constructed with `ok_only=True`. The two are not interchangeable, and this rule is TUI-wide (RAID Management is the reference implementation):

- **Informational / error / notice dialogs → OK-only.** Any pop-up that reports a result, shows a read-only detail view, or surfaces a failure — i.e. one whose boolean return value is discarded (`await push_screen_wait(ConfirmDialog(...))` immediately followed by `return`, with nothing branching on the result) — MUST pass `ok_only=True`. A bare Yes/No on "No spare pools exist.", "SMART read failed", or "Could not list drives." asks the operator an unanswerable question.
- **Yes/No is reserved for genuine consent.** Any dialog whose result is captured and branched on (`if not confirmed: return`, `if confirmed:`, and every overwrite / retry / destroy prompt) stays Yes/No. The two-stage destroy gate (§6.2) keeps Yes/No on **both** stages.

This governs every RAID Management, Spare Pools (§7), and Physical Drives (§8) dialog. The same convention is mirrored for the other day-2 surfaces in [fs-shares-management-spec.md §9](fs-shares-management-spec.md#9-dialog-conventions--informational-vs-consent) and [spec-network-management.md](../Network/spec-network-management.md#dialog-conventions).
