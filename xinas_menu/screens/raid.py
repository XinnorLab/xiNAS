"""RAIDScreen — Quick Overview, Extended Details, Spare Pools, CRUD.

S8 T13 (ADR-0010, s8-clients-spec §6): array list/create/modify/delete
ride the control-path API (``/api/v1/arrays`` + ``/disks`` for the
picker), and the composite delete teardown is a stop-on-failure SEQUENCE
of API operations (shares delete → filesystem unmount + unmanage →
arrays delete with the dangerous consent). Spare-pool lookups ride
GET /api/v1/pools (S9 T11, ADR-0011 — the gRPC ``pool_show`` path is
retired); the chosen pool's drives map onto the API spec's
``spare_disk_ids``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.api.control_client import ControlClient, ControlPathError
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_ARRAY_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]
_STRIP_SIZES = ["16", "32", "64", "128", "256"]
_CPU_LIST_RE = re.compile(r"^\d+(-\d+)?(,\d+(-\d+)?)*$")
# Live-modify surface = the ADR-0006 writability matrix: spare_disk_ids
# (the "sparepool" entry) + tuning.* keys. resync_enabled is create-only
# (xiRAID RaidModify has no such field) and is no longer offered here.
_MODIFY_PARAMS = [
    # (key, label, kind, options, value_type)
    ("cpu_allowed", "CPU Affinity", "cpu_affinity", None, str),
    ("sparepool", "Spare Pool", "input", None, str),
    ("init_prio", "Init Priority (0-100)", "input", None, int),
    ("recon_prio", "Recon Priority (0-100)", "input", None, int),
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
    MenuItem("3", "Spare Pools"),
    MenuItem("", "", separator=True),
    MenuItem("4", "Create Array"),
    MenuItem("5", "Edit Array"),
    MenuItem("6", "Delete Array"),
    MenuItem("0", "Back"),
]


def _fmt_size(size_bytes: float) -> str:
    """Format byte count into human-readable string."""
    if size_bytes <= 0:
        return "N/A"
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != "B" else f"{size_bytes} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} EB"


def _numa_node(name: str) -> int:
    """NUMA node for a block device (sysfs; NVMe falls back to the controller)."""
    try:
        numa_path = Path(f"/sys/class/block/{name}/device/numa_node")
        if numa_path.is_file():
            return max(0, int(numa_path.read_text().strip()))
        if name.startswith("nvme"):
            ctrl = name.split("n")[0]
            ctrl_path = Path(f"/sys/class/nvme/{ctrl}/device/numa_node")
            if ctrl_path.is_file():
                return max(0, int(ctrl_path.read_text().strip()))
    except (OSError, ValueError):
        _log.debug("NUMA lookup failed for %s", name, exc_info=True)
    return 0


async def _list_api_disks(control: ControlClient) -> list[dict[str, Any]]:
    """GET /api/v1/disks adapted to the legacy drive-picker dict shape.

    API Disk rows are ``{id, status: {name, device_path, model?, serial?,
    transport?, capacity_bytes?, system_disk, mounted, safe_for_use}}``.
    The adapter adds ``claimed`` (member/spare of any observed array, from
    GET /api/v1/arrays) and a sysfs NUMA node (the API rows carry none).
    """
    disks = await asyncio.to_thread(control.result, "/api/v1/disks")
    try:
        arrays = await asyncio.to_thread(control.result, "/api/v1/arrays")
    except ControlPathError:
        arrays = []
    claimed: set[str] = set()
    for doc in arrays if isinstance(arrays, list) else []:
        spec = doc.get("spec") if isinstance(doc, dict) else None
        if not isinstance(spec, dict):
            continue
        for field in ("member_disk_ids", "spare_disk_ids"):
            for did in spec.get(field) or []:
                claimed.add(str(did))
    rows: list[dict[str, Any]] = []
    for doc in disks if isinstance(disks, list) else []:
        if not isinstance(doc, dict):
            continue
        status = doc.get("status")
        status = status if isinstance(status, dict) else {}
        disk_id = str(doc.get("id") or status.get("name") or "")
        name = str(status.get("name") or disk_id)
        if not name:
            continue
        size = status.get("capacity_bytes") or 0
        rows.append(
            {
                "id": disk_id or name,
                "name": name,
                "device_path": str(status.get("device_path") or f"/dev/{name}"),
                "size_bytes": size,
                "size_raw": size,
                "model": str(status.get("model") or "").strip(),
                "serial": str(status.get("serial") or "").strip(),
                "transport": str(status.get("transport") or ""),
                "numa_node": _numa_node(name),
                "system": status.get("system_disk") is True,
                "safe_for_use": status.get("safe_for_use") is True,
                "claimed": (disk_id or name) in claimed,
            }
        )
    return rows


def _drive_groups(
    rows: list[dict[str, Any]],
) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    """Group pickable NVMe drives by NUMA node + size category.

    Pickable = ``safe_for_use``, never the system disk, and not already a
    member/spare of an observed array (those would only come back as
    ``disk_in_use`` plan blockers).
    """
    SMALL_THRESHOLD = 1_000_000_000  # 1 GB
    nvme = [
        d
        for d in rows
        if "nvme" in d.get("name", "").lower()
        and d.get("safe_for_use")
        and not d.get("system")
        and not d.get("claimed")
    ]
    if not nvme:
        return {}, nvme
    groups: dict[str, list[str]] = {}
    for d in nvme:
        numa = d.get("numa_node", 0)
        size_bytes = d.get("size_bytes") or 0
        size_cat = "small" if size_bytes < SMALL_THRESHOLD else "large"
        groups.setdefault(f"All {size_cat} NVMe, NUMA {numa}", []).append(d["name"])
    all_large = [d["name"] for d in nvme if (d.get("size_bytes") or 0) >= SMALL_THRESHOLD]
    all_small = [d["name"] for d in nvme if (d.get("size_bytes") or 0) < SMALL_THRESHOLD]
    if all_large:
        groups[f"All large NVMe ({len(all_large)} drives)"] = all_large
    if all_small:
        groups[f"All small NVMe ({len(all_small)} drives)"] = all_small
    return groups, nvme


async def _get_numa_topology(control: ControlClient) -> list[dict]:
    """Return NUMA topology: [{node: 0, cpulist: '0-15', drives: ['nvme0',...]}, ...]."""
    nodes: list[dict] = []
    node_base = Path("/sys/devices/system/node")
    if not node_base.is_dir():
        return nodes

    # Discover NUMA nodes and their CPU lists
    node_dirs = sorted(
        (d for d in node_base.iterdir() if d.name.startswith("node") and d.name[4:].isdigit()),
        key=lambda d: int(d.name[4:]),
    )
    for nd in node_dirs:
        node_id = int(nd.name[4:])
        cpulist_file = nd / "cpulist"
        cpulist = cpulist_file.read_text().strip() if cpulist_file.is_file() else ""
        nodes.append({"node": node_id, "cpulist": cpulist, "drives": []})

    # Map NVMe drives to NUMA nodes (API disk listing + sysfs NUMA)
    try:
        rows = await _list_api_disks(control)
    except ControlPathError:
        rows = []
    for d in rows:
        name = d.get("name", "")
        if "nvme" not in name.lower():
            continue
        numa = d.get("numa_node", 0)
        for n in nodes:
            if n["node"] == numa:
                n["drives"].append(name)
                break

    return nodes


def _pools_by_name(data: Any) -> dict[str, dict]:
    """Normalise a GET /api/v1/pools payload to {name: pool_dict}."""
    if isinstance(data, dict):
        return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    if isinstance(data, list):
        return {str(p.get("name")): p for p in data if isinstance(p, dict) and p.get("name")}
    return {}


def _pool_drive_paths(pool: dict) -> list[str]:
    """Device paths of a spare pool's drives (API rows carry ``drives``;
    tolerant of the legacy ``devices`` pair shape)."""
    raw = pool.get("devices") or pool.get("drives") or []
    paths: list[str] = []
    for dev in raw if isinstance(raw, list) else []:
        path = dev[1] if isinstance(dev, list) and len(dev) > 1 else str(dev)
        if path:
            paths.append(str(path))
    return paths


def _is_under(path: str, root: str) -> bool:
    """True when ``path`` is at or under ``root`` (path-segment aware)."""
    if path == root:
        return True
    prefix = root if root.endswith("/") else root + "/"
    return path.startswith(prefix)


def _level_label(level: Any) -> str:
    """API level ('raid5' / 'n+m') → display label ('5' / 'n+m')."""
    text = str(level or "?")
    return text[4:] if text.startswith("raid") and len(text) > 4 else text


def _arrays_from_api(rows: Any) -> dict[str, dict]:
    """Adapt GET /api/v1/arrays docs to the legacy renderer dict shape.

    API rows are ``{id, spec: {name, level, member_disk_ids,
    spare_disk_ids, strip_size_kib, block_size, group_size}, status:
    {state, volume_path, rebuild_progress_pct, usable_capacity_bytes,
    member_states, ...}}``. Per-member states and the tuning surface are
    not observed via the API — the renderer shows placeholders for those.
    """
    arrays: dict[str, dict] = {}
    for doc in rows if isinstance(rows, list) else []:
        if not isinstance(doc, dict):
            continue
        spec = doc.get("spec")
        spec = spec if isinstance(spec, dict) else {}
        status = doc.get("status")
        status = status if isinstance(status, dict) else {}
        name = str(doc.get("id") or spec.get("name") or "")
        if not name:
            continue
        members = [str(m) for m in spec.get("member_disk_ids") or []]
        spares = [str(s) for s in spec.get("spare_disk_ids") or []]
        cap = status.get("usable_capacity_bytes")
        arrays[name] = {
            "name": name,
            "level": _level_label(spec.get("level")),
            "size": _fmt_size(cap) if isinstance(cap, int | float) else "N/A",
            "state": [str(status.get("state") or "unknown")],
            # member states are not observed via the API → unknown
            "devices": [[i, m, []] for i, m in enumerate(members)],
            "strip_size": spec.get("strip_size_kib", "?"),
            "sparepool": ", ".join(spares) if spares else "-",
            "block_size": spec.get("block_size", 4096),
            "init_progress": status.get("rebuild_progress_pct"),
            "volume_path": str(status.get("volume_path") or f"/dev/xi_{name}"),
            "member_disk_ids": members,
            "spare_disk_ids": spares,
        }
    return arrays


class RAIDScreen(XiNASAppMixin, Screen):
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
                "  \033[1m3\033[0m  \033[36mSpare Pools\033[0m       \033[2mManage spare drive pools\033[0m\n"
                "  \033[1m4\033[0m  \033[36mCreate Array\033[0m      \033[2mCreate a new RAID array (wizard)\033[0m\n"
                "  \033[1m5\033[0m  \033[36mEdit Array\033[0m      \033[2mChange array parameters\033[0m\n"
                "  \033[1m6\033[0m  \033[36mDelete Array\033[0m      \033[2mDestroy an existing array\033[0m\n",
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
            from xinas_menu.screens.spare_pools import SparePoolScreen

            self.app.push_screen(SparePoolScreen())
        elif key == "4":
            self._create_array_wizard()
        elif key == "5":
            self._modify_array()
        elif key == "6":
            self._delete_array()

    def _task_progress(self, label: str):
        """Build an ``on_progress`` callback for ``plan_apply_wait``.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before raising the toast.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    @work(exclusive=True)
    async def _show_quick(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays…")
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(_format_raid_overview(_arrays_from_api(rows), extended=False))

    @work(exclusive=True)
    async def _show_extended(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays (extended)…")
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(_format_raid_overview(_arrays_from_api(rows), extended=True))

    @work(exclusive=True)
    async def _show_pools(self) -> None:
        # Lazy import: spare_pools imports this module at load time for
        # _list_api_disks, so the renderer is pulled in lazily here.
        from xinas_menu.screens.spare_pools import _format_spare_pools

        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading spare pools…")
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
        except ControlPathError as exc:
            view.set_content(f"Could not load pool info: {exc}")
            return
        view.set_content(_format_spare_pools(rows))

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
            SelectDialog(_RAID_LEVELS, title="Create Array — Step 2", prompt="Select RAID level:")
        )
        if not level:
            return

        # Step 3: Select drives (grouped by NUMA/size; API disk listing)
        try:
            disk_rows = await _list_api_disks(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Could not list disks.\n{exc}", "Error"))
            return
        groups, nvme = _drive_groups(disk_rows)
        if not nvme:
            await self.app.push_screen_wait(
                ConfirmDialog("No available NVMe drives found.", "Error")
            )
            return

        choices = list(groups.keys()) + ["Pick individual drives"]
        group_choice = await self.app.push_screen_wait(
            SelectDialog(choices, title="Create Array — Step 3", prompt="Select drive group:")
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
            group_drive_info: list[dict[str, Any]] = [
                d for d in nvme if d.get("name") in group_names
            ]
            if not group_drive_info:
                # Fallback: bare name strings, not the dict shape DrivePicker
                # expects. Unreachable in practice (groups are built from
                # nvme), kept as-is for behavior parity.
                group_drive_info = group_drives  # pyright: ignore[reportAssignmentType]
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
            await self.app.push_screen_wait(ConfirmDialog("No drives selected.", "Error"))
            return

        # Step 4: Strip size
        strip = await self.app.push_screen_wait(
            SelectDialog(
                _STRIP_SIZES, title="Create Array — Step 4", prompt="Strip size (KB), default 64:"
            )
        )
        if not strip:
            strip = "64"

        # The picker returns drive NAMES; the API spec references Disk ids.
        name_to_id = {d["name"]: d["id"] for d in nvme}
        spec: dict[str, Any] = {
            "name": name,
            "level": f"raid{level}",
            "member_disk_ids": [name_to_id.get(n, n) for n in drives],
            "strip_size_kib": int(strip),
        }

        # Step 5: Group size (mandatory for RAID 50/60)
        if level in ("50", "60"):
            while True:
                group_size = await self.app.push_screen_wait(
                    InputDialog(
                        "Group size (required for RAID 50/60):",
                        "Create Array — Step 5",
                        placeholder="4",
                    )
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
                spec["group_size"] = gs
                break

        # Step 6: Spare pool (optional) — pick from existing pools (GET
        # /api/v1/pools, S9 T11); the pool's drives become the API
        # spec's spare_disk_ids (the executor provisions xnsp_<name>).
        _NONE_POOL = "(none)"
        spare_pool_label = ""
        try:
            p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
        except ControlPathError:
            p_rows = []
        pools = _pools_by_name(p_rows)
        if pools:
            pool_choices = [_NONE_POOL] + sorted(pools.keys())
            sparepool = await self.app.push_screen_wait(
                SelectDialog(
                    pool_choices,
                    title="Create Array — Spare Pool",
                    prompt="Select spare pool (or none):",
                )
            )
            if sparepool is None:
                return
            if sparepool != _NONE_POOL:
                path_to_id = {d["device_path"]: d["id"] for d in disk_rows}
                spare_ids = [
                    path_to_id.get(p, p.rsplit("/", 1)[-1])
                    for p in _pool_drive_paths(pools.get(sparepool, {}))
                ]
                if spare_ids:
                    spec["spare_disk_ids"] = spare_ids
                    spare_pool_label = f"{sparepool} ({len(spare_ids)} drive(s))"
                else:
                    self.app.notify(
                        f"Pool '{sparepool}' has no drives — skipping spare assignment.",
                        severity="warning",
                    )
        # If no pools exist, skip silently (no spare pool assigned)

        # Confirm
        summary = (
            f"Name:       {name}\n"
            f"Level:      RAID-{level}\n"
            f"Drives:     {', '.join(drives)}\n"
            f"Strip Size: {strip} KB"
        )
        if "group_size" in spec:
            summary += f"\nGroup Size: {spec['group_size']}"
        if spare_pool_label:
            summary += f"\nSpare Pool: {spare_pool_label}"

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Create this RAID array?\n\n{summary}", "Confirm Create")
        )
        if not confirmed:
            return

        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/arrays",
                spec,
                on_progress=self._task_progress("Create Array"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Create failed.\n{exc}", "Error"))
            return
        self.app.audit.log("raid.create", f"{name} RAID-{level} ({len(drives)} drives)", "OK")
        await self.app.snapshots.record(
            "raid_create",
            diff_summary=f"Created RAID-{level} array '{name}' with {len(drives)} drives",
        )
        self._show_quick()

    # ── Edit Array ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _modify_array(self) -> None:
        """Pick array -> pick parameter -> enter value -> confirm -> PATCH."""
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"No arrays available.\n{exc}", "Edit Array")
            )
            return

        arrays = _arrays_from_api(rows)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Edit Array")
            )
            return

        arr_name = await self.app.push_screen_wait(
            SelectDialog(names, title="Edit Array", prompt="Select array to edit:")
        )
        if not arr_name:
            return

        param_labels = [f"{label} ({key})" for key, label, _, _, _ in _MODIFY_PARAMS]
        param_choice = await self.app.push_screen_wait(
            SelectDialog(
                param_labels,
                title="Edit Array — Parameter",
                prompt=f"Select parameter for {arr_name}:",
            )
        )
        if not param_choice:
            return

        # Find the selected parameter
        idx = param_labels.index(param_choice)
        key, label, kind, options, vtype = _MODIFY_PARAMS[idx]

        spare_ids: list[str] = []
        if key == "cpu_allowed":
            # Smart CPU affinity selector (tuning is not observed via the
            # API, so the current value is unknown → "all").
            current_cpu = arrays[arr_name].get("cpu_allowed") or "all"
            mode = await self.app.push_screen_wait(
                SelectDialog(
                    ["NUMA Node", "Manual CPU List", "All CPUs (reset)"],
                    title="CPU Affinity",
                    prompt=f"Current: {current_cpu}\nSelect affinity mode:",
                )
            )
            if not mode:
                return

            if mode == "All CPUs (reset)":
                value = ""
            elif mode == "NUMA Node":
                topo = await _get_numa_topology(self.app.control)
                if not topo:
                    self.app.notify("Cannot detect NUMA topology.", severity="warning")
                    return
                node_labels = []
                node_cpulists = []
                for n in topo:
                    drives_str = ", ".join(n["drives"]) if n["drives"] else "no drives"
                    node_labels.append(f"NUMA {n['node']}  (CPUs {n['cpulist']})  — {drives_str}")
                    node_cpulists.append(n["cpulist"])
                pick = await self.app.push_screen_wait(
                    SelectDialog(
                        node_labels,
                        title="Select NUMA Node",
                        prompt="Pin array to CPUs of selected NUMA node:",
                    )
                )
                if not pick:
                    return
                value = node_cpulists[node_labels.index(pick)]
            else:
                # Manual CPU list
                raw = await self.app.push_screen_wait(
                    InputDialog(
                        "CPU list (e.g. 0,2,4-7):",
                        "Manual CPU Affinity",
                        default=current_cpu if current_cpu != "all" else "",
                    )
                )
                if raw is None:
                    return
                raw = raw.strip()
                if not _CPU_LIST_RE.match(raw):
                    await self.app.push_screen_wait(
                        ConfirmDialog(
                            f"Invalid CPU list format: '{raw}'\n"
                            "Expected: comma-separated numbers or ranges (e.g. 0,2,4-7)",
                            "Error",
                        )
                    )
                    return
                value = raw

        elif key == "sparepool":
            # Dynamic select: fetch available spare pools (GET /api/v1/pools,
            # S9 T11); the chosen pool's drives map onto the PATCH spec's
            # spare_disk_ids.
            try:
                p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
            except ControlPathError:
                p_rows = []
            pools = _pools_by_name(p_rows)
            if not pools:
                self.app.notify("No spare pools available.", severity="warning")
                return
            value = await self.app.push_screen_wait(
                SelectDialog(
                    sorted(pools.keys()),
                    title=f"Set {label}",
                    prompt=f"Select spare pool for {arr_name}:",
                )
            )
            if value:
                try:
                    disk_rows = await _list_api_disks(self.app.control)
                except ControlPathError:
                    disk_rows = []
                path_to_id = {d["device_path"]: d["id"] for d in disk_rows}
                spare_ids = [
                    path_to_id.get(p, p.rsplit("/", 1)[-1])
                    for p in _pool_drive_paths(pools.get(value, {}))
                ]
                if not spare_ids:
                    self.app.notify(f"Pool '{value}' has no drives.", severity="warning")
                    return
        elif kind == "select" and options:
            value = await self.app.push_screen_wait(
                SelectDialog(options, title=f"Set {label}", prompt=f"New value for {label}:")
            )
        else:
            value = await self.app.push_screen_wait(
                InputDialog(f"New value for {label}:", f"Set {label}")
            )

        if value is None:
            return

        display_val = value if value else "all (unrestricted)"
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Edit {arr_name}?\n\n{label}: {display_val}",
                "Confirm Edit",
            )
        )
        if not confirmed:
            return

        # Map the wizard value onto the PATCH spec (ADR-0006 writable
        # subset: spare_disk_ids | tuning.*).
        patch_spec: dict[str, Any]
        if key == "sparepool":
            patch_spec = {"spare_disk_ids": spare_ids}
        elif key == "cpu_allowed":
            patch_spec = {"tuning": {"cpu_allowed": value}}
        elif kind == "select" and options:
            patch_spec = {"tuning": {key: value == "true"}}
        else:
            # Input widgets return strings — convert to the expected type.
            try:
                patch_spec = {"tuning": {key: vtype(value)}}
            except (ValueError, TypeError):
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Invalid value: expected {vtype.__name__}", "Error")
                )
                return

        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/arrays/{arr_name}",
                patch_spec,
                on_progress=self._task_progress(f"Edit {arr_name}"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Edit failed.\n{exc}", "Error"))
            return
        self.app.audit.log("raid.modify", f"{arr_name} {key}={value}", "OK")
        await self.app.snapshots.record(
            "raid_modify",
            diff_summary=f"Modified array '{arr_name}': {key}={value}",
        )
        self._show_quick()

    # ── Delete Array ─────────────────────────────────────────────────────────

    def _teardown_append(self, lines: list[str], line: str) -> None:
        """Append a step line to the teardown progress view."""
        lines.append(line)
        self.query_one("#raid-content", ScrollableTextView).set_content("\n".join(lines))

    def _teardown_progress(self, lines: list[str]):
        """``on_progress`` callback rendering task states as step lines.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before touching the view.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self._teardown_append, lines, f"      task {state}")

        return _cb

    async def _teardown_failed(self, lines: list[str], step: str, exc: Exception) -> None:
        """Render a stop-on-failure halt (s8-clients-spec §6: no cross-step
        rollback — each step's task carries its own rollback)."""
        self._teardown_append(lines, f"  FAILED: {exc}")
        self._teardown_append(lines, "  Teardown stopped — remaining steps were not run.")
        await self.app.push_screen_wait(
            ConfirmDialog(
                f"{step}:\n{exc}\n\n"
                "Teardown stopped at this step. No cross-step rollback; the "
                "failed task rolled itself back where supported.",
                "Delete Array — Stopped",
            )
        )

    @work(exclusive=True)
    async def _delete_array(self) -> None:
        """Pick array -> check dependencies -> ordered teardown -> destroy.

        s8-clients-spec §6: the teardown is a stop-on-failure SEQUENCE of
        control-path API operations — shares delete → filesystem unmount +
        unmanage → arrays delete (the confirm dialog is the dangerous
        consent). A step failure STOPS the sequence with the task/plan
        error surfaced; there is no cross-step rollback.
        """
        from xinas_menu.utils.xfs_helpers import find_mounts_using_raid

        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"No arrays available.\n{exc}", "Delete Array")
            )
            return

        arrays = _arrays_from_api(rows)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Delete Array")
            )
            return

        arr_name = await self.app.push_screen_wait(
            SelectDialog(names, title="Delete Array", prompt="Select array to delete:")
        )
        if not arr_name:
            return

        arr = arrays.get(arr_name, {})
        level = arr.get("level", "?")
        size = arr.get("size", "N/A")
        devs = arr.get("member_disk_ids", [])
        volume_path = arr.get("volume_path", f"/dev/xi_{arr_name}")

        # ── Affected mounts: local findmnt read (kept from the legacy
        # flow — it also catches log-device usage the API does not model
        # as backing_device) ──────────────────────────────────────────────
        mounts = await find_mounts_using_raid(arr_name)
        mountpoints = {m["mountpoint"] for m in mounts if m.get("mountpoint")}

        # ── Affected shares: GET /shares filtered to paths under those
        # mountpoints ─────────────────────────────────────────────────────
        affected_shares: list[dict] = []  # [{id, path}]
        if mountpoints:
            try:
                share_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/shares")
            except ControlPathError:
                share_rows = []
            for doc in share_rows if isinstance(share_rows, list) else []:
                if not isinstance(doc, dict):
                    continue
                doc_spec = doc.get("spec")
                path = doc_spec.get("path") if isinstance(doc_spec, dict) else None
                sid = doc.get("id")
                if not path or sid is None:
                    continue
                if any(_is_under(str(path), mp) for mp in mountpoints):
                    affected_shares.append({"id": str(sid), "path": str(path)})

        # ── Affected filesystems (mount units): backed by the array's
        # volume, or mounted on one of the affected mountpoints ──────────
        affected_fs: list[dict] = []  # [{id, mountpoint, mounted}]
        try:
            fs_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/filesystems")
        except ControlPathError:
            fs_rows = []
        for doc in fs_rows if isinstance(fs_rows, list) else []:
            if not isinstance(doc, dict):
                continue
            status = doc.get("status")
            status = status if isinstance(status, dict) else {}
            fid = doc.get("id")
            if fid is None:
                continue
            mp = str(status.get("mountpoint") or "")
            if status.get("backing_device") == volume_path or (mp and mp in mountpoints):
                affected_fs.append(
                    {"id": str(fid), "mountpoint": mp, "mounted": status.get("mounted") is True}
                )

        # ── Build warning message with dependency info ───────────────────
        warning_parts = [
            f"RAID-{level}  |  {size}  |  {len(devs)} drive(s)\n",
        ]

        if affected_shares:
            share_list = "\n".join(f"  - {s['path']}" for s in affected_shares)
            warning_parts.append(f"ACTIVE NFS SHARES will be removed:\n{share_list}\n")

        if affected_fs or mounts:
            fs_lines = [f"  - {f['mountpoint'] or f['id']} ({f['id']})" for f in affected_fs]
            for m in mounts:
                mp = m.get("mountpoint", "")
                if mp and not any(f["mountpoint"] == mp for f in affected_fs):
                    fs_lines.append(
                        f"  - {mp} ({m.get('role', 'unknown')} device — not API-managed)"
                    )
            warning_parts.append(
                "ACTIVE FILESYSTEMS will be unmounted/unmanaged:\n" + "\n".join(fs_lines) + "\n"
            )

        warning_parts.append(
            f"WARNING: This will DESTROY array '{arr_name}' and all data on it!\n"
            f"This action cannot be undone."
        )

        # ── First confirmation (this consent carries dangerous=True) ─────
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("\n".join(warning_parts), f"Delete {arr_name}?")
        )
        if not confirmed:
            return

        # ── Double confirmation when dependencies exist ──────────────────
        if mounts or affected_fs or affected_shares:
            confirmed2 = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Are you ABSOLUTELY sure?\n\n"
                    f"This will remove {len(affected_shares)} NFS share(s) "
                    f"and {len(affected_fs) or len(mounts)} filesystem(s) before destroying "
                    f"array '{arr_name}'.\n\n"
                    f"ALL DATA WILL BE LOST.",
                    "FINAL CONFIRMATION",
                )
            )
            if not confirmed2:
                return

        lines: list[str] = []
        self._teardown_append(lines, f"Teardown sequence for array '{arr_name}':")
        progress = self._teardown_progress(lines)

        # ── Step 1: Remove NFS shares (API delete; stop on failure) ──────
        removed_shares = 0
        for share in affected_shares:
            path = share["path"]
            self._teardown_append(lines, f"  Removing NFS share: {path} ...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "DELETE",
                    f"/api/v1/shares/{share['id']}",
                    {},
                    on_progress=progress,
                )
            except ControlPathError as exc:
                await self._teardown_failed(lines, f"Failed to remove NFS share '{path}'", exc)
                return
            removed_shares += 1
            self.app.audit.log("nfs.remove", f"share={path} (RAID teardown)", "OK")

        # ── Step 2: Unmount + unmanage filesystems ───────────────────────
        removed_fs = 0
        for fs in affected_fs:
            fid = fs["id"]
            mp = fs["mountpoint"] or fid
            if fs["mounted"]:
                self._teardown_append(lines, f"  Unmounting filesystem: {mp} ...")
                try:
                    await asyncio.to_thread(
                        self.app.control.plan_apply_wait,
                        "PATCH",
                        f"/api/v1/filesystems/{fid}",
                        {"mounted": False},
                        on_progress=progress,
                    )
                except ControlPathError as exc:
                    await self._teardown_failed(lines, f"Failed to unmount '{mp}'", exc)
                    return
                self.app.audit.log("fs.unmount", f"mountpoint={mp} (RAID teardown)", "OK")
            self._teardown_append(lines, f"  Removing mount unit: {fid} ...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "DELETE",
                    f"/api/v1/filesystems/{fid}",
                    {},
                    on_progress=progress,
                )
            except ControlPathError as exc:
                await self._teardown_failed(lines, f"Failed to unmanage '{fid}'", exc)
                return
            removed_fs += 1
            self.app.audit.log("fs.unmanage", f"unit={fid} (RAID teardown)", "OK")

        # ── Step 3: Destroy the array (dangerous consent given above) ────
        self._teardown_append(lines, f"  Destroying RAID array: {arr_name} ...")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "DELETE",
                f"/api/v1/arrays/{arr_name}",
                {},
                dangerous=True,
                on_progress=progress,
            )
        except ControlPathError as exc:
            await self._teardown_failed(lines, f"RAID destroy failed for '{arr_name}'", exc)
            return

        self.app.audit.log("raid.destroy", arr_name, "OK")
        await self.app.snapshots.record(
            "raid_delete",
            diff_summary=f"Deleted array '{arr_name}' "
            f"({removed_shares} share(s), {removed_fs} filesystem(s) removed)",
        )
        GRN, BLD, NC = "\033[32m", "\033[1m", "\033[0m"
        self._teardown_append(lines, "")
        self._teardown_append(lines, f"{BLD}{GRN}Array '{arr_name}' deleted successfully.{NC}")
        if removed_shares:
            self._teardown_append(lines, f"  Removed {removed_shares} NFS share(s)")
        if removed_fs:
            self._teardown_append(lines, f"  Removed {removed_fs} filesystem unit(s)")
        self.app.notify(f"Array '{arr_name}' deleted.", severity="information")


