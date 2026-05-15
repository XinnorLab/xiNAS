# xiNAS — RAID Management from the TUI

This document covers the *day-2* RAID management surface: the Textual TUI screens, the helpers they call, and the gRPC service those helpers talk to. It is the counterpart to [Installer/raid-spec.md](../Installer/raid-spec.md), which describes how arrays are first created by Ansible.

The TUI never runs `xicli` directly. Every RAID operation is an RPC against the xiRAID gRPC daemon, with two adjuncts: an NFS helper daemon over a Unix socket, and a small XFS helper module that runs `findmnt` / `systemctl` synchronously from the TUI process.

Sources:

- Screens: [xinas_menu/screens/storage.py](../../xinas_menu/screens/storage.py), [raid.py](../../xinas_menu/screens/raid.py), [spare_pools.py](../../xinas_menu/screens/spare_pools.py), [drives.py](../../xinas_menu/screens/drives.py)
- gRPC helper: [xinas_menu/api/grpc_client.py](../../xinas_menu/api/grpc_client.py)
- NFS helper client: [xinas_menu/api/nfs_client.py](../../xinas_menu/api/nfs_client.py)
- XFS helpers: [xinas_menu/utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)
- Audit + snapshot helpers: [xinas_menu/utils/audit.py](../../xinas_menu/utils/audit.py), [xinas_menu/utils/snapshot_helper.py](../../xinas_menu/utils/snapshot_helper.py)
- Drive picker widget: [xinas_menu/widgets/drive_picker.py](../../xinas_menu/widgets/drive_picker.py)
- gRPC service contract: [xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto), [message_raid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/message_raid.proto), [message_pool.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/message_pool.proto)
- NFS helper daemon: [xiNAS-MCP/nfs-helper/nfs_helper.py](../../xiNAS-MCP/nfs-helper/nfs_helper.py), [xinas-nfs-helper.service](../../xiNAS-MCP/nfs-helper/xinas-nfs-helper.service)

---

## 1. Where this lives in the TUI

`xinas-menu` (entry point `xinas_menu/__main__.py`) launches the Textual app with `XiRAIDClient` mounted as `self.app.grpc` and `NFSHelperClient` as `self.app.nfs`. The user reaches RAID via:

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
| 1 | Quick Overview | `_show_quick()` → `grpc.raid_show()` |
| 2 | Extended Details | `_show_extended()` → `grpc.raid_show(extended=True)` |
| 3 | Spare Pools | pushes `SparePoolScreen` |
| 4 | Create Array | `_create_array_wizard()` |
| 5 | Edit Array | `_modify_array()` |
| 6 | Delete Array | `_delete_array()` |

`on_mount` runs Quick Overview immediately, so opening the screen kicks a `raid_show` against the daemon.

---

## 2. The two helpers behind RAID Management

Every RAID operation crosses one of two IPC boundaries — neither one is `subprocess('xicli …')`. The TUI is a thin presenter; the **xiRAID gRPC daemon** and the **xinas-nfs-helper** are the actual service layer.

```
┌──────────────────────┐
│  xinas-menu (TUI)    │
│   Python / Textual    │
│   runs as root        │
└─────┬────────┬───────┘
      │        │
      │ gRPC   │ JSON over AF_UNIX
      │ :6066  │ /run/xinas-nfs-helper.sock
      ▼        ▼
┌─────────────┐  ┌──────────────────────┐
│ xRAID gRPC  │  │ xinas-nfs-helper     │
│ daemon      │  │ Python daemon, root  │
│ (xiRAID-    │  │ ProtectHome=true     │
│  Classic)   │  └────────┬─────────────┘
└──────┬──────┘           │
       │                  │ writes
       │ ioctl + xicli    ▼
       ▼               /etc/exports
   xiRAID kmod         /etc/nfs.conf
   /dev/xi_<name>      exportfs -r
                       systemctl restart nfs-server
```

