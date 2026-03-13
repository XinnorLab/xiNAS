# RAID CRUD Operations — Design

**Date:** 2026-03-13
**Scope:** Add create, modify, and delete RAID array operations to the RAID Management screen in xinas-menu.

## Context

The RAID screen (`xinas_menu/screens/raid.py`) is currently read-only with 4 menu items (Quick Overview, Extended Details, Physical Drives, Spare Pools). The gRPC client already exposes `raid_create()`, `raid_modify()`, and `raid_destroy()`. The NFS screen demonstrates a proven CRUD pattern using dialog wizards. This design adds 3 new menu items following that pattern.

## New Menu Items

| # | Menu Item | gRPC Method |
|---|-----------|-------------|
| 5 | Create Array | `raid_create(name, level, drives, **kwargs)` |
| 6 | Modify Array | `raid_modify(name, **kwargs)` |
| 7 | Delete Array | `raid_destroy(name, force)` |

## Create Array Wizard

Multi-step dialog flow:

1. **Name** — `InputDialog` (e.g. `"data0"`)
2. **RAID Level** — `SelectDialog`: `0, 1, 5, 6, 10, 50, 60`
3. **Drive Selection** — NVMe only. `disk_list()` fetches all drives, filters out system drive and non-NVMe. Drives are grouped by:
   - **NUMA node** (0, 1, ...)
   - **Size category** (small = ~500MB log namespaces, large = remaining capacity data namespaces)
   - `SelectDialog` options: `"All large NVMe, NUMA 0 (4 drives)"`, `"All large NVMe, NUMA 1 (4 drives)"`, `"All small NVMe (8 drives)"`, `"All large NVMe (8 drives)"`, `"Custom..."` (InputDialog for comma-separated paths)
4. **Strip Size** — `SelectDialog`: `16K, 32K, 64K, 128K, 256K` (default: `64K`)
5. **Group Size** — `InputDialog`, **only shown for RAID 50/60** (mandatory for those levels)
6. **Spare Pool** — `InputDialog` (optional, blank to skip)
7. **Confirm** — `ConfirmDialog` with summary of all parameters
8. Call `self.app.grpc.raid_create(name, level, drives, strip_size=..., group_size=..., sparepool=...)`
9. Audit log + refresh content panel

## Modify Array

1. Fetch array list via `raid_show()`
2. `SelectDialog` to pick which array
3. `SelectDialog` for which parameter to change:
   - `strip_size` (16K–256K)
   - `group_size`
   - `sparepool`
   - `init_prio`
   - `recon_prio`
   - `resync_enabled`
   - `sched_enabled`
   - `memory_limit`
   - `merge_read_enabled` / `merge_write_enabled`
   - `merge_read_max` / `merge_write_max`
4. `InputDialog` or `SelectDialog` for new value (type-dependent)
5. `ConfirmDialog` with change summary
6. Call `self.app.grpc.raid_modify(name, **{param: value})`
7. Audit log + refresh

## Delete Array

1. Fetch array list via `raid_show()`
2. `SelectDialog` to pick which array
3. `ConfirmDialog` with array name, drive count, and destruction warning
4. Call `self.app.grpc.raid_destroy(name, force=True)`
5. Audit log + refresh

## Error Handling

All gRPC calls return `(ok, data, err)`. On failure, show `ConfirmDialog(err, "Error")`. On success, audit log the operation and refresh the content panel display.

## Drive Grouping Logic

```python
# Pseudocode for drive grouping
disks = await self.app.grpc.disk_list()
nvme = [d for d in disks if d["type"] == "nvme" and not d.get("system")]
groups = {}
for d in nvme:
    numa = d.get("numa_node", 0)
    size_cat = "small" if d["size_bytes"] < 1_000_000_000 else "large"
    key = f"All {size_cat} NVMe, NUMA {numa}"
    groups.setdefault(key, []).append(d["name"])
# Add "All large NVMe", "All small NVMe" aggregate options
# Add "Custom..." option
```

## Pattern Reference

Follows the NFS screen CRUD pattern:
- `@work` decorator for async operations
- Dialog chain: SelectDialog -> InputDialog -> ConfirmDialog
- `self.app.audit.log("raid.create", name, "OK")` for audit trail
- Refresh content panel after mutations
