# RAID CRUD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Create, Modify, and Delete RAID array operations to the RAID Management screen.

**Architecture:** Extend `xinas_menu/screens/raid.py` with 3 new menu items (5=Create, 6=Modify, 7=Delete) that use multi-step dialog wizards to collect parameters, call existing gRPC client methods (`raid_create`, `raid_modify`, `raid_destroy`), and audit log the results. Follows the proven NFS screen CRUD pattern.

**Tech Stack:** Textual TUI, gRPC (grpc.aio), existing dialog widgets (SelectDialog, InputDialog, ConfirmDialog)

---

### Task 1: Add menu items and dispatcher

**Files:**
- Modify: `xinas_menu/screens/raid.py`

**Step 1: Add new menu items to `_MENU`**

Replace the current `_MENU` list:

```python
_MENU = [
    MenuItem("1", "Quick Overview"),
    MenuItem("2", "Extended Details"),
    MenuItem("3", "Physical Drives"),
    MenuItem("4", "Spare Pools"),
    MenuItem("", "", separator=True),
    MenuItem("5", "Create Array"),
    MenuItem("6", "Modify Array"),
    MenuItem("7", "Delete Array"),
    MenuItem("0", "Back"),
]
```

**Step 2: Add imports at top of file**

Add these imports after the existing ones:

```python
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.select_dialog import SelectDialog
```

**Step 3: Update the event dispatcher**

Add cases to `on_navigable_menu_selected`:

```python
elif key == "5":
    self._create_array_wizard()
elif key == "6":
    self._modify_array()
elif key == "7":
    self._delete_array()
```

**Step 4: Add stub methods**

```python
@work(exclusive=True)
async def _create_array_wizard(self) -> None:
    pass  # Task 2

@work(exclusive=True)
async def _modify_array(self) -> None:
    pass  # Task 3

@work(exclusive=True)
async def _delete_array(self) -> None:
    pass  # Task 4
```

**Step 5: Update docstring**

Change class docstring to: `"""RAID management — view, create, modify, delete arrays."""`

**Step 6: Commit**

```bash
git add xinas_menu/screens/raid.py
git commit -m "feat(raid): add menu items for create/modify/delete array"
```

---

### Task 2: Implement Create Array wizard

**Files:**
- Modify: `xinas_menu/screens/raid.py`

**Step 1: Add drive grouping helper**

Add this helper function before the `RAIDScreen` class:

```python
_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]
_STRIP_SIZES = ["16", "32", "64", "128", "256"]


async def _get_drive_groups(grpc_client) -> tuple[dict[str, list[str]], list[dict]]:
    """Fetch NVMe drives and group by NUMA node + size category.

    Returns (groups_dict, all_drives) where groups_dict maps
    display labels to lists of device paths.
    """
    ok, disks, err = await grpc_client.disk_list()
    if not ok or not disks:
        return {}, []

    # Filter NVMe only, exclude system drives and drives already in RAID
    nvme = [
        d for d in disks
        if "nvme" in d.get("name", "").lower()
        and not d.get("system")
        and not d.get("raid_name")
    ]
    if not nvme:
        return {}, nvme

    # Classify by size: small (<1GB) vs large
    SMALL_THRESHOLD = 1_000_000_000  # 1 GB
    groups: dict[str, list[str]] = {}
    for d in nvme:
        numa = d.get("numa_node", d.get("numa", "0"))
        size_bytes = d.get("size_bytes", d.get("size_raw", 0)) or 0
        size_cat = "small" if size_bytes < SMALL_THRESHOLD else "large"
        key = f"All {size_cat} NVMe, NUMA {numa}"
        groups.setdefault(key, []).append(d["name"])

    # Add aggregate options
    all_large = [p for d in nvme for p in [d["name"]]
                 if (d.get("size_bytes", d.get("size_raw", 0)) or 0) >= SMALL_THRESHOLD]
    all_small = [p for d in nvme for p in [d["name"]]
                 if (d.get("size_bytes", d.get("size_raw", 0)) or 0) < SMALL_THRESHOLD]
    if all_large:
        groups[f"All large NVMe ({len(all_large)} drives)"] = all_large
    if all_small:
        groups[f"All small NVMe ({len(all_small)} drives)"] = all_small

    return groups, nvme
```

**Step 2: Implement the wizard**

Replace the `_create_array_wizard` stub:

```python
@work(exclusive=True)
async def _create_array_wizard(self) -> None:
    """Multi-step wizard: name, level, drives, strip size, [group size], [spare pool]."""
    # Step 1: Array name
    name = await self.app.push_screen_wait(
        InputDialog("Array name (e.g. data0):", "Create Array — Step 1")
    )
    if not name:
        return

    # Step 2: RAID level
    level = await self.app.push_screen_wait(
        SelectDialog(_RAID_LEVELS, title="Create Array — Step 2",
                     prompt="Select RAID level:")
    )
    if not level:
        return

    # Step 3: Drive selection
    groups, all_nvme = await _get_drive_groups(self.app.grpc)
    if not groups:
        await self.app.push_screen_wait(
            ConfirmDialog("No available NVMe drives found.", "Error")
        )
        return

    group_labels = list(groups.keys()) + ["Custom..."]
    choice = await self.app.push_screen_wait(
        SelectDialog(group_labels, title="Create Array — Step 3",
                     prompt="Select drives:")
    )
    if not choice:
        return

    if choice == "Custom...":
        available = ", ".join(d["name"] for d in all_nvme)
        custom = await self.app.push_screen_wait(
            InputDialog(
                f"Enter drive paths (comma-separated):\n\nAvailable: {available}",
                "Create Array — Drives",
            )
        )
        if not custom:
            return
        drives = [d.strip() for d in custom.split(",") if d.strip()]
    else:
        drives = groups.get(choice, [])

    if not drives:
        await self.app.push_screen_wait(
            ConfirmDialog("No drives selected.", "Error")
        )
        return

    # Step 4: Strip size
    strip = await self.app.push_screen_wait(
        SelectDialog(_STRIP_SIZES, title="Create Array — Step 4",
                     prompt="Strip size (KB, default=64):")
    )
    if not strip:
        strip = "64"

    # Step 5: Group size (mandatory for RAID 50/60)
    kwargs: dict = {"strip_size": int(strip)}
    if level in ("50", "60"):
        gs = await self.app.push_screen_wait(
            InputDialog("Group size (mandatory for RAID 50/60):",
                        "Create Array — Group Size")
        )
        if not gs:
            return
        kwargs["group_size"] = int(gs)

    # Step 6: Spare pool (optional)
    pool = await self.app.push_screen_wait(
        InputDialog("Spare pool name (blank to skip):",
                    "Create Array — Spare Pool")
    )
    if pool:
        kwargs["sparepool"] = pool

    # Step 7: Confirm
    summary = (
        f"Name:       {name}\n"
        f"Level:      RAID-{level}\n"
        f"Drives:     {len(drives)} ({', '.join(drives[:4])}"
        f"{'...' if len(drives) > 4 else ''})\n"
        f"Strip Size: {strip} KB"
    )
    if "group_size" in kwargs:
        summary += f"\nGroup Size: {kwargs['group_size']}"
    if "sparepool" in kwargs:
        summary += f"\nSpare Pool: {kwargs['sparepool']}"

    confirmed = await self.app.push_screen_wait(
        ConfirmDialog(f"Create this RAID array?\n\n{summary}", "Confirm Create")
    )
    if not confirmed:
        return

    # Execute
    ok, data, err = await self.app.grpc.raid_create(name, level, drives, **kwargs)
    if ok:
        self.app.audit.log("raid.create", f"{name} RAID-{level} {len(drives)} drives", "OK")
        self._show_quick()
    else:
        await self.app.push_screen_wait(
            ConfirmDialog(f"Failed to create array:\n{_grpc_short_error(err)}", "Error")
        )
```

**Step 3: Commit**

```bash
git add xinas_menu/screens/raid.py
git commit -m "feat(raid): implement Create Array wizard with drive grouping"
```

---

### Task 3: Implement Modify Array

**Files:**
- Modify: `xinas_menu/screens/raid.py`

**Step 1: Add modifiable parameters map**

Add this constant after `_STRIP_SIZES`:

```python
_MODIFY_PARAMS = [
    ("strip_size", "Strip Size (KB)", "select", _STRIP_SIZES),
    ("group_size", "Group Size", "input", None),
    ("sparepool", "Spare Pool", "input", None),
    ("init_prio", "Init Priority (0-100)", "input", None),
    ("recon_prio", "Recon Priority (0-100)", "input", None),
    ("resync_enabled", "Resync Enabled", "select", ["true", "false"]),
    ("sched_enabled", "Scheduler Enabled", "select", ["true", "false"]),
    ("memory_limit", "Memory Limit (MB)", "input", None),
    ("merge_read_enabled", "Merge Read Enabled", "select", ["true", "false"]),
    ("merge_write_enabled", "Merge Write Enabled", "select", ["true", "false"]),
    ("merge_read_max", "Merge Read Max (KB)", "input", None),
    ("merge_write_max", "Merge Write Max (KB)", "input", None),
]
```

**Step 2: Implement modify method**

Replace the `_modify_array` stub:

```python
@work(exclusive=True)
async def _modify_array(self) -> None:
    """Select array -> select parameter -> enter value -> confirm -> apply."""
    # Step 1: Get array list
    ok, data, err = await self.app.grpc.raid_show()
    if not ok:
        await self.app.push_screen_wait(
            ConfirmDialog(f"Cannot load arrays:\n{_grpc_short_error(err)}", "Error")
        )
        return

    arrays = _as_array_dict(data)
    if not arrays:
        await self.app.push_screen_wait(
            ConfirmDialog("No RAID arrays configured.", "Modify Array")
        )
        return

    # Step 2: Select array
    arr_name = await self.app.push_screen_wait(
        SelectDialog(list(arrays.keys()), title="Modify Array",
                     prompt="Select array to modify:")
    )
    if not arr_name:
        return

    # Step 3: Select parameter
    param_labels = [p[1] for p in _MODIFY_PARAMS]
    param_choice = await self.app.push_screen_wait(
        SelectDialog(param_labels, title=f"Modify {arr_name}",
                     prompt="Select parameter to change:")
    )
    if not param_choice:
        return

    # Find the parameter entry
    param_entry = None
    for entry in _MODIFY_PARAMS:
        if entry[1] == param_choice:
            param_entry = entry
            break
    if not param_entry:
        return

    param_key, param_label, widget_type, options = param_entry

    # Step 4: Get new value
    if widget_type == "select" and options:
        new_val = await self.app.push_screen_wait(
            SelectDialog(options, title=f"Set {param_label}",
                         prompt=f"New value for {param_label}:")
        )
    else:
        new_val = await self.app.push_screen_wait(
            InputDialog(f"New value for {param_label}:", f"Modify {arr_name}")
        )
    if not new_val:
        return

    # Convert value to appropriate type
    if new_val in ("true", "false"):
        typed_val = new_val == "true"
    elif new_val.isdigit():
        typed_val = int(new_val)
    else:
        typed_val = new_val

    # Step 5: Confirm
    confirmed = await self.app.push_screen_wait(
        ConfirmDialog(
            f"Modify array '{arr_name}'?\n\n"
            f"  {param_label}: {new_val}",
            "Confirm Modify",
        )
    )
    if not confirmed:
        return

    # Execute
    ok, _, err = await self.app.grpc.raid_modify(arr_name, **{param_key: typed_val})
    if ok:
        self.app.audit.log("raid.modify", f"{arr_name} {param_key}={new_val}", "OK")
        self._show_quick()
    else:
        await self.app.push_screen_wait(
            ConfirmDialog(f"Failed to modify array:\n{_grpc_short_error(err)}", "Error")
        )
```

**Step 3: Commit**

```bash
git add xinas_menu/screens/raid.py
git commit -m "feat(raid): implement Modify Array with parameter selection"
```

---

### Task 4: Implement Delete Array

**Files:**
- Modify: `xinas_menu/screens/raid.py`

**Step 1: Implement delete method**

Replace the `_delete_array` stub:

```python
@work(exclusive=True)
async def _delete_array(self) -> None:
    """Select array -> confirm with warning -> destroy."""
    # Step 1: Get array list
    ok, data, err = await self.app.grpc.raid_show()
    if not ok:
        await self.app.push_screen_wait(
            ConfirmDialog(f"Cannot load arrays:\n{_grpc_short_error(err)}", "Error")
        )
        return

    arrays = _as_array_dict(data)
    if not arrays:
        await self.app.push_screen_wait(
            ConfirmDialog("No RAID arrays configured.", "Delete Array")
        )
        return

    # Step 2: Select array
    arr_name = await self.app.push_screen_wait(
        SelectDialog(list(arrays.keys()), title="Delete Array",
                     prompt="Select array to delete:")
    )
    if not arr_name:
        return

    # Build warning with drive count
    arr = arrays.get(arr_name, {})
    dev_count = len(arr.get("devices", [])) if isinstance(arr, dict) else 0
    level = arr.get("level", "?") if isinstance(arr, dict) else "?"

    # Step 3: Confirm with warning
    confirmed = await self.app.push_screen_wait(
        ConfirmDialog(
            f"DESTROY array '{arr_name}'?\n\n"
            f"  RAID Level:  {level}\n"
            f"  Devices:     {dev_count}\n\n"
            f"  WARNING: All data on this array will be lost!\n"
            f"  This action cannot be undone.",
            "Confirm Delete",
        )
    )
    if not confirmed:
        return

    # Execute
    ok, _, err = await self.app.grpc.raid_destroy(arr_name, force=True)
    if ok:
        self.app.audit.log("raid.destroy", arr_name, "OK")
        self._show_quick()
    else:
        await self.app.push_screen_wait(
            ConfirmDialog(f"Failed to delete array:\n{_grpc_short_error(err)}", "Error")
        )
```

**Step 2: Commit**

```bash
git add xinas_menu/screens/raid.py
git commit -m "feat(raid): implement Delete Array with safety confirmation"
```

---

### Task 5: Version bump and final commit

**Files:**
- Modify: `xinas_menu/version.py`

**Step 1: Bump version**

```python
XINAS_MENU_VERSION = "2.7.0"
```

**Step 2: Commit and push**

```bash
git add xinas_menu/version.py xinas_menu/screens/raid.py
git commit -m "feat(raid): RAID CRUD operations — create, modify, delete arrays

Add 3 new menu items to the RAID Management screen:
- Create Array: multi-step wizard with NVMe drive grouping by NUMA/size
- Modify Array: parameter selection with type-aware input
- Delete Array: safety confirmation with array details

Uses existing gRPC client methods (raid_create, raid_modify, raid_destroy)
and follows the NFS screen CRUD pattern."
git push
```