The third "helper" used during RAID **deletion** is `xinas_menu/utils/xfs_helpers.py` — but that runs in-process inside the TUI (no separate service); it just shells out to `findmnt`, `systemctl`, `mkfs.xfs` etc. via `asyncio.create_subprocess_exec`.

### 2.1 `XiRAIDClient` — gRPC bridge to xiRAID

Source: [xinas_menu/api/grpc_client.py](../../xinas_menu/api/grpc_client.py).

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

### 2.2 RAID RPCs the TUI uses

Direct mapping from `XiRAIDClient` methods to the protos in [service_xraid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto):

| Python method | RPC | Request message | Used by |
|---|---|---|---|
| `raid_show(units, name, extended)` | `raid_show` | `RaidShow` | Quick / Extended overview, every edit/delete pre-check |
| `raid_create(name, level, drives, **kwargs)` | `raid_create` | `RaidCreate` | Create wizard |
| `raid_modify(name, **kwargs)` | `raid_modify` | `RaidModify` | Edit Array |
| `raid_destroy(name, force)` | `raid_destroy` | `RaidDestroy` | Delete Array (always with `force=True`) |
| `raid_unload(name)` | `raid_unload` | `RaidUnload` | — (available, not currently used) |
| `raid_init_start(name)` / `raid_init_stop(name)` | matching RPCs | — | — (available, not currently used) |
| `raid_recon_start(name)` / `raid_recon_stop(name)` | matching RPCs | — | — (available, not currently used) |

For pools:

| Python method | RPC | Request message |
|---|---|---|
| `pool_show(name, units)` | `pool_show` | `PoolShow` |
| `pool_create(name, drives)` | `pool_create` | `PoolCreate` |
| `pool_delete(name)` | `pool_delete` | `PoolDelete` |
| `pool_add(name, drives)` | `pool_add` | `PoolAdd` |
| `pool_remove(name, drives)` | `pool_remove` | `PoolRemove` |
| `pool_activate(name)` / `pool_deactivate(name)` | matching RPCs | matching messages |

`RaidCreate` accepts the full Xinnor parameter surface — see [message_raid.proto](../../xiNAS-MCP/proto/xraid/gRPC/protobuf/message_raid.proto). The TUI passes `strip_size`, optional `group_size` (RAID 50/60 only), and optional `sparepool`. `force_metadata` is **not** set from the TUI — that flag is reserved for Ansible re-creates where stale metadata is expected.

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

In the RAID screen, only `list_exports`, `remove_export`, `add_export`, and `reload` are reached — they are called during teardown when an array being deleted has dependent NFS shares (see §6).

### 2.4 `xfs_helpers` — async subprocess helpers

Source: [xinas_menu/utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py). Pure Python, no daemon. Used by the RAID screen for two things during deletion:

