"""RAIDScreen — Quick Overview, Extended Details, Physical Drives, Spare Pools, CRUD."""
from __future__ import annotations

import logging
import os
import re
from typing import Any

_log = logging.getLogger(__name__)

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.checklist_dialog import ChecklistDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_ARRAY_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]
_STRIP_SIZES = ["16", "32", "64", "128", "256"]
_MODIFY_PARAMS = [
    # (key, label, kind, options, value_type)
    ("strip_size", "Strip Size (KB)", "select", _STRIP_SIZES, int),
    ("group_size", "Group Size", "input", None, int),
    ("sparepool", "Spare Pool", "input", None, str),
    ("init_prio", "Init Priority (0-100)", "input", None, int),
    ("recon_prio", "Recon Priority (0-100)", "input", None, int),
    ("resync_enabled", "Resync Enabled", "select", ["true", "false"], str),
    ("sched_enabled", "Scheduler Enabled", "select", ["true", "false"], str),
    ("memory_limit", "Memory Limit (MB)", "input", None, int),
    ("merge_read_enabled", "Merge Read Enabled", "select", ["true", "false"], str),
    ("merge_write_enabled", "Merge Write Enabled", "select", ["true", "false"], str),
    ("merge_read_max", "Merge Read Max (KB)", "input", None, int),
    ("merge_write_max", "Merge Write Max (KB)", "input", None, int),
]

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


def _fmt_size(size_bytes: int) -> str:
    """Format byte count into human-readable string."""
    if size_bytes <= 0:
        return "N/A"
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != "B" else f"{size_bytes} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} EB"


def _drive_label(d: dict) -> str:
    """Format a rich label for a drive: name | size | model | NUMA."""
    name = d.get("name", "?")
    size = _fmt_size(d.get("size_bytes") or d.get("size_raw") or 0)
    model = d.get("model") or "unknown"
    numa = d.get("numa_node", d.get("numa", "?"))
    return f"{name:<14s}  {size:>8s}  {model:<20s}  NUMA {numa}"


async def _get_drive_groups(grpc_client) -> tuple[dict[str, list[str]], list[dict]]:
    """Fetch NVMe drives grouped by NUMA node + size category."""
    ok, disks, err = await grpc_client.disk_list()
    if not ok or not disks:
        return {}, []
    SMALL_THRESHOLD = 1_000_000_000  # 1 GB
    nvme = [d for d in disks if "nvme" in d.get("name", "").lower()
            and not d.get("system") and not d.get("raid_name")]
    if not nvme:
        return {}, nvme
    groups: dict[str, list[str]] = {}
    for d in nvme:
        numa = d.get("numa_node", d.get("numa", "0"))
        size_bytes = d.get("size_bytes", d.get("size_raw", 0)) or 0
        size_cat = "small" if size_bytes < SMALL_THRESHOLD else "large"
        key = f"All {size_cat} NVMe, NUMA {numa}"
        groups.setdefault(key, []).append(d["name"])
    all_large = [d["name"] for d in nvme if (d.get("size_bytes", d.get("size_raw", 0)) or 0) >= SMALL_THRESHOLD]
    all_small = [d["name"] for d in nvme if (d.get("size_bytes", d.get("size_raw", 0)) or 0) < SMALL_THRESHOLD]
    if all_large:
        groups[f"All large NVMe ({len(all_large)} drives)"] = all_large
    if all_small:
        groups[f"All small NVMe ({len(all_small)} drives)"] = all_small
    return groups, nvme