# ── Formatters ────────────────────────────────────────────────────────────────

_W = 70  # inner box width (between borders)

# ANSI color codes for RAID display
_GRN, _YLW, _RED, _CYN, _BLD, _DIM, _NC = (
    "\033[32m",
    "\033[33m",
    "\033[31m",
    "\033[36m",
    "\033[1m",
    "\033[2m",
    "\033[0m",
)
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


_HEALTHY_STATES = ("online", "initialized", "optimal")


def _state_icon(state: str) -> str:
    s = state.lower()
    if s in _HEALTHY_STATES:
        return f"{_GRN}*{_NC}"
    if s in ("initing", "rebuilding", "importing"):
        return f"{_YLW}~{_NC}"
    if s == "degraded":
        return f"{_YLW}!{_NC}"
    if s in ("offline", "failed"):
        return f"{_RED}x{_NC}"
    return "o"


def _state_color(state: str) -> str:
    s = state.lower()
    if s in _HEALTHY_STATES:
        return _GRN
    if s in ("initing", "rebuilding", "importing", "degraded"):
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


def _count_states(devices: list) -> tuple[int, int, int, int]:
    """Per-member (online, degraded, offline, unknown) counts."""
    online = degraded = offline = unknown = 0
    for dev in devices:
        raw = dev[2][0] if (isinstance(dev, list) and len(dev) > 2 and dev[2]) else "unknown"
        s = (raw or "unknown").lower()
        if s in ("online", "optimal"):
            online += 1
        elif s in ("degraded", "rebuilding"):
            degraded += 1
        elif s == "unknown":
            unknown += 1
        else:
            offline += 1
    return online, degraded, offline, unknown


