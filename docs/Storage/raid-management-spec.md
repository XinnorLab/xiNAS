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

**Vendor references.** Every statement in this document about what *xiRAID*
(as opposed to xiNAS) accepts, rejects, or defaults to is sourced from the
Xinnor documentation for **xiRAID Classic 4.4.0** — the version the
`xiraid_classic` role installs:

| Short name used below | Page |
|---|---|
| **CR / `xicli raid`** | <https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html> |
| **CR / `xicli pool`** | <https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/pool.html> |
| **AG / RAIDs explained** | <https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html> |

A claim that is *not* traceable to one of those pages is marked inline with
how it was actually established — **[observed]** (seen on a node),
**[from error message]** (inferred from an engine rejection string), or
**[from descriptor]** (read out of the running daemon's protobuf
descriptor). Do not promote such a claim to plain fact without a vendor
page behind it.

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

Extended adds four blocks, all sourced from observed `spec.tuning`:

- **Priorities** — `init_prio`, `recon_prio`, `restripe_prio`, `sdc_prio`
- **Performance** — `memory_limit`, `memory_prealloc`, `request_limit`, `cpu_allowed`, plus `block_size` (`spec`) and `memory_usage_mb` (`status`)
- **I/O Scheduler & Merge** — `sched_enabled`, `merge_read_enabled`, `merge_write_enabled`, `adaptive_merge`, plus the four merge timing knobs `merge_read_max`, `merge_read_wait`, `merge_write_max`, `merge_write_wait`
- **TRIM / Discard** — `discard` (the array accepts discards from the filesystem) and `drive_trim` (the array issues TRIM to its members)

Neither knob is editable from this screen: the control path classifies both as
create-only (`CREATE_ONLY_TUNING` in `routes/arrays.ts`, verified against the 4.3.1 gRPC
descriptor, whose `RaidModify` carries no field for either), so Edit Array rejects them
and they carry no edit affordance. The xiRAID Classic 4.4 CLI reference does list
`discard` as modifiable via `xicli raid modify`, so that classification is worth
re-checking against a 4.4 descriptor; until it is, the block is display-only.