class RAIDScreen(Screen):
    """RAID management — views and CRUD operations for arrays."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  RAID Management", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="raid-nav")
            yield ScrollableTextView(
                "\033[1m\033[36mRAID Management\033[0m\n"
                "\n"
                "  \033[1m1\033[0m  \033[36mQuick Overview\033[0m    \033[2mSummary of all arrays\033[0m\n"
                "  \033[1m2\033[0m  \033[36mExtended Details\033[0m  \033[2mDetailed array info (capacity, state, devices)\033[0m\n"
                "  \033[1m3\033[0m  \033[36mPhysical Drives\033[0m   \033[2mDrive list with health and membership\033[0m\n"
                "  \033[1m4\033[0m  \033[36mSpare Pools\033[0m       \033[2mView spare pool configuration\033[0m\n"
                "  \033[1m5\033[0m  \033[36mCreate Array\033[0m      \033[2mCreate a new RAID array (wizard)\033[0m\n"
                "  \033[1m6\033[0m  \033[36mModify Array\033[0m      \033[2mChange array parameters\033[0m\n"
                "  \033[1m7\033[0m  \033[36mDelete Array\033[0m      \033[2mDestroy an existing array\033[0m\n",
                id="raid-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._show_quick()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_quick()
        elif key == "2":
            self._show_extended()
        elif key == "3":
            self._show_drives()
        elif key == "4":
            self._show_pools()
        elif key == "5":
            self._create_array_wizard()
        elif key == "6":
            self._modify_array()
        elif key == "7":
            self._delete_array()

    @work(exclusive=True)
    async def _show_quick(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays…")
        ok, data, err = await self.app.grpc.raid_show()
        view.set_content(
            _format_raid_overview(data, extended=False) if ok
            else f"Could not load RAID info: {grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_extended(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays (extended)…")
        ok, data, err = await self.app.grpc.raid_show(extended=True)
        view.set_content(
            _format_raid_overview(data, extended=True) if ok
            else f"Could not load RAID info: {grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_drives(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading physical drives…")
        ok, data, err = await self.app.grpc.raid_show(extended=True)
        view.set_content(
            _format_physical_drives(data) if ok
            else f"Could not load drive info: {grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_pools(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading spare pools…")
        ok, data, err = await self.app.grpc.pool_show()
        view.set_content(
            _format_spare_pools(data) if ok
            else f"Could not load pool info: {grpc_short_error(err)}"
        )

    # ── Create Array Wizard ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _create_array_wizard(self) -> None:
        """Multi-step wizard: name -> level -> drives -> strip -> group_size -> spare -> confirm."""
        # Step 1: Array name (with validation)
        while True:
            name = await self.app.push_screen_wait(
                InputDialog("Array name:", "Create Array — Step 1", placeholder="data0")
            )
            if not name:
                return
            if len(name) > 64:
                self.app.notify("Array name must be 64 characters or fewer.", severity="error")
                continue
            if not _ARRAY_NAME_RE.match(name):
                self.app.notify(
                    "Array name must contain only letters, digits, hyphens, and underscores.",
                    severity="error",
                )
                continue
            break

        # Step 2: RAID level
        level = await self.app.push_screen_wait(
            SelectDialog(_RAID_LEVELS, title="Create Array — Step 2",
                         prompt="Select RAID level:")
        )
        if not level:
            return

        # Step 3: Select drives (grouped by NUMA/size)
        groups, nvme = await _get_drive_groups(self.app.grpc)
        if not nvme:
            await self.app.push_screen_wait(
                ConfirmDialog("No available NVMe drives found.", "Error")
            )
            return

        choices = list(groups.keys()) + ["Pick individual drives"]
        group_choice = await self.app.push_screen_wait(
            SelectDialog(choices, title="Create Array — Step 3",
                         prompt="Select drive group:")
        )
        if not group_choice:
            return

        if group_choice == "Pick individual drives":
            # Full-featured drive picker with filters, sort, detail view
            selected = await self.app.push_screen_wait(
                DrivePickerScreen(nvme, title="Create Array — Select Drives")
            )
            if not selected:
                return
            drives = selected
        else:
            # Show group drives in picker for review (all pre-selected)
            group_drives = groups.get(group_choice, [])
            group_names = {d if isinstance(d, str) else d.get("name", "") for d in group_drives}
            # Filter full drive info for this group
            group_drive_info = [d for d in nvme if d.get("name") in group_names]
            if not group_drive_info:
                group_drive_info = group_drives
            selected = await self.app.push_screen_wait(
                DrivePickerScreen(
                    group_drive_info,
                    title=f"Review — {group_choice}",
                    preselected=group_names,
                )
            )
            if not selected:
                return
            drives = selected

        if not drives:
            await self.app.push_screen_wait(
                ConfirmDialog("No drives selected.", "Error")
            )
            return

        # Step 4: Strip size
        strip = await self.app.push_screen_wait(
            SelectDialog(_STRIP_SIZES, title="Create Array — Step 4",
                         prompt="Strip size (KB), default 64:")
        )
        if not strip:
            strip = "64"

        # Step 5: Group size (mandatory for RAID 50/60)
        kwargs: dict[str, Any] = {"strip_size": int(strip)}
        if level in ("50", "60"):
            while True:
                group_size = await self.app.push_screen_wait(
                    InputDialog("Group size (required for RAID 50/60):",
                                "Create Array — Step 5", placeholder="4")
                )
                if not group_size:
                    return
                try:
                    gs = int(group_size)
                    if gs <= 0:
                        raise ValueError
                except ValueError:
                    self.app.notify("Group size must be a positive integer.", severity="error")
                    continue
                kwargs["group_size"] = gs
                break

        # Step 6: Spare pool (optional)
        sparepool = await self.app.push_screen_wait(
            InputDialog("Spare pool name (leave blank for none):",
                        "Create Array — Spare Pool")
        )
        if sparepool:
            kwargs["sparepool"] = sparepool

        # Confirm
        summary = (
            f"Name:       {name}\n"
            f"Level:      RAID-{level}\n"
            f"Drives:     {', '.join(drives)}\n"
            f"Strip Size: {strip} KB"
        )
        if "group_size" in kwargs:
            summary += f"\nGroup Size: {kwargs['group_size']}"
        if "sparepool" in kwargs:
            summary += f"\nSpare Pool: {kwargs['sparepool']}"

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Create this RAID array?\n\n{summary}",
                          "Confirm Create")
        )
        if not confirmed:
            return

        # Ensure full device paths (e.g. /dev/nvme2n1, not nvme2n1)
        drives = [d if d.startswith("/dev/") else f"/dev/{d}" for d in drives]

        ok, _, err = await self.app.grpc.raid_create(name, level, drives, **kwargs)
        if ok:
            self.app.audit.log("raid.create",
                               f"{name} RAID-{level} ({len(drives)} drives)", "OK")
            self._show_quick()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Create failed.\n{grpc_short_error(err)}", "Error")
            )

    # ── Modify Array ─────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _modify_array(self) -> None:
        """Pick array -> pick parameter -> enter value -> confirm -> apply."""
        ok, data, err = await self.app.grpc.raid_show()
        if not ok or not data:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"No arrays available.\n{grpc_short_error(err)}" if not ok
                    else "No RAID arrays configured.",
                    "Modify Array",
                )
            )
            return

        arrays = _as_array_dict(data)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Modify Array")
            )
            return

        arr_name = await self.app.push_screen_wait(
            SelectDialog(names, title="Modify Array",
                         prompt="Select array to modify:")
        )
        if not arr_name:
            return

        param_labels = [f"{label} ({key})" for key, label, _, _, _ in _MODIFY_PARAMS]
        param_choice = await self.app.push_screen_wait(
            SelectDialog(param_labels, title="Modify Array — Parameter",
                         prompt=f"Select parameter for {arr_name}:")
        )
        if not param_choice:
            return

        # Find the selected parameter
        idx = param_labels.index(param_choice)
        key, label, kind, options, vtype = _MODIFY_PARAMS[idx]

        if kind == "select" and options:
            value = await self.app.push_screen_wait(
                SelectDialog(options, title=f"Set {label}",
                             prompt=f"New value for {label}:")
            )
        else:
            value = await self.app.push_screen_wait(
                InputDialog(f"New value for {label}:", f"Set {label}")
            )

        if value is None:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Modify {arr_name}?\n\n{label}: {value}",
                "Confirm Modify",
            )
        )
        if not confirmed:
            return

        # Convert value to the expected type (Input widgets return strings)
        try:
            value = vtype(value)
        except (ValueError, TypeError):
            await self.app.push_screen_wait(
                ConfirmDialog(f"Invalid value: expected {vtype.__name__}", "Error")
            )
            return

        ok, _, err = await self.app.grpc.raid_modify(arr_name, **{key: value})
        if ok:
            self.app.audit.log("raid.modify", f"{arr_name} {key}={value}", "OK")
            self._show_quick()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Modify failed.\n{grpc_short_error(err)}", "Error")
            )

    # ── Delete Array ─────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _delete_array(self) -> None:
        """Pick array -> confirm with warning -> destroy."""
        ok, data, err = await self.app.grpc.raid_show()
        if not ok or not data:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"No arrays available.\n{grpc_short_error(err)}" if not ok
                    else "No RAID arrays configured.",
                    "Delete Array",
                )
            )
            return

        arrays = _as_array_dict(data)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Delete Array")
            )
            return

        arr_name = await self.app.push_screen_wait(
            SelectDialog(names, title="Delete Array",
                         prompt="Select array to delete:")
        )
        if not arr_name:
            return

        arr = arrays.get(arr_name, {})
        level = arr.get("level", "?") if isinstance(arr, dict) else "?"
        size = arr.get("size", "N/A") if isinstance(arr, dict) else "N/A"
        devs = arr.get("devices", []) if isinstance(arr, dict) else []
        warning = (
            f"RAID-{level}  |  {size}  |  {len(devs)} drive(s)\n\n"
            f"WARNING: This will DESTROY array '{arr_name}' and all data on it!\n"
            f"This action cannot be undone."
        )

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(warning, f"Delete {arr_name}?")
        )
        if not confirmed:
            return

        ok, _, err = await self.app.grpc.raid_destroy(arr_name, force=True)
        if ok:
            self.app.audit.log("raid.destroy", arr_name, "OK")
            self._show_quick()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Delete failed.\n{grpc_short_error(err)}", "Error")
            )


# ── Formatters ────────────────────────────────────────────────────────────────

_W = 70  # inner box width (between borders)

# ANSI color codes for RAID display
_GRN, _YLW, _RED, _CYN, _BLD, _DIM, _NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _visible_len(s: str) -> int:
    """Length of string after stripping ANSI escape codes."""
    return len(_ANSI_RE.sub("", s))


def _box_line(content: str = "", w: int = _W) -> str:
    pad = w - _visible_len(content)
    if pad < 0:
        content = content[:w]
        pad = 0
    return f"{_DIM}|{_NC} {content}{' ' * pad}{_DIM}|{_NC}"


def _box_sep(char: str = "-", w: int = _W) -> str:
    return f"{_DIM}+{char * (w + 1)}+{_NC}"


def _progress_bar(percent: int, width: int = 28) -> str:
    filled = int(percent * width / 100)
    empty = width - filled
    return f"[{'#' * filled}{'.' * empty}] {percent:3d}%"


def _state_icon(state: str) -> str:
    s = state.lower()
    if s in ("online", "initialized"):
        return f"{_GRN}*{_NC}"
    if s in ("initing", "rebuilding"):
        return f"{_YLW}~{_NC}"
    if s == "degraded":
        return f"{_YLW}!{_NC}"
    if s in ("offline", "failed"):
        return f"{_RED}x{_NC}"
    return "o"


def _state_color(state: str) -> str:
    s = state.lower()
    if s in ("online", "initialized"):
        return _GRN
    if s in ("initing", "rebuilding", "degraded"):
        return _YLW
    if s in ("offline", "failed"):
        return _RED
    return ""


def _format_state(state_list: Any) -> str:
    if not state_list:
        return "unknown"
    states = state_list if isinstance(state_list, list) else [state_list]
    states = [s for s in states if s]
    if not states:
        return "unknown"
    return " ".join(f"{_state_icon(s)} {_state_color(s)}{s}{_NC}" for s in states)


def _count_states(devices: list) -> tuple[int, int, int]:
    online = degraded = offline = 0
    for dev in devices:
        raw = (dev[2][0] if (isinstance(dev, list) and len(dev) > 2 and dev[2])
               else "unknown")
        s = (raw or "unknown").lower()
        if s == "online":
            online += 1
        elif s in ("degraded", "rebuilding"):
            degraded += 1
        else:
            offline += 1
    return online, degraded, offline


def _as_array_dict(data: Any) -> dict:
    """Normalise raid_show response to {name: array_dict}."""
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        return {(a.get("name", str(i)) if isinstance(a, dict) else str(i)): a
                for i, a in enumerate(data)}
    return {}


# ── Quick / Extended overview ──────────────────────────────────────────────────

def _format_raid_overview(data: Any, extended: bool = False) -> str:
    arrays = _as_array_dict(data)
    lines: list[str] = []

    title = "RAID ARRAYS — EXTENDED" if extended else "RAID ARRAYS — QUICK OVERVIEW"
    lines.append(_box_sep("="))
    pad = (_W - len(title)) // 2
    lines.append(f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}{title}{_NC}{' ' * (_W - pad - len(title) + 1)}{_DIM}|{_NC}")
    lines.append(_box_sep("="))
    lines.append("")

    if not arrays:
        lines.append(f"  {_DIM}(no RAID arrays configured){_NC}")
        return "\n".join(lines)

    for name, arr in arrays.items():
        if not isinstance(arr, dict):
            continue
        level = arr.get("level", "?")
        size = arr.get("size", "N/A")
        state = arr.get("state", [])
        devices = arr.get("devices", [])
        strip_size = arr.get("strip_size", "?")
        sparepool = arr.get("sparepool", "-")
        init_progress = arr.get("init_progress")
        memory_mb = arr.get("memory_usage_mb", 0)
        block_size = arr.get("block_size", 4096)

        online, degraded, offline = _count_states(devices)
        total = len(devices)
        state_str = _format_state(state)
        is_initing = any((s or "").lower() == "initing" for s in (state or []))

        dev_parts = [f"{total} total", f"{_GRN}{online} online{_NC}"]
        if degraded:
            dev_parts.append(f"{_YLW}{degraded} degraded{_NC}")
        if offline:
            dev_parts.append(f"{_RED}{offline} offline{_NC}")
        dev_summary = f" {_DIM}|{_NC} ".join(dev_parts)

        lines.append(_box_sep("-"))
        lines.append(_box_line(f" {_BLD}Array: {name.upper()}{_NC}"))
        lines.append(_box_sep())
        lines.append(_box_line())
        lines.append(_box_line(f"  {_DIM}RAID Level{_NC}    |  RAID-{level}"))
        lines.append(_box_line(f"  {_DIM}Capacity{_NC}      |  {size}"))
        lines.append(_box_line(f"  {_DIM}Status{_NC}        |  {state_str}"))
        lines.append(_box_line(f"  {_DIM}Devices{_NC}       |  {dev_summary}"))
        lines.append(_box_line(f"  {_DIM}Strip Size{_NC}    |  {strip_size} KB"))
        lines.append(_box_line(f"  {_DIM}Spare Pool{_NC}    |  {sparepool}"))

        if init_progress is not None and is_initing:
            lines.append(_box_line())
            lines.append(_box_line(f"  {_YLW}~ Initializing: {_progress_bar(init_progress)}{_NC}"))

        if extended:
            lines.append(_box_line())
            lines.append(_box_line(f"  {_DIM}Memory Usage{_NC}  |  {memory_mb} MB"))
            lines.append(_box_line(f"  {_DIM}Block Size{_NC}    |  {block_size} bytes"))

            health = arr.get("devices_health") or []
            wear = arr.get("devices_wear") or []
            if health or wear:
                lines.append(_box_line())
                lines.append(_box_sep())
                lines.append(_box_line(f" {_BLD}{_CYN}DEVICE HEALTH & WEAR{_NC}"))
                lines.append(_box_sep())
                for i, dev in enumerate(devices):
                    dev_path = (dev[1] if isinstance(dev, list) and len(dev) > 1
                                else str(dev)).replace("/dev/", "")
                    dev_state = (dev[2][0] if isinstance(dev, list) and len(dev) > 2
                                 and dev[2] else "?")
                    h = health[i] if i < len(health) else "N/A"
                    w = wear[i] if i < len(wear) else "N/A"
                    icon = _state_icon(dev_state)
                    sc = _state_color(dev_state)
                    lines.append(_box_line(f"  {icon} {sc}{dev_path:<16}{_NC} {_DIM}Health:{_NC} {h:<8} {_DIM}Wear:{_NC} {w}"))

        lines.append(_box_line())
        lines.append(_box_sep("-"))
        lines.append("")

    healthy = sum(
        1 for a in arrays.values()
        if isinstance(a, dict) and all(
            (s or "").lower() in ("online", "initialized")
            for s in (a.get("state") or [])
        )
    )
    lines.append(_box_sep("="))
    hc = _GRN if healthy == len(arrays) else _YLW
    lines.append(f"  Summary: {len(arrays)} array(s), {hc}{healthy} healthy{_NC}")
    lines.append(_box_sep("="))
    return "\n".join(lines)


# ── Physical Drives ────────────────────────────────────────────────────────────

def _get_drive_size(path: str) -> str:
    try:
        dev_name = os.path.basename(path)
        size_path = f"/sys/block/{dev_name}/size"
        if os.path.exists(size_path):
            with open(size_path) as f:
                sectors = int(f.read().strip())
            b = sectors * 512
            if b >= 1_099_511_627_776:
                return f"{b / 1_099_511_627_776:.1f} TB"
            if b >= 1_073_741_824:
                return f"{b / 1_073_741_824:.0f} GB"
            return f"{b // 1_048_576} MB"
    except Exception:
        _log.debug("failed to read drive size for %s", path, exc_info=True)
    return "N/A"


def _get_numa_node(path: str) -> str:
    try:
        dev_name = os.path.basename(path)
        m = re.match(r"(nvme\d+)", dev_name)
        if m:
            ctrl = m.group(1)
            p = f"/sys/class/nvme/{ctrl}/numa_node"
            if os.path.exists(p):
                with open(p) as f:
                    node = f.read().strip()
                return node if node != "-1" else "-"
        p = f"/sys/block/{dev_name}/device/numa_node"
        if os.path.exists(p):
            with open(p) as f:
                node = f.read().strip()
            return node if node != "-1" else "-"
    except Exception:
        _log.debug("failed to read NUMA node for %s", path, exc_info=True)
    return "-"


def _format_physical_drives(data: Any) -> str:
    arrays = _as_array_dict(data)
    lines: list[str] = []

    W2 = 75
    lines.append(f"{_BLD}{_CYN}PHYSICAL DRIVES{_NC}")
    lines.append(f"{_DIM}{'=' * W2}{_NC}")
    lines.append("")

    if not arrays:
        lines.append(f"  {_DIM}(no RAID arrays configured){_NC}")
        return "\n".join(lines)

    all_drives: list[dict] = []
    grouped: dict[str, list[dict]] = {}

    for arr_name, arr in arrays.items():
        if not isinstance(arr, dict):
            continue
        devices = arr.get("devices", [])
        health = arr.get("devices_health") or []
        wear = arr.get("devices_wear") or []
        serials = arr.get("serials") or []
        bucket: list[dict] = []

        for i, dev in enumerate(devices):
            path = (dev[1] if isinstance(dev, list) and len(dev) > 1 else str(dev))
            state = (dev[2][0] if isinstance(dev, list) and len(dev) > 2 and dev[2]
                     else "unknown")
            h = health[i] if i < len(health) else "N/A"
            w = wear[i] if i < len(wear) else "N/A"
            serial = serials[i] if i < len(serials) else "N/A"
            size = _get_drive_size(path)
            numa = _get_numa_node(path)
            entry = {
                "path": path, "state": state, "health": h,
                "wear": w, "serial": serial, "size": size, "numa": numa,
            }
            bucket.append(entry)
            all_drives.append(entry)

        grouped[arr_name] = bucket

    for arr_name, drives in grouped.items():
        online = sum(1 for d in drives if d["state"].lower() == "online")
        total = len(drives)
        lines.append(f"{_BLD}Array: {arr_name.upper()}{_NC}  ({_GRN}{online}{_NC}/{total} online)")
        lines.append(f"{_DIM}{'-' * W2}{_NC}")
        lines.append(f"  {_DIM}{'Device':<16}{'Size':<10}{'State':<12}{'NUMA':<6}{'Health':<9}{'Wear':<8}Serial{_NC}")
        lines.append(f"{_DIM}{'-' * W2}{_NC}")
        for d in drives:
            short = d["path"].replace("/dev/", "")
            icon = _state_icon(d["state"])
            sc = _state_color(d["state"])
            serial = str(d["serial"])[:16]
            lines.append(
                f"  {icon} {short:<14}{d['size']:<10}{sc}{d['state']:<12}{_NC}"
                f"{d['numa']:<6}{str(d['health']):<9}{str(d['wear']):<8}{serial}"
            )
        lines.append("")

    total_drives = len(all_drives)
    online_drives = sum(1 for d in all_drives if d["state"].lower() == "online")
    numa_nodes = sorted(set(d["numa"] for d in all_drives if d["numa"] != "-"))
    lines.append(f"{_DIM}{'=' * W2}{_NC}")
    summary = f"  Total: {total_drives} drive(s), {_GRN}{online_drives} online{_NC}"
    if numa_nodes:
        summary += f"  {_DIM}|{_NC}  NUMA nodes: {', '.join(numa_nodes)}"
    lines.append(summary)
    return "\n".join(lines)


# ── Spare Pools ────────────────────────────────────────────────────────────────

def _format_spare_pools(data: Any) -> str:
    W3 = 66
    lines: list[str] = []

    def bl(content: str = "") -> str:
        return _box_line(content, w=W3)

    def bs(char: str = "-") -> str:
        return _box_sep(char, w=W3)

    lines.append(bs("="))
    pad = (W3 - len("SPARE POOLS")) // 2
    lines.append(f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}SPARE POOLS{_NC}{' ' * (W3 - pad - len('SPARE POOLS') + 1)}{_DIM}|{_NC}")
    lines.append(bs("="))
    lines.append("")

    pools: dict = {}
    if isinstance(data, dict):
        pools = data
    elif isinstance(data, list):
        for p in data:
            if isinstance(p, dict):
                pools[p.get("name", str(len(pools)))] = p

    if not pools:
        lines.append("  No spare pools configured.")
        lines.append("")
        lines.append("  Create a spare pool with:")
        lines.append("    xicli pool create -n <name> -d <drive1> [drive2...]")
        lines.append("")
        return "\n".join(lines)

    for name, pool in pools.items():
        if not isinstance(pool, dict):
            continue
        devices = pool.get("devices", [])
        serials = pool.get("serials", [])
        sizes = pool.get("sizes", [])
        state = pool.get("state", "unknown")

        lines.append(bs("-"))
        lines.append(bl(f" Pool: {name.upper()}"))
        lines.append(bs())
        lines.append(bl(f"  State:    {state}"))
        lines.append(bl(f"  Devices:  {len(devices)}"))
        lines.append(bs())
        if devices:
            lines.append(bl(f"  {'Device':<22}{'Size':<16}Serial"))
            lines.append(bs())
            for i, dev in enumerate(devices):
                dev_path = (dev[1] if isinstance(dev, list) and len(dev) > 1
                            else str(dev)).replace("/dev/", "")
                sz = sizes[i] if i < len(sizes) else "N/A"
                serial = str(serials[i])[:16] if i < len(serials) and serials[i] else "N/A"
                lines.append(bl(f"  {dev_path:<22}{sz:<16}{serial}"))
        lines.append(bl())
        lines.append(bs("-"))
        lines.append("")

    lines.append(f"  Total: {len(pools)} pool(s)")
    lines.append(bs("="))
    return "\n".join(lines)
