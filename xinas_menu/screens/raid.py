"""RAIDScreen — Quick Overview, Extended Details, Physical Drives, Spare Pools."""
from __future__ import annotations

import os
import re
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Quick Overview"),
    MenuItem("2", "Extended Details"),
    MenuItem("3", "Physical Drives"),
    MenuItem("4", "Spare Pools"),
    MenuItem("0", "Back"),
]


class RAIDScreen(Screen):
    """RAID management — read-only views."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  RAID Management", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="raid-nav")
            yield ScrollableTextView(id="raid-content")
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

    @work(exclusive=True)
    async def _show_quick(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays…")
        ok, data, err = await self.app.grpc.raid_show()
        view.set_content(
            _format_raid_overview(data, extended=False) if ok
            else f"Could not load RAID info: {_grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_extended(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays (extended)…")
        ok, data, err = await self.app.grpc.raid_show(extended=True)
        view.set_content(
            _format_raid_overview(data, extended=True) if ok
            else f"Could not load RAID info: {_grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_drives(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading physical drives…")
        ok, data, err = await self.app.grpc.raid_show(extended=True)
        view.set_content(
            _format_physical_drives(data) if ok
            else f"Could not load drive info: {_grpc_short_error(err)}"
        )

    @work(exclusive=True)
    async def _show_pools(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading spare pools…")
        ok, data, err = await self.app.grpc.pool_show()
        view.set_content(
            _format_spare_pools(data) if ok
            else f"Could not load pool info: {_grpc_short_error(err)}"
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
        pass
    return "N/A"


def _get_numa_node(path: str) -> str:
    try:
        dev_name = os.path.basename(path)
        m = re.match(r"(nvme\d+)", dev_name)
        if m:
            ctrl = m.group(1)
            p = f"/sys/class/nvme/{ctrl}/numa_node"
            if os.path.exists(p):
                node = open(p).read().strip()
                return node if node != "-1" else "-"
        p = f"/sys/block/{dev_name}/device/numa_node"
        if os.path.exists(p):
            node = open(p).read().strip()
            return node if node != "-1" else "-"
    except Exception:
        pass
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


# ── Error helper ───────────────────────────────────────────────────────────────

def _grpc_short_error(err: str) -> str:
    if not err:
        return "not connected"
    if "UNAVAILABLE" in err or "Connection refused" in err or "failed to connect" in err.lower():
        return "xiRAID service unavailable"
    if "UNAUTHENTICATED" in err:
        return "authentication failed"
    if "DEADLINE_EXCEEDED" in err or "Deadline" in err:
        return "timed out"
    if "stubs not available" in err:
        return err
    m = re.search(r'details\s*=\s*["\']([^"\']{1,120})', err)
    if m:
        return m.group(1)
    first = err.splitlines()[0] if err else err
    return first[:100]