- `find_mounts_using_raid(array_name)` — finds every XFS mount whose **data** device is `/dev/xi_<name>` *or* whose mount options carry `logdev=/dev/xi_<name>`. The second case matters: the data array and the log array are separate xiRAID volumes, and `mnt-data.mount` references the log via `Options=…,logdev=/dev/xi_log,…`. Deleting `xi_log` without unmounting `/mnt/data` first would leave the XFS log dangling.
- `unmount_filesystem(mountpoint)` and `mount_filesystem(mountpoint)` — wrap `systemctl stop/start <unit>` for the systemd `.mount` units (see [Installer/fs-exports-spec.md §1.8](../Installer/fs-exports-spec.md#18-mountpoint-and-systemd-mount-unit)). Both are used in the rollback path.

The geometry / mkfs / mount-unit helpers in the same file are used by the Filesystem screen, not the RAID screen — they replicate the Ansible behavior for runtime FS creation.

### 2.5 Cross-cutting helpers: audit + snapshots

Every RAID write (create / modify / destroy) goes through two side-channel helpers:

- **Audit log** ([utils/audit.py](../../xinas_menu/utils/audit.py)) — appends one line per action to `/var/log/xinas/audit.log` in the format `YYYY-MM-DD HH:MM:SS | user | action | STATUS | detail`. `action` strings are stable identifiers like `raid.create`, `raid.modify`, `raid.destroy`, `nfs.remove`, `fs.unmount`. The logger never raises into the UI.
- **Snapshot helper** ([utils/snapshot_helper.py](../../xinas_menu/utils/snapshot_helper.py)) — best-effort `await app.snapshots.record("<operation>", diff_summary=…)`. Backed by `xinas_history.SnapshotEngine` (see [Installer/spec.md §3.11](../Installer/spec.md#311-xinas_history--config-snapshots--rollback)). Failures are logged but never propagate; snapshots are advisory, not transactional.

The audit line is written **after** the gRPC reports success. The snapshot is recorded **after** the audit line. Either can fail without affecting the user-visible result.

---

## 3. Read paths — Quick Overview / Extended Details

`_show_quick()` and `_show_extended()` are nearly identical: both call `grpc.raid_show()` (with `extended=True` for the latter) and feed the JSON list/dict into `_format_raid_overview()`.

The formatter normalises the response with `_as_array_dict()`, since `raid_show` can return either:

- a `dict` keyed by array name, or
- a `list` of dicts each carrying a `name` field.

Quick Overview shows: level, capacity, state list, device counts (online / degraded / offline derived from the per-device state field), strip size, spare pool, and an initialisation progress bar when any state is `initing`.

Extended adds three blocks:

- **Priorities** — `init_prio`, `recon_prio`, `restripe_prio`
- **Performance** — `memory_usage_mb`, `memory_limit`, `memory_prealloc`, `block_size`, `request_limit`, `cpu_allowed`
- **I/O Scheduler & Merge** — `sched_enabled`, `resync_enabled`, `merge_read_enabled`, `merge_write_enabled`, `adaptive_merge`, plus the four merge timing knobs

If the response includes `devices_health` or `devices_wear` arrays, a per-device row is appended showing state icon + health + wear%.

State → icon/colour mapping (from `_state_icon` / `_state_color`):

| State | Icon | Colour |
|---|---|---|
| `online` / `initialized` | `*` | green |
| `initing` / `rebuilding` | `~` | yellow |
| `degraded` | `!` | yellow |
| `offline` / `failed` | `x` | red |
| anything else | `o` | none |

---

## 4. Create Array wizard

`_create_array_wizard()` runs as a Textual `@work(exclusive=True)` async worker so the UI stays responsive. Steps:

### Step 1 — name

`InputDialog` with validation:

- 1 ≤ length ≤ 64.
- Matches `_ARRAY_NAME_RE = ^[a-zA-Z0-9_-]+$`.

A failed validation re-prompts via the `while True:` loop until the user enters a valid name or cancels.

### Step 2 — RAID level

`SelectDialog` over `_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]`. xiRAID Classic accepts all seven; the TUI passes the string through to `RaidCreate.level`.

### Step 3 — drives

`_get_drive_groups()` enumerates NVMe drives via `grpc.disk_list()` (which itself is `lsblk` enriched with RAID membership from `raid_show(extended=True)` — see §5) and bins them by NUMA node and size category. Threshold for "small" vs "large" is `1 GB` (`SMALL_THRESHOLD = 1_000_000_000`). The split is what lets the wizard offer separate "log" (small `n1` namespaces) and "data" (large `n2` namespaces) groups out of the box.

The user picks a **drive group**:

- `All small NVMe, NUMA 0` (etc.) — pre-selected list, opens the `DrivePickerScreen` with `preselected=` so the operator can review.
- `Pick individual drives` — opens `DrivePickerScreen` with all unassigned NVMe drives and no preselection.

`DrivePickerScreen` ([widgets/drive_picker.py](../../xinas_menu/widgets/drive_picker.py)) is the full-screen modal: filter by text/NUMA/size, sort by name/size/model/NUMA, multi-select with Space, `a` to select-all-visible, `d` for the detail dialog.

Filters that exclude a drive from the picker:

- `system: True` (any OS-mounted partition on it — see `_get_os_drives()` in `grpc_client.py`)
- `raid_name` set (already a member of some RAID array)
- `nvme` not in the name (anything that isn't NVMe — the wizard is NVMe-only)

If zero drives are available, the wizard aborts with a "No available NVMe drives found." dialog.

### Step 4 — strip size

`SelectDialog` over `_STRIP_SIZES = ["16", "32", "64", "128", "256"]` (KB). Default if the user dismisses without choosing: `64`.

### Step 5 — group size (RAID 50/60 only)

For levels `50` and `60` the wizard prompts for `group_size` as a positive integer. The validation loop re-prompts on bad input.

### Step 6 — spare pool

`grpc.pool_show()` lists existing pools. If any exist, a `SelectDialog` offers `(none)` + the sorted pool names. If no pools exist, the step is skipped silently (no spare pool assigned).

### Confirmation + dispatch

The summary dialog renders all selections. On confirm:

1. Drive names are normalised to `/dev/<name>` (the picker returns bare names).
2. `grpc.raid_create(name, level, drives, **kwargs)` is invoked.
3. On success: `audit.log("raid.create", "<name> RAID-<level> (<n> drives)", "OK")` + `snapshots.record("raid_create", …)` + Quick Overview is refreshed.
4. On failure: a `ConfirmDialog` shows `grpc_short_error(err)`.

---

## 5. Edit Array

`_modify_array()` is parameter-by-parameter — the TUI does not let the operator edit multiple knobs in one round-trip (this matches `raid_modify`'s semantics of "set the fields you specify, leave the rest alone").

Steps:

1. **Pick an array.** `grpc.raid_show()` → `SelectDialog` over array names.
2. **Pick a parameter.** `SelectDialog` over `_MODIFY_PARAMS`, each tuple of `(grpc_key, label, kind, options, value_type)`. Parameters offered, in order: CPU Affinity, Spare Pool, Init Priority, Recon Priority, Resync Enabled, Scheduler Enabled, Memory Limit, Merge Read Enabled, Merge Write Enabled, Merge Read Max, Merge Write Max.
3. **Per-parameter prompt** — see §5.1.
4. **Confirm + dispatch.** Value is coerced to the declared `vtype` (`int` for the integer knobs, `str` for the rest). `grpc.raid_modify(name, **{key: value})` is invoked. On success: audit (`raid.modify`) + snapshot (`raid_modify`) + Quick Overview refresh.

### 5.1 CPU Affinity dialog (special case)

CPU affinity is the only knob with a multi-mode UI. The current value is read from the array dict (`arr["cpu_allowed"]`, defaulting to `"all"`). Three modes:

- **All CPUs (reset)** — sends an empty string, which xiRAID interprets as "no restriction".
- **NUMA Node** — `_get_numa_topology()` reads `/sys/devices/system/node/node*/cpulist` for each node and maps NVMe drives to nodes via `disk_list()`'s `numa_node`. The dialog shows `NUMA 0 (CPUs 0-15) — nvme0, nvme1, …` so the operator can pin the array to the NUMA node hosting its drives.
- **Manual CPU List** — free-form text validated against `_CPU_LIST_RE = ^\d+(-\d+)?(,\d+(-\d+)?)*$` (e.g. `0,2,4-7`). Bad input shows an error dialog and aborts.

This is the only place where the TUI itself reads `/sys` rather than going through gRPC — NUMA topology is not part of the xiRAID API.

### 5.2 Spare-pool selection

`spare_pool` is also dynamic — instead of free-form input, `grpc.pool_show()` is queried and a `SelectDialog` is offered. If no pools exist, the operator is told via `notify(severity="warning")` and the dialog aborts.

---

## 6. Delete Array — ordered teardown with rollback

This is the most complex flow in the screen because deleting a RAID array can cascade into NFS exports and XFS mounts. The deletion path is implemented as a three-step transaction with point-in-time rollback.

### 6.1 Dependency discovery

For the selected array name `arr_name`:

1. `find_mounts_using_raid(arr_name)` (from `xfs_helpers`) — returns every mount whose data device is `/dev/xi_<name>` *or* whose mount opts carry `logdev=/dev/xi_<name>`. Each result carries a `role` field (`"data"` or `"log"`).
2. For each discovered mountpoint, the TUI calls `nfs.list_exports()` (synchronous, against the helper socket) and scans for any export whose `path` is rooted at that mountpoint. Matches go into `affected_shares`.

### 6.2 Two-stage confirmation

The first dialog shows the array summary, the list of NFS shares that will be removed, and the list of filesystems that will be unmounted.

When the array has dependencies, a **second** `FINAL CONFIRMATION` dialog appears restating the counts. This is the only place in the screen where double confirmation is required.

### 6.3 The teardown order

Once both confirmations pass, the screen runs three steps **in order**:

```
Step 1: Remove every affected NFS share         (synchronous, helper socket)
Step 2: Unmount every affected filesystem        (async, systemctl)
Step 3: Destroy the RAID array                   (gRPC raid_destroy force=True)
```

The order matters: stopping the mount before the export is removed would orphan an active export; destroying the array before the mount is gone would leave systemd holding a stale device reference.

### 6.4 Rollback

Each step appends to a per-step bookkeeping list (`removed_shares`, `unmounted_mounts`). On any failure during teardown:

- **Step 1 fails** (NFS share won't remove): re-add every previously removed share via `nfs.add_export(saved)`, then `nfs.reload()`. The teardown aborts with `Error — Rollback Complete`.
- **Step 2 fails** (a mount won't unmount): re-mount every previously unmounted mountpoint via `mount_filesystem()`, then re-add every removed share, then `nfs.reload()`. Teardown aborts.
- **Step 3 fails** (xiRAID refuses to destroy): same as Step 2 rollback — every removed share and every unmounted FS is restored. The xiRAID error from `grpc_short_error(err)` is shown to the operator.

This is best-effort, not transactional: if rollback itself errors out, the screen shows what was restored and what wasn't, but cannot reverse the rollback. The audit log captures every step, so an operator can reconstruct the sequence after the fact.

### 6.5 Side effects per step

| Step | Audit action | Snapshot recorded |
|---|---|---|
| 1 — `nfs.remove_export(path)` | `nfs.remove` with detail `share=<path> (RAID teardown)` | — |
| 2 — `xfs_helpers.unmount_filesystem(mp)` | `fs.unmount` with detail `mountpoint=<mp> (RAID teardown)` | — |
| 3 — `grpc.raid_destroy(name, force=True)` | `raid.destroy` with detail `<name>` | `raid_delete` with diff summary |

Snapshots are taken **only** on the final RAID destroy step, since the share + mount changes are subsumed by the array's disappearance. The snapshot's `diff_summary` counts the removed shares and unmounted mountpoints for context.

---

## 7. Spare Pools (`SparePoolScreen`)

Source: [xinas_menu/screens/spare_pools.py](../../xinas_menu/screens/spare_pools.py). Reached from RAID Management → 3, or from Storage → 5.

### 7.1 Menu

| Key | Action | gRPC RPC |
|---|---|---|
| 1 | View Pools | `pool_show` |
| 2 | Create Pool | `pool_create` |
| 3 | Add Drives | `pool_add` |
| 4 | Remove Drives | `pool_remove` |
| 5 | Activate Pool | `pool_activate` |
| 6 | Deactivate Pool | `pool_deactivate` |
| 7 | Delete Pool | `pool_delete` |

### 7.2 Drive selection rules

`_get_free_nvme_drives()` enforces the "no double-membership" invariant: a drive can be in **either** a RAID array **or** a spare pool, not both. The function:

1. Calls `disk_list()` for all block drives.
2. Calls `pool_show()` and builds a set of paths already in any pool.
3. Filters out: anything missing `nvme` in its name, anything with `system=True`, anything with `raid_name` set, anything already in `pool_drives`.

The result is fed into `DrivePickerScreen` so the operator can apply the same NUMA/size/text filters as in the RAID Create wizard.

### 7.3 Create Pool

Same flow as RAID Create up to the drive picker, then:

1. Pool name validated against `_POOL_NAME_RE = ^[a-zA-Z0-9_-]+$`.
2. Drive picker with `_get_free_nvme_drives()` as the source.
3. Confirmation summary.
4. Names normalised to `/dev/<name>`.
5. `grpc.pool_create(name, drives)`.

No audit / snapshot calls are wired in for pool operations at the moment — pool changes are visible in the gRPC state but not recorded in `/var/log/xinas/audit.log`.

### 7.4 Remove Drives — checklist style

Unlike Add Drives (which uses the full drive picker), Remove Drives uses a simpler `ChecklistDialog` of the current pool members. The operator ticks the drives to evict; `pool_remove` is called with their paths.

### 7.5 Activate / Deactivate

`pool_activate` loads the pool into the running xiRAID state so it can answer hot-spare requests. `pool_deactivate` unloads it — the drive assignments persist, but the pool will not auto-replace a failing member until reactivated.

The Deactivate dialog includes an explanatory note ("Drives will remain assigned but will not be available for automatic replacement.") because it is a non-obvious operation and the rollback story is "just activate it again."

### 7.6 Delete Pool

Single confirmation (no two-stage gate — pools have no downstream FS / NFS dependencies). All member drives are released back to the unassigned set.

---

## 8. Physical Drives screen (read-only)

Source: [xinas_menu/screens/drives.py](../../xinas_menu/screens/drives.py).

This is a read-only inventory view. It uses the same `disk_list()` enrichment (`lsblk` + `raid_show(extended=True)` membership join) as the wizards, plus the role classifier:

```
system → OS drive (root/boot/EFI partition present)
raid   → in a RAID array (carries raid_name)
pool   → in a spare pool
free   → none of the above
```

No write operations — no RPCs are sent. The screen is the canonical "what does this box see right now" view, and it's the data source the wizards' drive filters depend on.

---

## 9. End-to-end traces

### 9.1 Operator clicks "Create Array"

```
RAIDScreen._create_array_wizard()
  ├─ InputDialog (name)                 — TUI only
  ├─ SelectDialog (level)               — TUI only
  ├─ _get_drive_groups()
  │    └─ grpc.disk_list()              → lsblk + raid_show(extended=True)
  │         └─ grpc raid_show RPC       → xRAID daemon → xicli raid show -f json
  ├─ DrivePickerScreen                  — TUI only
  ├─ SelectDialog (strip size)          — TUI only
  ├─ ConfirmDialog (summary)            — TUI only
  ├─ grpc.raid_create(name, level, drives, strip_size, [sparepool])
  │    └─ gRPC raid_create RPC          → xRAID daemon → xicli raid create
  ├─ audit.log("raid.create", …, "OK")  — write /var/log/xinas/audit.log
  ├─ snapshots.record("raid_create", …) — xinas_history snapshot
  └─ _show_quick()                      → refresh Quick Overview
```

### 9.2 Operator clicks "Delete Array" on a live data array

```
RAIDScreen._delete_array()
  ├─ grpc.raid_show()                   — list arrays
  ├─ SelectDialog (pick array)
  ├─ find_mounts_using_raid("data")
  │    ├─ findmnt /dev/xi_data           → /mnt/data role=data
  │    └─ findmnt -t xfs (logdev scan)   → no extra mounts
  ├─ nfs.list_exports()                 — Unix socket: list_exports
  │    └─ helper reads /etc/exports
  ├─ first ConfirmDialog (warning)
  ├─ second ConfirmDialog (FINAL)
  ├─ for each affected share:
  │    ├─ nfs.remove_export(path)        — Unix socket: remove_export
  │    │    └─ helper: edit /etc/exports + exportfs -ra
  │    └─ audit.log("nfs.remove", …)
  ├─ nfs.reload()                        — Unix socket: reload (exportfs -r)
  ├─ for each mount:
  │    ├─ unmount_filesystem(mp)         — systemctl stop mnt-data.mount
  │    │                                   + systemctl disable + rm unit
  │    └─ audit.log("fs.unmount", …)
  ├─ grpc.raid_destroy("data", force=True)
  │    └─ gRPC raid_destroy RPC          → xRAID daemon → xicli raid destroy
  ├─ audit.log("raid.destroy", "data", "OK")
  └─ snapshots.record("raid_delete", diff_summary=…)
```

If any step after share-removal fails, the rollback path re-runs `add_export` + `mount_filesystem` to restore prior state before the error dialog appears.

---

## 10. Failure modes the TUI handles explicitly

| Failure | Where | Handling |
|---|---|---|
| gRPC stubs not generated | `XiRAIDClient._import_stubs()` | First RPC returns `(False, None, "gRPC stubs not available: <ImportError>")`. UI shows the message; operator runs `--tags xinas_menu` to regenerate. |
| TLS cert missing | `_load_channel_credentials()` | Falls through to insecure channel with a `UserWarning`. Intended only for dev hosts; production should always find a cert. |
| xRAID daemon down | every RPC | `grpc.aio` raises `RpcError("StatusCode.UNAVAILABLE")`; `_call()` catches and returns `(False, None, str(exc))`. UI shows the short error. |
| `xinas-nfs-helper` socket missing or refused | `NFSHelperClient._request()` | Returns `(False, None, "NFS helper socket not found: …")` or `"…not running (connection refused)"`. Delete-array path uses this to short-circuit before touching the array. |
| Helper response not JSON | `NFSHelperClient._request()` | `(False, None, "bad JSON from NFS helper: …")`. |
| Pool name / array name contains invalid chars | `_ARRAY_NAME_RE` / `_POOL_NAME_RE` | InputDialog re-prompts; never sent to the daemon. |
| RAID 10 with no spare pool when one is required | xiRAID's own validation | Caught when `raid_create` returns failure; the operator sees the daemon's reason. |
| Operator picks 0 drives in the picker | `action_confirm()` | Notify `"No drives selected."` and stay on the picker. |
| Mount unit refuses to unmount during RAID delete (busy FS) | `xfs_helpers.unmount_filesystem` | Returns `(False, "Failed to stop mount: <stderr>")` → triggers Step 2 rollback. |
| `raid_destroy` fails after FS / NFS already torn down | Step 3 catch | Restores every unmounted FS and re-adds every removed share before reporting the error. Audit log captures the rollback. |
| Snapshot creation fails | `SnapshotHelper.record` | Logged via `_log.warning(…)`; UI flow is unaffected (snapshots are advisory). |
| Audit log can't be written | `AuditLogger.log` | Silently swallowed (`OSError` is caught). The UI flow is never blocked by the audit channel. |

---

## 11. What the TUI does **not** do

- It does not call `xicli` directly. Every RAID, pool, and drive query goes through the gRPC daemon at `localhost:6066`. If the daemon is down, the screen is inert — there is no fallback path.
- It does not edit `/etc/exports` or `/etc/nfs.conf` itself. NFS state mutations always cross the `/run/xinas-nfs-helper.sock` boundary.
- It does not perform initialisation control (`raid_init_start` / `raid_init_stop`) or reconstruction control (`raid_recon_start` / `raid_recon_stop`). The RPCs exist in the client but no menu entry calls them — they currently belong to xiRAID's automatic management.
- It does not delete arrays without `force=True`. Every `_delete_array` path passes `force=True`, on the assumption that the two-stage confirmation gate is the real safety. The non-force destroy semantics are not exposed.
- It does not edit `xiraid_arrays` or `xfs_filesystems` Ansible facts. Day-1 (installer) topology is owned by Ansible; day-2 mutations live in the gRPC daemon's state. The two are reconciled via xiraid's persistent config, not via Ansible re-runs.
- It does not multiplex drives between RAID and pool membership. The drive filters explicitly exclude drives that are already a member of either.