The installer decides them per array from the members' discard support **and RZAT**, and
never forces `drive_trim` (see [raid-spec §7.5](../Installer/raid-spec.md#75-array-creation)).
The block states what the array *is*, so an operator diagnosing discard behaviour does not
have to infer it from the install log.

**Day-2 creation does not match the installer yet.** The Create Array wizard (§4) sends no
`tuning`, so an array created from the TUI gets xiRAID's default `discard = 0` while an
installer-created array on the same hardware gets `discard = 1`. The wizard has nothing to
decide from — the control-path `Disk` object carries neither discard nor RZAT — so closing
the gap means extending the agent's disk probe first. Tracked in
[docs/TODO.md](../TODO.md); until it lands, this block is where the difference becomes
visible.

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
| Booleans (`sched_enabled`, `merge_*_enabled`, `adaptive_merge`, `discard`, `drive_trim`) | `unknown` | `Enabled` / `Disabled` |
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

1. `_list_api_disks_with_banner(self.app.control)` (`GET /api/v1/disks`, cross-referenced against the arrays list to exclude already-claimed drives) enumerates NVMe drives **and** returns the envelope's degraded banner. **If zero NVMe drives are available, the wizard aborts immediately with a dialog — before the name prompt is ever shown** — and that dialog **names the cause when there is one**: an empty list with a `DEGRADED_BACKEND_UNAVAILABLE` warning renders "No available NVMe drives found." followed by the banner, because "no drives" and "the Disk collector could not be read" are different facts and only one of them means the operator should go looking for hardware. With no warning present the dialog is unchanged.

   The banner comes from the shared extractor [api/degraded.py](../../xinas_menu/api/degraded.py) `degraded_banner(envelope)` — the same one Show Exports (§ [fs-shares-management-spec](fs-shares-management-spec.md)) and the RAID overview use. `_list_api_disks_with_banner` fetches the full envelope via `control.get`; `_list_api_disks` remains as a thin wrapper returning rows only, for the three call sites that render no empty state of their own: Edit Array (via `_get_numa_topology` for the CPU-affinity NUMA picker and directly for the spare-pool disk-id lookup) and Spare Pools (via `_get_free_nvme_drives`).
2. `GET /api/v1/pools` (via `self.app.control.result`) lists spare pools. A failure here is swallowed (`pools = {}`) rather than aborting the wizard — it just means the `spare` step's `applies=lambda a: bool(pools)` predicate stays `False` and the step is skipped.

### Step — name

`InputDialog` with validation, applied via `raid_rules.validate_array_name()` (the rule itself lives in [xinas_menu/utils/xiraid_names.py](../../xinas_menu/utils/xiraid_names.py), which `raid_rules` re-exports — see "Where the rules live" below). **The rule below is the xiRAID Classic 4.4 engine rule, not a xiNAS convention** — it is transcribed from the [xiRAID 4.4 command reference](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html) for `xicli raid create -n/--name`, and it is the canonical statement of array naming for the whole product (TUI, control-path plan validator, API contract):

| Rule | Value | Enforcement |
|---|---|---|
| Length | 1–28 characters | hard reject |
| Character set | Latin letters, digits, underscore — `^[A-Za-z0-9_]{1,28}$`. **Hyphens are NOT allowed.** | hard reject |
| Reserved names | `power`, `uevent` (they collide with the sysfs attributes under `/sys/block/xi_<name>/`) | hard reject |
| Partition-identifier collisions | A name that is an existing array's name plus trailing digits, or vice versa — `test1` next to an existing `test`, because partitions of `/dev/xi_test` surface as `/dev/xi_test1` | **warn + allow override** |

The first three are engine rejections: a name that violates them fails inside `xicli`, so accepting it anywhere upstream only defers the failure past the operator's confirmation. The fourth is worded in the reference as something to *avoid*, not something the engine refuses, so it is a warning the operator can accept, never a block.

The rule is implemented once, in [xinas_menu/utils/xiraid_names.py](../../xinas_menu/utils/xiraid_names.py) (`ARRAY_NAME_RE`, `RESERVED_ARRAY_NAMES`, `validate_array_name()`, `partition_collision()`). The screens hold **no name pattern of their own** — the per-screen `_ARRAY_NAME_RE` / `_POOL_NAME_RE` constants are gone, and `tests/test_xiraid_name_rules.py` fails if a hyphenated character class reappears in either screen, which is how the three rules drifted apart in the first place. A failed validation re-prompts via the `while True:` loop until the user enters a valid name or cancels; a collision warning renders a `ConfirmDialog` whose "No" answer re-prompts and whose "Yes" answer proceeds. This is the wizard's first step, so its dialog never renders a Back button.

To evaluate collisions the wizard fetches `GET /api/v1/arrays` alongside the pool list, up front. That call is swallowed on failure (`existing = []`) exactly like the pool fetch — a control-path hiccup degrades the warning, it does not block array creation.

#### Why the rule lives in three places, and why the published pattern moved

Before this change all three enforcement points disagreed: the TUI allowed hyphens and 64 characters, `docs/control-path/api-v1.yaml` published `^[A-Za-z0-9_-]{1,63}$`, and the engine accepted neither. A name could pass the TUI and be rejected by the API, or pass both and be rejected by `xicli` *after* the operator confirmed the create. Every layer now enforces the same rule:

1. **TUI** — rejects at the name step, before any drive selection work is spent.
2. **Control-path plan validator** — `NAME_RE` in [xiNAS-MCP/src/lib/xiraid/schema.ts](../../xiNAS-MCP/src/lib/xiraid/schema.ts), surfaced as the `name_invalid` blocker from `validateCreateSpec()`. This is the authoritative gate for non-TUI clients (REST, MCP, `xinasctl`).
3. **`api-v1.yaml`** — the published `XiraidArray.spec.name` pattern was **tightened** to `^[A-Za-z0-9_]{1,28}$`.

Tightening a published pattern is normally the breaking direction, so the choice was made deliberately rather than by default:

- **The old pattern advertised values the system can never accept.** `my-array` was schema-valid and unconditionally failed at apply. A contract that documents impossible values is not "permissive", it is wrong.
- **No conforming instance is lost.** Every array that can exist on a node already matches the tighter pattern, because xiRAID itself refuses to create anything else. The change invalidates no stored state and no request that ever succeeded.
- **Leaving it loose would keep the contract knowingly false**, which is the exact drift this change exists to remove — clients generated from the schema would keep offering hyphens.

**The `oasdiff` gate does not fail on it**, and that was checked rather than assumed. `XiraidArray` is referenced only from *responses* (`GET /arrays`, `GET /arrays/{id}`); the create/modify request body is the generic `requestBodies/Mutating`, whose `spec` is untyped. So `oasdiff` reports the change as two `response-property-pattern-changed` entries at **INFO** severity, and the workflow's `fail-on: ERR` leaves the job green:

```text
2 changes: 0 error, 0 warning, 2 info
info  [response-property-pattern-changed] in API GET /arrays
      the `.../spec/name` response's property pattern was changed
      from `^[A-Za-z0-9_-]{1,63}$` to `^[A-Za-z0-9_]{1,28}$` for the status `200`
```

No exclusion was added to [.github/workflows/ci.yml](../../.github/workflows/ci.yml) and no `oasdiff` rule was suppressed. Note the corollary: because the request side is untyped, the schema pattern is documentation, not request validation — the enforcing gate for API clients is `validateCreateSpec()`, which is why the rule has to be right in **both** places.

**Spare-pool names are a separate, undocumented case.** CR / `xicli pool`
states **no** constraints on `-n/--name` — no length limit, no character set,
no prohibited values. `SparePoolScreen` therefore keeps its looser
`_POOL_NAME_RE = ^[a-zA-Z0-9_-]+$` (§7.3). Do not "fix" it to match the array
rule by analogy: there is no vendor statement that the array rule applies to
pools, and tightening it would reject pool names that work today.

### Step — RAID level

`SelectDialog` over `_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]`, pre-selecting the previously-chosen level on re-entry. xiRAID Classic accepts all seven; the TUI passes the string through to the array-create spec's `level` field.

#### Engine-enforced minimum drive counts

(Finding #20; unified across surfaces by finding #4.) xiRAID enforces higher minimums than textbook RAID math, and they are **documented by the vendor** — the Administrator's Guide [RAIDs explained](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html) page carries a `Requirements` line per level, even though `xicli raid create --help` and the CR parameter table do not repeat them. This table is the **single source of truth for minimum member counts across the whole repo**: the TUI Create wizard, the control-path constraint table, and the installer's auto-generated arrays all encode these numbers and must not diverge (review finding #4).

| Level | Textbook min | xiRAID min (AG / RAIDs explained) | Extra rule |
|---|---|---|---|
| 0 | 2 | **1** | — |
| 1 | 2 | 2 | — |
| 5 | 3 | **4** | — |
| 6 | 4 | 4 | — |
| 7.3 | 4 | **6** | — |
| 10 | 4 | **2** | "the number of drives must be even" |
| 50 | 6 | **8** | multiple of group size, ≥ 2 groups, group size ≥ 4 |
| 60 | 8 | 8 | multiple of group size, ≥ 2 groups, group size ≥ 4 |
| 70 | 12 | **12** | multiple of group size, ≥ 2 groups, group size ≥ 6 |
| N+M | — | **8** | ≥ 4 drives for checksums; `N+M ≤ 64`; `M ≤ N` |

> **Provenance and version scope.** The numbers above are the vendor's, read off the AG *RAIDs explained* page for xiRAID Classic 4.4 (the version the `xiraid_classic` role installs). They are **xiRAID-version-specific**: a future engine release may relax or tighten a minimum, and the table would then be wrong in the safe direction (rejecting a layout the engine would accept) or the unsafe one (passing preflight and failing at `xicli raid create`). **When bumping the xiRAID version, re-confirm each minimum against the new AG page before trusting this table.**

**Reconciliation with what this spec used to say** (finding #20, superseded 2026-08-14). The first version of this table was assembled from an engine rejection string and installer feedback rather than from the AG page, which got four of the ten levels wrong:

- **RAID 5 = 4** and **RAID 50 = 8** came from `Error: To create RAID level '5', a minimum of '4' disks are required.` and from installer feedback. Both are **confirmed** by AG. **RAID 60 = 8** is confirmed too.
- **RAID 7.3 = 6**, **RAID 70 = 12** and **N+M = 8** were recorded as 4, 8 and 4 — *below* the engine's floor. A spec under the floor produced no `min_drives` blocker and failed later at `raid_create`, which is the exact failure mode the table exists to prevent.
- **RAID 0 = 1** was recorded as 2 — stricter than the engine, so it rejects a layout xiRAID would accept.
- **RAID 10 = 4** is **not** a xiRAID minimum: AG says 2, even. The floor of 4 is a xiNAS choice (a 2-drive RAID 10 is a mirror with extra steps) and must not be attributed to the engine.

##### Where the rules live

**The wizard pre-validates against this table.** The drives step re-prompts on
an under-count with the level's own requirement
(`RAID 5 needs at least 4 drives (4 selected)`), and on an odd member count
for RAID 10, rather than letting the operator complete four more steps and a
confirmation before the engine rejects the create. The control path validates
the same rules independently — see [ADR-0006](../control-path/adr/0006-xiraid-array.md)
and `lib/xiraid/schema.ts` — because the TUI is not the only client.

The rules live in one module per language so there is a single place to
re-check when the xiRAID version moves:

| Surface | Module |
|---|---|
| Python TUI | [xinas_menu/utils/raid_rules.py](../../xinas_menu/utils/raid_rules.py) |
| TypeScript control path | [xiNAS-MCP/src/lib/xiraid/schema.ts](../../xiNAS-MCP/src/lib/xiraid/schema.ts) |

Neither is allowed to be *looser* than the vendor table; stricter is a
deliberate xiNAS choice and must say so (RAID 10's floor of 4 is the only one
today).

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

`SelectDialog` over `_STRIP_SIZES = ["16", "32", "64", "128", "256"]` (KB) — exactly the set CR / `xicli raid` allows for `-ss, --strip_size`. Note the **pre-selection is xiNAS's, not xiRAID's**: CR gives the engine default as `16`, while the wizard pre-selects `"64"` (`selected=answers.get("strip", "64")`) so Enter on first entry still yields the historical default. **`Esc` now cancels the whole wizard**, the same as every other plain-`SelectDialog` step — there is no special-cased "dismiss without choosing silently defaults to 64" behavior anymore; the pre-selection is what makes the common case ("just press Enter") still land on 64.

### Step — group size (RAID 50/60 only, conditional)

`applies=lambda a: a.get("level") in ("50", "60")`. For levels `50` and `60` the wizard prompts for `group_size` as a positive integer; the validation loop re-prompts on bad input. For any other level this step is skipped in both directions — advancing past `strip` goes straight to `spare`/`confirmed`, and Back from a later step lands on `strip`, not on a hidden `group_size` prompt.

**What xiRAID accepts here, and what the prompt enforces.** CR / `xicli raid`
lists `-gs, --group_size` with the range **4–32** "for RAID 10, 50, 60, 70
only", and AG adds that the member count must be a multiple of the group size
with **at least 2 groups** (group size ≥ 6 for RAID 70). "Any positive
integer" was far looser than that — `1`, `3` and `33` all reached dispatch —
so the prompt now applies the full rule and re-prompts with the reason:

- outside `[4,32]` → `Group size must be between 4 and 32.`
- doesn't divide the member count → `8 drives do not divide evenly into
  groups of 3.`
- divides into fewer than 2 groups → `Group size 8 leaves only 1 group; at
  least 2 are required.`

This step is the first point where both the level and the drive count are
known, which is why divisibility is checked here rather than in the drives
step.

Two further notes on the level list:

- CR lists RAID **10** among the levels `-gs` applies to, but AG states RAID
  10's only rule is an even drive count, and the installer creates its RAID 10
  log array with no `-gs` at all (Installer/raid-spec §7.5) — successfully, on
  every deployed node **[observed]**. `group_size` is therefore *accepted* for
  RAID 10, not *required*; the wizard is right to skip the step. The daemon
  source agrees: `RAIDNeedToSpecifyGroupSizeError` fires for 50/60/70 only
  (`xiraid-analysis/api_behavior_doc.md` §3.4).
- Levels 7.3, 70 and N+M are absent from `_RAID_LEVELS` and so never reach
  this step, even though xiRAID supports them.

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

**Caveat on step 2: "create-only" here means "absent from the gRPC message",
not "the product can't change it".** CR / `xicli raid` documents
`xicli raid modify` as accepting `discard` (noting it "requires RAID
unload/restore"), `discard_verify` and `drive_write_through` — none of which
exist as fields in `proto/xraid/gRPC/protobuf/message_raid.proto`, whose field
numbers were taken from the **xiRAID 4.3.1** daemon's own descriptor. The CLI
and the gRPC surface are not the same surface. What this means in practice:

- The TUI's parameter list is correct *for the transport it uses*. Sending
  `discard` over this `RaidModify` would be silently dropped by protobuf and
  reported as success — which is exactly why the control path rejects it
  pre-plan ([ADR-0006 §Writability](../control-path/adr/0006-xiraid-array.md),
  [s4 spec §Writability enforcement](../control-path/s4-xiraid-array-mutations-spec.md)).
- It is **not** correct to say xiRAID cannot modify `discard`. It can, via
  `xicli`.
- The vendored descriptor is 4.3.1 and the `xiraid_classic` role now installs
  **4.4**. Whether 4.4's `RaidModify` gained these fields has **not been
  re-checked against a 4.4 daemon**. Re-vendor the descriptor from a 4.4 host
  before treating the create-only classification as still current.

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

Discovery runs in `RAIDScreen._delete_dependencies(arr_name, volume_path, mounts)` and decides what the teardown must remove before `raid_destroy`. Since a wrong answer here ends in a destroyed array, **discovery fails closed**: every outcome other than a complete, actionable dependency set aborts the deletion before anything is changed.

For the selected array name `arr_name` (volume `/dev/xi_<arr_name>`):

1. `find_mounts_using_raid(arr_name)` (from `xfs_helpers`) — returns every mount whose data device is `/dev/xi_<name>` *or* whose mount opts carry `logdev=/dev/xi_<name>`. Each result carries a `role` field (`"data"` or `"log"`). Their mountpoints are the filter for step 2.
2. `GET /api/v1/shares` — every share whose `spec.path` is rooted at one of those mountpoints goes into `affected_shares`. Skipped when no mount was found (nothing can be rooted under an unmounted array).
3. `GET /api/v1/filesystems` — every filesystem whose `status.backing_device` is the array volume, or whose `status.mountpoint` is one of those mountpoints, goes into `affected_fs`.

**Read failures abort, they never read as "no dependencies".** A `ControlPathError` from either read leaves the TUI without evidence about the array's dependents — which is not the same as evidence of none. The screen shows a `Delete Array — Aborted` dialog carrying the underlying error and stating that the array was NOT deleted and nothing was changed, and the flow returns before the first confirmation. (Both reads were previously swallowed into empty lists, so a control path that was down presented as an array with nothing on it and the teardown proceeded to destroy it.)

**Dependents the teardown cannot clear also abort.** Every mount from step 1 whose mountpoint is not covered by an `affected_fs` entry is unremovable by this flow — typically an XFS filesystem that uses the array only as its external log device (`logdev=`), which the API does not model as `backing_device`, so there is no mount unit for the teardown to unmount. The same `Delete Array — Aborted` dialog lists those mountpoints with their `role` and asks the operator to unmount them first. Proceeding was never useful: the agent's delete preflight (below) refuses the destroy while such a mount exists, so the teardown would have removed the shares and mount units and *then* failed at the last step.

Consequently, by the time the confirmations are shown, every dependent mount is API-managed and the first dialog lists exactly what the teardown will remove.

**Agent-side backstop (`xiraid.array.delete` preflight).** The TUI checks are advisory; the host-level guard in the agent executor is what makes destruction safe under a race (a mount that appeared after the api's re-check). It reads `/proc/self/mountinfo` — fail-closed: an unreadable mount table throws and nothing is destroyed — and refuses the delete when the volume is either:

- the `source` of any mount, or
- referenced by an external-device mount option, `logdev=<volume>` or `rtdev=<volume>`, in a mount's VFS options or its filesystem-specific super options (XFS reports its external log and realtime devices in the latter, so such a filesystem never names the array as its mount source).

Either case fails preflight with the mountpoint and the reason, before `raid_destroy` is called — the task ends `failed` with a clean no-op rollback, never `requires_manual_recovery`.

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

1. Pool name validated against `POOL_NAME_RE = ^[A-Za-z0-9_]{1,64}$` via `validate_pool_name()` in [xinas_menu/utils/xiraid_names.py](../../xinas_menu/utils/xiraid_names.py) — the **array character set, hyphens included in the ban**, over the control path's incumbent 64-character bound.

   The xiRAID 4.4 command reference documents no naming rule for `xicli pool create -n` (it says only "The name of the spare pool"), so unlike the array rule this is a xiNAS choice. The character set is deliberately conservative: pool names are engine identifiers handed to the same `xicli` binary, hyphens are not accepted anywhere xiRAID naming *is* documented, and the two failure modes are not symmetric — a name rejected here costs the operator one keystroke, while a name accepted here and rejected by the engine fails after the confirmation step, mid-apply. If Xinnor documents a laxer pool rule, relax this one; do not relax it on the assumption that it is lax.

   The **length bound is deliberately not** the array's 28. There is no vendor source for a pool length limit, and xiNAS has positive evidence that longer names work: the array executor creates its own spare pools as `xnsp_<array>` (up to 33 characters for a maximum-length array name, `derivedPoolName()` in [xiNAS-MCP/src/lib/xiraid/validate.ts](../../xiNAS-MCP/src/lib/xiraid/validate.ts)). A 28-character pool rule would outlaw pools this system creates itself, so the incumbent 64 stands; `POOL_NAME_MAX_LEN` must remain ≥ `len("xnsp_") + ARRAY_NAME_MAX_LEN`.

   `power`/`uevent` are **not** reserved for pools. Those two names are prohibited because they collide with sysfs attributes under `/sys/block/xi_<name>/`, and a spare pool is not a block device.

   The `Pool` schema in [api-v1.yaml](../../docs/control-path/api-v1.yaml) intentionally keeps `name` unpatterned. Publishing a pattern there would over-claim — it would present a xiNAS-local precaution as a vendor contract — and would spend a second `oasdiff` breaking-change finding on a rule we are less sure of than the array one. Enforcement lives in `requireName()` in [xiNAS-MCP/src/api/plan/providers/pool.ts](../../xiNAS-MCP/src/api/plan/providers/pool.ts), which returns `INVALID_ARGUMENT` at plan time.
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
| xRAID daemon down | every gRPC RPC — Physical Drives only (§8) | `grpc.aio` raises `RpcError("StatusCode.UNAVAILABLE")`; `_call()` catches and returns `(False, None, str(exc))`. UI shows the short error. |
| `GET /shares` or `GET /filesystems` fails during Delete Array dependency discovery | `_delete_dependencies` | `Delete Array — Aborted` dialog with the `ControlPathError`; the array is not deleted and nothing is changed. An unreadable dependency set is never treated as an empty one (§6.1). |
| A mount uses the array but the teardown cannot unmount it (e.g. `logdev=` with no mount unit) | `_delete_dependencies` | `Delete Array — Aborted` listing those mountpoints; the operator unmounts them first. The agent's delete preflight refuses the destroy while such a mount exists (§6.1). |
| Array / pool name breaks the xiRAID rule | `validate_array_name()` / `validate_pool_name()` in [xiraid_names.py](../../xinas_menu/utils/xiraid_names.py) | InputDialog re-prompts with the reason; the name never reaches the api (§4). |
| Drive count under the level's minimum | `raid_rules.validate_member_count()` | The drives step re-prompts, naming the level's requirement — the engine is no longer the first to say no (§4). |
| RAID 10 with no spare pool when one is required | xiRAID's own validation, via the api | The create apply fails; the operator sees the daemon's reason. |
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