# ── Quick / Extended overview ──────────────────────────────────────────────────


def _format_raid_overview(arrays: dict, extended: bool = False) -> str:
    lines: list[str] = []

    title = "RAID ARRAYS — EXTENDED" if extended else "RAID ARRAYS — QUICK OVERVIEW"
    lines.append(_box_sep("="))
    pad = (_W - len(title)) // 2
    lines.append(
        f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}{title}{_NC}{' ' * (_W - pad - len(title) + 1)}{_DIM}|{_NC}"
    )
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

        online, degraded, offline, _unknown = _count_states(devices)
        total = len(devices)
        state_str = _format_state(state)
        is_initing = any((s or "").lower() in ("initing", "rebuilding") for s in (state or []))

        # Per-member states are not always observed (the API rows carry
        # none) — show only the buckets that are.
        dev_parts = [f"{total} total"]
        if online:
            dev_parts.append(f"{_GRN}{online} online{_NC}")
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
            lines.append(
                _box_line(f"  {_YLW}~ Initializing: {_progress_bar(int(init_progress))}{_NC}")
            )

        if extended:

            def _on_off(v):
                return f"{_GRN}Enabled{_NC}" if v else f"{_DIM}Disabled{_NC}"

            # ── Priorities ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}PRIORITIES{_NC}"))
            lines.append(_box_sep())
            init_p = arr.get("init_prio", "-")
            recon_p = arr.get("recon_prio", "-")
            restripe_p = arr.get("restripe_prio", "-")
            lines.append(_box_line(f"  {_DIM}Init Priority{_NC}       |  {init_p}%"))
            lines.append(_box_line(f"  {_DIM}Recon Priority{_NC}      |  {recon_p}%"))
            lines.append(_box_line(f"  {_DIM}Restripe Priority{_NC}   |  {restripe_p}%"))

            # ── Performance ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}PERFORMANCE{_NC}"))
            lines.append(_box_sep())
            mem_limit = arr.get("memory_limit", 0)
            mem_prealloc = arr.get("memory_prealloc", 0)
            req_limit = arr.get("request_limit", 0)
            cpu = arr.get("cpu_allowed") or "all"
            lines.append(_box_line(f"  {_DIM}Memory Usage{_NC}        |  {memory_mb} MB"))
            lines.append(
                _box_line(
                    f"  {_DIM}Memory Limit{_NC}        |  {'unlimited' if not mem_limit else f'{mem_limit} MB'}"
                )
            )
            lines.append(
                _box_line(
                    f"  {_DIM}Memory Pre-alloc{_NC}    |  {'disabled' if not mem_prealloc else f'{mem_prealloc} MB'}"
                )
            )
            lines.append(_box_line(f"  {_DIM}Block Size{_NC}          |  {block_size} bytes"))
            lines.append(
                _box_line(
                    f"  {_DIM}Request Limit{_NC}       |  {req_limit if req_limit else 'unlimited'}"
                )
            )
            lines.append(_box_line(f"  {_DIM}CPU Affinity{_NC}        |  {cpu}"))

            # ── I/O Scheduler & Merge ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}I/O SCHEDULER & MERGE{_NC}"))
            lines.append(_box_sep())
            sched = arr.get("sched_enabled", 0)
            resync = arr.get("resync_enabled", 0)
            mr_en = arr.get("merge_read_enabled", 0)
            mw_en = arr.get("merge_write_enabled", 0)
            adapt = arr.get("adaptive_merge", 0)
            lines.append(_box_line(f"  {_DIM}Scheduler{_NC}           |  {_on_off(sched)}"))
            lines.append(_box_line(f"  {_DIM}Resync{_NC}              |  {_on_off(resync)}"))
            lines.append(_box_line(f"  {_DIM}Merge Read{_NC}          |  {_on_off(mr_en)}"))
            lines.append(_box_line(f"  {_DIM}Merge Write{_NC}         |  {_on_off(mw_en)}"))
            lines.append(_box_line(f"  {_DIM}Adaptive Merge{_NC}      |  {_on_off(adapt)}"))
            mr_max = arr.get("merge_read_max")
            mr_wait = arr.get("merge_read_wait")
            mw_max = arr.get("merge_write_max")
            mw_wait = arr.get("merge_write_wait")
            if any(v is not None for v in (mr_max, mr_wait, mw_max, mw_wait)):
                lines.append(_box_line(f"  {_DIM}Merge Read Max{_NC}      |  {mr_max or '-'} us"))
                lines.append(_box_line(f"  {_DIM}Merge Read Wait{_NC}     |  {mr_wait or '-'} us"))
                lines.append(_box_line(f"  {_DIM}Merge Write Max{_NC}     |  {mw_max or '-'} us"))
                lines.append(_box_line(f"  {_DIM}Merge Write Wait{_NC}    |  {mw_wait or '-'} us"))

            # ── Device Health & Wear ──
            health = arr.get("devices_health") or []
            wear = arr.get("devices_wear") or []
            if health or wear:
                lines.append(_box_line())
                lines.append(_box_sep())
                lines.append(_box_line(f" {_BLD}{_CYN}DEVICE HEALTH & WEAR{_NC}"))
                lines.append(_box_sep())
                for i, dev in enumerate(devices):
                    dev_path = (
                        dev[1] if isinstance(dev, list) and len(dev) > 1 else str(dev)
                    ).replace("/dev/", "")
                    dev_state = (
                        dev[2][0] if isinstance(dev, list) and len(dev) > 2 and dev[2] else "?"
                    )
                    h = health[i] if i < len(health) else "N/A"
                    w = wear[i] if i < len(wear) else "N/A"
                    icon = _state_icon(dev_state)
                    sc = _state_color(dev_state)
                    lines.append(
                        _box_line(
                            f"  {icon} {sc}{dev_path:<16}{_NC} {_DIM}Health:{_NC} {h:<8} {_DIM}Wear:{_NC} {w}"
                        )
                    )

        lines.append(_box_line())
        lines.append(_box_sep("-"))
        lines.append("")

    healthy = sum(
        1
        for a in arrays.values()
        if isinstance(a, dict)
        and all((s or "").lower() in _HEALTHY_STATES for s in (a.get("state") or []))
    )
    lines.append(_box_sep("="))
    hc = _GRN if healthy == len(arrays) else _YLW
    lines.append(f"  Summary: {len(arrays)} array(s), {hc}{healthy} healthy{_NC}")
    lines.append(_box_sep("="))
    return "\n".join(lines)


# ── Spare Pools ────────────────────────────────────────────────────────────────
# The pool renderer lives in xinas_menu.screens.spare_pools
# (_format_spare_pools, API row shape) — _show_pools imports it lazily.
