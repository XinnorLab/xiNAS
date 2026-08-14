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
| 1 | Quick Overview | `_show_quick()` → `GET /api/v1/arrays` |
| 2 | Extended Details | `_show_extended()` → `GET /api/v1/arrays` (same call; renders `spec.tuning` too) |
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

`InputDialog` with validation. **The rule below is the xiRAID Classic 4.4 engine rule, not a xiNAS convention** — it is transcribed from the [xiRAID 4.4 command reference](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html) for `xicli raid create -n/--name`, and it is the canonical statement of array naming for the whole product (TUI, control-path plan validator, API contract):

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

1. **Pick an array.** `grpc.raid_show()` → `SelectDialog` over array names.
2. **Pick a parameter.** `SelectDialog` over `_MODIFY_PARAMS`, each tuple of `(grpc_key, label, kind, options, value_type)`. Parameters offered, in order: CPU Affinity, Spare Pool, Init Priority, Recon Priority, Scheduler Enabled, Memory Limit, Merge Read Enabled, Merge Write Enabled, Merge Read Max, Merge Write Max. (`resync_enabled` is create-only — xiRAID's `RaidModify` has no such field — so it is not offered.) The two merge-max knobs are **times in microseconds** (the daemon spells them `merge_*_usecs`), so their labels read `(us)` — they were mislabelled `(KB)` until the tuning surface became observable and read and write paths could be compared.
3. **Per-parameter prompt** — see §5.1.
4. **Confirm + dispatch.** Value is coerced to the declared `vtype` (`int` for the integer knobs, `str` for the rest). `grpc.raid_modify(name, **{key: value})` is invoked. On success: audit (`raid.modify`) + snapshot (`raid_modify`) + Quick Overview refresh.

Step 1 guards the empty case: if the array listing fails or returns no arrays, the flow aborts on an **OK-only** dialog ("No RAID arrays configured." / "No arrays available."). Delete Array (§6) guards the same way. This is one instance of the screen-wide dialog convention — see §12.

### 5.1 CPU Affinity dialog (special case)

CPU affinity is the only knob with a multi-mode UI. The current value is read from the array dict (`arr["cpu_allowed"]`, defaulting to `"all"`). It arrives as a range-compressed CPU list (`5-7`, `0,2,4-6`) — the same spelling the Manual CPU List mode accepts — so what the dialog shows is what an operator would retype. The `"all"` default now means the knob was genuinely not observed; it used to also cover a pinned array whose affinity the parser dropped for arriving as an array of core ids rather than a string (see `docs/control-path/s3-xiraid-array-spec.md` §2).

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

1. Pool name validated against `POOL_NAME_RE = ^[A-Za-z0-9_]{1,64}$` via `validate_pool_name()` in [xinas_menu/utils/xiraid_names.py](../../xinas_menu/utils/xiraid_names.py) — the **array character set, hyphens included in the ban**, over the control path's incumbent 64-character bound.

   The xiRAID 4.4 command reference documents no naming rule for `xicli pool create -n` (it says only "The name of the spare pool"), so unlike the array rule this is a xiNAS choice. The character set is deliberately conservative: pool names are engine identifiers handed to the same `xicli` binary, hyphens are not accepted anywhere xiRAID naming *is* documented, and the two failure modes are not symmetric — a name rejected here costs the operator one keystroke, while a name accepted here and rejected by the engine fails after the confirmation step, mid-apply. If Xinnor documents a laxer pool rule, relax this one; do not relax it on the assumption that it is lax.

   The **length bound is deliberately not** the array's 28. There is no vendor source for a pool length limit, and xiNAS has positive evidence that longer names work: the array executor creates its own spare pools as `xnsp_<array>` (up to 33 characters for a maximum-length array name, `derivedPoolName()` in [xiNAS-MCP/src/lib/xiraid/validate.ts](../../xiNAS-MCP/src/lib/xiraid/validate.ts)). A 28-character pool rule would outlaw pools this system creates itself, so the incumbent 64 stands; `POOL_NAME_MAX_LEN` must remain ≥ `len("xnsp_") + ARRAY_NAME_MAX_LEN`.

   `power`/`uevent` are **not** reserved for pools. Those two names are prohibited because they collide with sysfs attributes under `/sys/block/xi_<name>/`, and a spare pool is not a block device.

   The `Pool` schema in [api-v1.yaml](../../docs/control-path/api-v1.yaml) intentionally keeps `name` unpatterned. Publishing a pattern there would over-claim — it would present a xiNAS-local precaution as a vendor contract — and would spend a second `oasdiff` breaking-change finding on a rule we are less sure of than the array one. Enforcement lives in `requireName()` in [xiNAS-MCP/src/api/plan/providers/pool.ts](../../xiNAS-MCP/src/api/plan/providers/pool.ts), which returns `INVALID_ARGUMENT` at plan time.
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

## 12. Dialog conventions — informational vs consent

`ConfirmDialog` ([widgets/confirm_dialog.py](../../xinas_menu/widgets/confirm_dialog.py)) renders **Yes / No** buttons by default and shows a single **OK** button only when constructed with `ok_only=True`. The two are not interchangeable, and this rule is TUI-wide (RAID Management is the reference implementation):

- **Informational / error / notice dialogs → OK-only.** Any pop-up that reports a result, shows a read-only detail view, or surfaces a failure — i.e. one whose boolean return value is discarded (`await push_screen_wait(ConfirmDialog(...))` immediately followed by `return`, with nothing branching on the result) — MUST pass `ok_only=True`. A bare Yes/No on "No spare pools exist.", "SMART read failed", or "Could not list drives." asks the operator an unanswerable question.
- **Yes/No is reserved for genuine consent.** Any dialog whose result is captured and branched on (`if not confirmed: return`, `if confirmed:`, and every overwrite / retry / destroy prompt) stays Yes/No. The two-stage destroy gate (§6.2) keeps Yes/No on **both** stages.

This governs every RAID Management, Spare Pools (§7), and Physical Drives (§8) dialog. The same convention is mirrored for the other day-2 surfaces in [fs-shares-management-spec.md §9](fs-shares-management-spec.md#9-dialog-conventions--informational-vs-consent) and [spec-network-management.md](../Network/spec-network-management.md#dialog-conventions).
