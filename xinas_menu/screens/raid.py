"""RAIDScreen — Quick Overview, Extended Details, Spare Pools, CRUD.

S8 T13 (ADR-0010, s8-clients-spec §6): array list/create/modify/delete
ride the control-path API (``/api/v1/arrays`` + ``/disks`` for the
picker), and the composite delete teardown is a stop-on-failure SEQUENCE
of API operations (shares delete → filesystem unmount + unmanage →
arrays delete with the dangerous consent). Spare-pool lookups ride
GET /api/v1/pools (S9 T11, ADR-0011 — the gRPC ``pool_show`` path is
retired); Edit Array attaches the chosen pool by name via the API
spec's ``spare_pool`` (design 2026-08-29 — sending the pool's member
drives as ``spare_disk_ids`` made the control path build a second,
conflicting pool out of drives the chosen pool already owned).
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

from xinas_menu.api.control_client import (
    ControlClient,
    ControlPathError,
    TaskCancelled,
    quote_id,
)
from xinas_menu.api.degraded import degraded_banner
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.utils import raid_rules
from xinas_menu.utils.xfs_helpers import is_path_under
from xinas_menu.utils.xiraid_names import partition_collision, validate_array_name
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.task_wait_dialog import TaskWaitDialog
from xinas_menu.widgets.text_view import ScrollableTextView
from xinas_menu.widgets.wizard import BACK, CANCEL, WizardStep, run_wizard

# Every xiRAID constraint this screen enforces (array names, per-level drive
# minimums, group_size) lives in xinas_menu.utils.raid_rules, with the vendor
# page and product version cited there. Do not re-derive them here.
_RAID_LEVELS = ["0", "1", "5", "6", "10", "50", "60"]
_STRIP_SIZES = ["16", "32", "64", "128", "256"]
_CPU_LIST_RE = re.compile(r"^\d+(-\d+)?(,\d+(-\d+)?)*$")
# Live-modify surface = the ADR-0006 writability matrix: spare_pool
# (the "sparepool" entry) + tuning.* keys. resync_enabled is create-only
# (xiRAID RaidModify has no such field) and is no longer offered here.
#
# The ranges in the labels are NOT written out here: they come from
# raid_rules.modify_range_hint(), which is the same table
# raid_rules.validate_modify_value() enforces, so a label cannot advertise a
# value the screen then rejects. It used to — "Recon Priority (0-100)" invited
# a 0 that xiRAID's modify surface documents as 1-100.
_MODIFY_PARAMS = [
    # (key, label, kind, options, value_type)
    ("cpu_allowed", "CPU Affinity", "cpu_affinity", None, str),
    ("sparepool", "Spare Pool", "input", None, str),
    (
        "init_prio",
        f"Init Priority ({raid_rules.modify_range_hint('init_prio')})",
        "input",
        None,
        int,
    ),
    (
        "recon_prio",
        f"Recon Priority ({raid_rules.modify_range_hint('recon_prio')})",
        "input",
        None,
        int,
    ),
    ("sched_enabled", "Scheduler Enabled", "select", ["true", "false"], str),
    (
        "memory_limit",
        f"Memory Limit (MB: {raid_rules.modify_range_hint('memory_limit')})",
        "input",
        None,
        int,
    ),
    ("merge_read_enabled", "Merge Read Enabled", "select", ["true", "false"], str),
    ("merge_write_enabled", "Merge Write Enabled", "select", ["true", "false"], str),
    # Merge windows are TIMES: the daemon reports them as merge_*_usecs and
    # the extended view renders them in us — the old "(KB)" labels were wrong.
    (
        "merge_read_max",
        f"Merge Read Max (us: {raid_rules.modify_range_hint('merge_read_max')})",
        "input",
        None,
        int,
    ),
    (
        "merge_write_max",
        f"Merge Write Max (us: {raid_rules.modify_range_hint('merge_write_max')})",
        "input",
        None,
        int,
    ),
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


def _no_drives_message(banner: str | None) -> str:
    """Text for the Create Array wizard's empty-disk abort.

    "No drives" and "the Disk collector could not be read" are different
    facts; when the envelope carried a warning, the dialog has to say which
    one the operator is looking at.
    """
    message = "No available NVMe drives found."
    return f"{message}\n\n{banner}" if banner else message


async def _list_api_disks_with_banner(
    control: ControlClient,
) -> tuple[list[dict[str, Any]], str | None]:
    """GET /api/v1/disks adapted to the legacy drive-picker dict shape.

    Returns ``(rows, banner)``. The banner is the envelope's degraded-backend
    message when the Disk collector could not be read — an empty row list with
    a warning means "nothing was observed", not "there is no hardware", and the
    caller's empty state has to be able to tell those apart.

    API Disk rows are ``{id, status: {name, device_path, model?, serial?,
    transport?, capacity_bytes?, system_disk, mounted, safe_for_use}}``.
    The adapter adds ``claimed`` (member/spare of any observed array, from
    GET /api/v1/arrays) and a sysfs NUMA node (the API rows carry none).
    """
    env = await asyncio.to_thread(control.get, "/api/v1/disks")
    disks = env.get("result")
    banner = degraded_banner(env)
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
    return rows, banner


async def _list_api_disks(control: ControlClient) -> list[dict[str, Any]]:
    """Rows only, for callers that render no empty state of their own."""
    rows, _ = await _list_api_disks_with_banner(control)
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


_NONE_POOL = "(none)"


def _spare_pool_patch(choice: str) -> dict[str, Any]:
    """Edit Array's pool choice -> the PATCH spec. `(none)` detaches."""
    return {"spare_pool": None if choice == _NONE_POOL else choice}


def _spare_prompt(pools: dict[str, dict]) -> str:
    """Create-wizard spare step prompt; names where pools come from when none do."""
    if pools:
        return "Select spare pool (or none):"
    return (
        "No spare pools exist.\nCreate one in Storage > Spare Pools, then attach it via Edit Array."
    )


def _spare_spec_fragment(choice: str) -> dict[str, Any]:
    """Create-wizard pool choice -> the POST spec fragment."""
    return {} if choice == _NONE_POOL else {"spare_pool": choice}


def _level_label(level: Any) -> str:
    """API level ('raid5' / 'n+m') → display label ('5' / 'n+m')."""
    text = str(level or "?")
    return text[4:] if text.startswith("raid") and len(text) > 4 else text


def _arrays_from_api(rows: Any) -> dict[str, dict]:
    """Adapt GET /api/v1/arrays docs to the legacy renderer dict shape.

    API rows are ``{id, spec: {name, level, member_disk_ids,
    spare_disk_ids, strip_size_kib, block_size, group_size, tuning},
    status: {state, volume_path, rebuild_progress_pct,
    usable_capacity_bytes, memory_usage_mb, member_states, ...}}``.

    ``spec.tuning`` is flattened onto the top level so the renderer reads
    one flat dict. A key the API does not carry is left **absent** — the
    renderer must then print a placeholder, never a plausible-looking
    default (raid-management-spec §3.2).

    ``status.member_states`` (S3 spec §5.2) carries per-member observation;
    each entry's ``device`` is in the same control-path ``Disk`` identity as
    ``member_disk_ids``. It is matched **by device id** into the renderer's
    per-member state lists so a degraded/offline member shows in the device
    breakdown. Absent or empty leaves those lists empty and the breakdown
    falls back to a bare total — never a fabricated ``online``.
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
        tuning = spec.get("tuning")
        tuning = tuning if isinstance(tuning, dict) else {}
        # Per-member states, keyed by device id so the order the agent emitted
        # them in does not matter (S3 spec §5.2). Absent/malformed → no entry,
        # and that member's state list stays empty.
        states_by_device: dict[str, list] = {}
        for ms in status.get("member_states") or []:
            if isinstance(ms, dict) and isinstance(ms.get("device"), str):
                st = ms.get("states")
                states_by_device[ms["device"]] = (
                    [str(s) for s in st] if isinstance(st, list) else []
                )
        arrays[name] = {
            "name": name,
            "level": _level_label(spec.get("level")),
            "size": _fmt_size(cap) if isinstance(cap, int | float) else "N/A",
            "state": [str(status.get("state") or "unknown")],
            "devices": [[i, m, states_by_device.get(m, [])] for i, m in enumerate(members)],
            "strip_size": spec.get("strip_size_kib", "?"),
            "sparepool": ", ".join(spares) if spares else "-",
            "block_size": spec.get("block_size"),
            "init_progress": status.get("rebuild_progress_pct"),
            "volume_path": str(status.get("volume_path") or f"/dev/xi_{name}"),
            "member_disk_ids": members,
            "spare_disk_ids": spares,
            "memory_usage_mb": status.get("memory_usage_mb"),
            # Observed runtime state, not a tuning knob: whether the daemon is
            # processing discards, as distinct from spec.tuning.discard (what
            # the array is configured to accept). Absent → None → "unknown".
            "discard_active": status.get("discard_active"),
            # Observed tuning only: a knob the agent did not read stays
            # absent here so the renderer prints "unknown" for it.
            **{k: v for k, v in tuning.items() if v is not None},
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
            env = await asyncio.to_thread(self.app.control.get, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(
            _format_raid_overview(
                _arrays_from_api(env.get("result")), extended=False, banner=degraded_banner(env)
            )
        )

    @work(exclusive=True)
    async def _show_extended(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays (extended)…")
        try:
            env = await asyncio.to_thread(self.app.control.get, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(
            _format_raid_overview(
                _arrays_from_api(env.get("result")), extended=True, banner=degraded_banner(env)
            )
        )

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
        """Create-array wizard with Back navigation."""
        # Fetch disks up front so the drive + spare steps and their applies()
        # predicates have their data; fail fast if there are no NVMe drives.
        try:
            disk_rows, disk_banner = await _list_api_disks_with_banner(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Could not list disks.\n{exc}", "Error", ok_only=True)
            )
            return
        groups, nvme = _drive_groups(disk_rows)
        if not nvme:
            await self.app.push_screen_wait(
                ConfirmDialog(_no_drives_message(disk_banner), "Error", ok_only=True)
            )
            return
        name_to_id = {d["name"]: d["id"] for d in nvme}

        try:
            p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
        except ControlPathError:
            p_rows = []
        pools = _pools_by_name(p_rows)

        # Existing array names feed the partition-identifier collision warning
        # (spec §4). A failed fetch degrades the warning, it does not block the
        # wizard — the hard name rules do not depend on it.
        try:
            a_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError:
            a_rows = []
        existing_names = list(_arrays_from_api(a_rows))

        async def name_step(answers, allow_back, step_no):
            default = answers.get("name", "")
            while True:
                name = await self.app.push_screen_wait(
                    InputDialog(
                        "Array name:",
                        f"Create Array — Step {step_no}",
                        default=default,
                        placeholder="data0",
                        allow_back=allow_back,
                    )
                )
                if name is None:
                    return CANCEL
                if name is BACK:
                    return BACK
                error = validate_array_name(name)
                if error is not None:
                    self.app.notify(error, severity="error")
                    default = name
                    continue
                warning = partition_collision(name, existing_names)
                if warning is not None:
                    proceed = await self.app.push_screen_wait(
                        ConfirmDialog(warning, "Possible Name Collision")
                    )
                    if not proceed:
                        default = name
                        continue
                return name

        async def level_step(answers, allow_back, step_no):
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    _RAID_LEVELS,
                    title=f"Create Array — Step {step_no}",
                    prompt="Select RAID level:",
                    selected=answers.get("level"),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def _member_count_ok(level: str, selected) -> bool:
            """Reject a drive count xiRAID would refuse, before the operator goes on."""
            problem = raid_rules.validate_member_count(level, len(selected))
            if problem is None:
                return True
            await self.app.push_screen_wait(ConfirmDialog(problem, "Error", ok_only=True))
            return False

        async def drives_step(answers, allow_back, step_no):
            level = str(answers.get("level") or "")
            prior = answers.get("drives")
            if prior:
                # Re-entry: jump straight to the picker with the prior selection.
                preselected = prior
                while True:
                    selected = await self.app.push_screen_wait(
                        DrivePickerScreen(
                            nvme,
                            title="Create Array — Select Drives",
                            preselected=preselected,
                            allow_back=allow_back,
                        )
                    )
                    if selected is None:
                        return CANCEL
                    if selected is BACK:
                        return BACK
                    if not selected:
                        await self.app.push_screen_wait(
                            ConfirmDialog("No drives selected.", "Error", ok_only=True)
                        )
                        continue
                    if not await _member_count_ok(level, selected):
                        # keep the operator's picks so they can add to them
                        preselected = selected
                        continue
                    return selected
            while True:
                choices = list(groups.keys()) + ["Pick individual drives"]
                group_choice = await self.app.push_screen_wait(
                    SelectDialog(
                        choices,
                        title=f"Create Array — Step {step_no}",
                        prompt="Select drive group:",
                        allow_back=allow_back,
                    )
                )
                if group_choice is None:
                    return CANCEL
                if group_choice is BACK:
                    return BACK
                if group_choice == "Pick individual drives":
                    selected = await self.app.push_screen_wait(
                        DrivePickerScreen(
                            nvme, title="Create Array — Select Drives", allow_back=True
                        )
                    )
                else:
                    group_drives = groups.get(group_choice, [])
                    group_names = {
                        d if isinstance(d, str) else d.get("name", "") for d in group_drives
                    }
                    group_drive_info: list[dict[str, Any]] = [
                        d for d in nvme if d.get("name") in group_names
                    ] or group_drives  # pyright: ignore[reportAssignmentType]
                    selected = await self.app.push_screen_wait(
                        DrivePickerScreen(
                            group_drive_info,
                            title=f"Review — {group_choice}",
                            preselected=group_names,
                            allow_back=True,
                        )
                    )
                if selected is None:
                    return CANCEL
                if selected is BACK:
                    continue  # back to the group select
                if not selected:
                    await self.app.push_screen_wait(
                        ConfirmDialog("No drives selected.", "Error", ok_only=True)
                    )
                    continue
                if not await _member_count_ok(level, selected):
                    continue
                return selected

        async def strip_step(answers, allow_back, step_no):
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    _STRIP_SIZES,
                    title=f"Create Array — Step {step_no}",
                    prompt="Strip size (KB), default 64:",
                    selected=answers.get("strip", "64"),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def group_size_step(answers, allow_back, step_no):
            # First step where both the level and the drive count are known, so
            # divisibility is checked here rather than in the drives step.
            level = str(answers.get("level") or "")
            member_count = len(answers.get("drives") or ())
            minimum = raid_rules.group_size_min(level)
            default = str(answers.get("group_size", ""))
            while True:
                value = await self.app.push_screen_wait(
                    InputDialog(
                        f"Group size (required for RAID {level}):",
                        f"Create Array — Step {step_no}",
                        default=default,
                        placeholder=str(minimum),
                        allow_back=allow_back,
                    )
                )
                if value is None:
                    return CANCEL
                if value is BACK:
                    return BACK
                try:
                    gs = int(value)
                except ValueError:
                    self.app.notify("Group size must be a whole number.", severity="error")
                    default = value
                    continue
                problem = raid_rules.validate_group_size(level, member_count, gs)
                if problem:
                    self.app.notify(problem, severity="error")
                    default = value
                    continue
                return gs

        async def spare_step(answers, allow_back, step_no):
            pool_choices = [_NONE_POOL] + sorted(pools.keys())
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    pool_choices,
                    title=f"Create Array — Step {step_no}",
                    prompt=_spare_prompt(pools),
                    selected=answers.get("spare", _NONE_POOL),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def confirm_step(answers, allow_back, step_no):
            summary = (
                f"Name:       {answers['name']}\n"
                f"Level:      RAID-{answers['level']}\n"
                f"Drives:     {', '.join(answers['drives'])}\n"
                f"Strip Size: {answers['strip']} KB"
            )
            if answers["level"] in ("50", "60"):
                summary += f"\nGroup Size: {answers.get('group_size')}"
            spare = answers.get("spare", _NONE_POOL)
            if spare != _NONE_POOL:
                summary += f"\nSpare Pool: {spare}"
            result = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Create this RAID array?\n\n{summary}", "Confirm Create", allow_back=allow_back
                )
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = [
            WizardStep(key="name", run=name_step),
            WizardStep(key="level", run=level_step),
            WizardStep(key="drives", run=drives_step),
            WizardStep(key="strip", run=strip_step),
            WizardStep(
                key="group_size",
                run=group_size_step,
                applies=lambda a: a.get("level") in ("50", "60"),
            ),
            WizardStep(key="spare", run=spare_step),
            WizardStep(key="confirmed", run=confirm_step),
        ]
        answers = await run_wizard(steps)
        if answers is None:
            return

        # Assemble the API spec from the collected answers.
        drives = answers["drives"]
        spec: dict[str, Any] = {
            "name": answers["name"],
            "level": f"raid{answers['level']}",
            "member_disk_ids": [name_to_id.get(n, n) for n in drives],
            "strip_size_kib": int(answers["strip"]),
        }
        if answers["level"] in ("50", "60"):
            spec["group_size"] = int(answers["group_size"])
        spec.update(_spare_spec_fragment(answers.get("spare", _NONE_POOL)))

        dialog = TaskWaitDialog(f"Creating RAID array '{answers['name']}'…", "Create Array")
        self.app.push_screen(dialog)
        cancelled = False
        error: ControlPathError | None = None
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/arrays",
                spec,
                on_progress=dialog.progress_from_thread(self.app),
                cancel_check=dialog.cancel_requested,
            )
        except TaskCancelled:
            cancelled = True
        except ControlPathError as exc:
            error = exc
        finally:
            dialog.dismiss(None)
        if cancelled:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "Create cancelled — partial work rolled back.", "Cancelled", ok_only=True
                )
            )
            return
        if error is not None:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Create failed.\n{error}", "Error", ok_only=True)
            )
            return
        self.app.audit.log(
            "raid.create", f"{answers['name']} RAID-{answers['level']} ({len(drives)} drives)", "OK"
        )
        await self.app.snapshots.record(
            "raid_create",
            diff_summary=f"Created RAID-{answers['level']} array '{answers['name']}' with {len(drives)} drives",
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
                ConfirmDialog(f"No arrays available.\n{exc}", "Edit Array", ok_only=True)
            )
            return

        arrays = _arrays_from_api(rows)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Edit Array", ok_only=True)
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
                            ok_only=True,
                        )
                    )
                    return
                value = raw

        elif key == "sparepool":
            # The operator picks an EXISTING pool; the control path only
            # references it (design 2026-08-29). Pool lifecycle is Spare Pools'.
            try:
                p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
            except ControlPathError:
                p_rows = []
            pools = _pools_by_name(p_rows)
            if not pools:
                await self.app.push_screen_wait(
                    ConfirmDialog(
                        "No spare pools exist.\n\n"
                        "Create one in Storage > Spare Pools > Create Pool, "
                        "then run Edit Array again.",
                        "No Spare Pools",
                        ok_only=True,
                    )
                )
                return
            value = await self.app.push_screen_wait(
                SelectDialog(
                    [_NONE_POOL] + sorted(pools.keys()),
                    title=f"Set {label}",
                    prompt=f"Select spare pool for {arr_name} ({_NONE_POOL} detaches):",
                )
            )
        elif kind == "select" and options:
            value = await self.app.push_screen_wait(
                SelectDialog(options, title=f"Set {label}", prompt=f"New value for {label}:")
            )
        else:
            # Re-prompt on a value xiRAID would reject rather than sending it
            # and letting the plan blocker be the first thing that says no —
            # the same rule the Create wizard applies to drive counts and
            # group sizes (raid-management-spec §4).
            default = ""
            while True:
                value = await self.app.push_screen_wait(
                    InputDialog(f"New value for {label}:", f"Set {label}", default=default)
                )
                if value is None:
                    return
                if vtype is not int:
                    break
                try:
                    parsed = int(str(value).strip())
                except (TypeError, ValueError):
                    self.app.notify(f"'{value}' is not a whole number.", severity="error")
                    default = str(value)
                    continue
                problem = raid_rules.validate_modify_value(key, parsed)
                if problem is not None:
                    self.app.notify(problem, severity="error")
                    default = str(value)
                    continue
                value = str(parsed)
                break

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
        # subset: spare_pool | tuning.*).
        patch_spec: dict[str, Any]
        if key == "sparepool":
            patch_spec = _spare_pool_patch(value)
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
                    ConfirmDialog(
                        f"Invalid value: expected {vtype.__name__}", "Error", ok_only=True
                    )
                )
                return

        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/arrays/{quote_id(arr_name)}",
                patch_spec,
                on_progress=self._task_progress(f"Edit {arr_name}"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Edit failed.\n{exc}", "Error", ok_only=True)
            )
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
                ok_only=True,
            )
        )

    async def _delete_dependencies(
        self, arr_name: str, volume_path: str, mounts: list[dict]
    ) -> tuple[list[dict], list[dict]] | None:
        """Discover what the teardown must remove before destroying the array.

        FAIL-CLOSED (raid-management-spec §6.1): a control-path read that
        errors out is not evidence of "no dependencies" — it is an unknown.
        Any read failure aborts the deletion with the error surfaced and
        nothing changed. Likewise a dependent mount the teardown cannot
        unmount (typically an XFS filesystem using the array only as its
        external log device, which the API does not model as
        ``backing_device``) blocks the deletion here, before any share is
        removed: the agent's delete preflight would refuse the destroy at
        the last step anyway.

        Returns ``(affected_shares, affected_filesystems)``, or ``None``
        when the deletion was aborted (the dialog is already shown).
        """
        mountpoints = {m["mountpoint"] for m in mounts if m.get("mountpoint")}

        # ── Affected shares: GET /shares filtered to paths under those
        # mountpoints ─────────────────────────────────────────────────────
        affected_shares: list[dict] = []  # [{id, path}]
        if mountpoints:
            try:
                share_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/shares")
            except ControlPathError as exc:
                await self._delete_aborted(
                    f"Could not read NFS shares from the control path:\n{exc}",
                    arr_name,
                )
                return None
            for doc in share_rows if isinstance(share_rows, list) else []:
                if not isinstance(doc, dict):
                    continue
                doc_spec = doc.get("spec")
                path = doc_spec.get("path") if isinstance(doc_spec, dict) else None
                sid = doc.get("id")
                if not path or sid is None:
                    continue
                if any(is_path_under(str(path), mp) for mp in mountpoints):
                    affected_shares.append({"id": str(sid), "path": str(path)})

        # ── Affected filesystems (mount units): backed by the array's
        # volume, or mounted on one of the affected mountpoints ──────────
        affected_fs: list[dict] = []  # [{id, mountpoint, mounted}]
        try:
            fs_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/filesystems")
        except ControlPathError as exc:
            await self._delete_aborted(
                f"Could not read filesystems from the control path:\n{exc}",
                arr_name,
            )
            return None
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

        # ── Dependents the teardown cannot clear (log/data device usage
        # with no matching mount unit) ───────────────────────────────────
        managed = {f["mountpoint"] for f in affected_fs}
        unmanaged = [m for m in mounts if m.get("mountpoint") and m["mountpoint"] not in managed]
        if unmanaged:
            listing = "\n".join(
                f"  - {m['mountpoint']}  ({m.get('role', 'unknown')} device)" for m in unmanaged
            )
            await self._delete_aborted(
                f"These mounts use '{arr_name}' but are not managed through "
                f"the control path, so the teardown cannot unmount them:\n"
                f"{listing}\n\n"
                f"Unmount them first — destroying the array would wipe the "
                f"journal of a filesystem that uses it as its external log "
                f"device, corrupting that filesystem.",
                arr_name,
            )
            return None

        return affected_shares, affected_fs

    async def _delete_aborted(self, reason: str, arr_name: str) -> None:
        """Informational halt before anything was changed (§6.1)."""
        await self.app.push_screen_wait(
            ConfirmDialog(
                f"{reason}\n\nArray '{arr_name}' was NOT deleted. Nothing was changed.",
                "Delete Array — Aborted",
                ok_only=True,
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
                ConfirmDialog(f"No arrays available.\n{exc}", "Delete Array", ok_only=True)
            )
            return

        arrays = _arrays_from_api(rows)
        names = list(arrays.keys())
        if not names:
            await self.app.push_screen_wait(
                ConfirmDialog("No RAID arrays configured.", "Delete Array", ok_only=True)
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

        # ── Dependencies (fail-closed; aborts with the error surfaced) ───
        found = await self._delete_dependencies(arr_name, volume_path, mounts)
        if found is None:
            return
        affected_shares, affected_fs = found

        # ── Build warning message with dependency info ───────────────────
        warning_parts = [
            f"RAID-{level}  |  {size}  |  {len(devs)} drive(s)\n",
        ]

        if affected_shares:
            share_list = "\n".join(f"  - {s['path']}" for s in affected_shares)
            warning_parts.append(f"ACTIVE NFS SHARES will be removed:\n{share_list}\n")

        # Every dependent mount is API-managed here — a mount the teardown
        # could not clear already aborted the deletion in §6.1.
        if affected_fs:
            fs_lines = [f"  - {f['mountpoint'] or f['id']} ({f['id']})" for f in affected_fs]
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
        if affected_fs or affected_shares:
            confirmed2 = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Are you ABSOLUTELY sure?\n\n"
                    f"This will remove {len(affected_shares)} NFS share(s) "
                    f"and {len(affected_fs)} filesystem(s) before destroying "
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
                    f"/api/v1/shares/{quote_id(share['id'])}",
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
                        f"/api/v1/filesystems/{quote_id(fid)}",
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
                    f"/api/v1/filesystems/{quote_id(fid)}",
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
        destroy_dialog = TaskWaitDialog(f"Destroying RAID array '{arr_name}'…", "Destroy Array")
        self.app.push_screen(destroy_dialog)
        dialog_cb = destroy_dialog.progress_from_thread(self.app)

        def _destroy_progress(state: str) -> None:
            progress(state)
            dialog_cb(state)

        destroy_cancelled = False
        destroy_error: ControlPathError | None = None
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "DELETE",
                f"/api/v1/arrays/{quote_id(arr_name)}",
                {},
                dangerous=True,
                on_progress=_destroy_progress,
                cancel_check=destroy_dialog.cancel_requested,
            )
        except TaskCancelled:
            destroy_cancelled = True
        except ControlPathError as exc:
            destroy_error = exc
        finally:
            destroy_dialog.dismiss(None)
        if destroy_cancelled:
            self._teardown_append(
                lines,
                "  Destroy CANCELLED — partial work rolled back "
                "(shares/filesystems already removed stay removed).",
            )
            self.app.notify(f"Destroy of '{arr_name}' cancelled.", severity="warning")
            return
        if destroy_error is not None:
            await self._teardown_failed(
                lines, f"RAID destroy failed for '{arr_name}'", destroy_error
            )
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

# What an UNOBSERVED value renders as. Never a plausible default — see
# docs/Storage/raid-management-spec.md §3.2.
_UNKNOWN = f"{_DIM}unknown{_NC}"


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


def _format_raid_overview(arrays: dict, extended: bool = False, banner: str | None = None) -> str:
    lines: list[str] = []

    if banner:
        lines.append(f"  {_YLW}⚠ {banner}{_NC}")
        lines.append("")

    title = "RAID ARRAYS — EXTENDED" if extended else "RAID ARRAYS — QUICK OVERVIEW"
    lines.append(_box_sep("="))
    pad = (_W - len(title)) // 2
    lines.append(
        f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}{title}{_NC}{' ' * (_W - pad - len(title) + 1)}{_DIM}|{_NC}"
    )
    lines.append(_box_sep("="))
    lines.append("")

    if not arrays:
        if banner:
            lines.append(f"  {_YLW}xiRAID backend unavailable — cannot list arrays.{_NC}")
        else:
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
        memory_mb = arr.get("memory_usage_mb")
        block_size = arr.get("block_size")

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
            # Every value below is pure observation. An unobserved knob
            # (absent → None) renders as the unknown placeholder, NEVER as a
            # plausible default: printing "unlimited" for a memory limit
            # nobody read tells the operator the array is unconstrained while
            # the daemon rejects their edit with "RAID already has '2048'
            # reserved MiBs". See raid-management-spec §3.2.
            def _opt(value, render):
                return _UNKNOWN if value is None else render(value)

            def _on_off(v):
                return _opt(v, lambda x: f"{_GRN}Enabled{_NC}" if x else f"{_DIM}Disabled{_NC}")

            def _yes_no(v):
                # For state the daemon observes rather than a knob that was
                # set — "Enabled" would read as configuration.
                return _opt(v, lambda x: f"{_GRN}Yes{_NC}" if x else f"{_DIM}No{_NC}")

            def _usecs(v):
                return _opt(v, lambda x: f"{x} us")

            # ── Priorities ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}PRIORITIES{_NC}"))
            lines.append(_box_sep())

            def _pct(v):
                # Priorities keep the dash they always had — the one block
                # with no plausible default to fall back on.
                return "-" if v is None else f"{v}%"

            init_p = _pct(arr.get("init_prio"))
            recon_p = _pct(arr.get("recon_prio"))
            restripe_p = _pct(arr.get("restripe_prio"))
            sdc_p = _pct(arr.get("sdc_prio"))
            lines.append(_box_line(f"  {_DIM}Init Priority{_NC}       |  {init_p}"))
            lines.append(_box_line(f"  {_DIM}Recon Priority{_NC}      |  {recon_p}"))
            lines.append(_box_line(f"  {_DIM}Restripe Priority{_NC}   |  {restripe_p}"))
            lines.append(_box_line(f"  {_DIM}SDC Priority{_NC}        |  {sdc_p}"))

            # ── Performance ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}PERFORMANCE{_NC}"))
            lines.append(_box_sep())
            # 0 is a real observed value — xiRAID's "no limit" / "prealloc
            # off" — and must not collapse into the unknown case.
            mem_limit = _opt(arr.get("memory_limit"), lambda v: "unlimited" if not v else f"{v} MB")
            mem_prealloc = _opt(
                arr.get("memory_prealloc"), lambda v: "disabled" if not v else f"{v} MB"
            )
            req_limit = _opt(arr.get("request_limit"), lambda v: "unlimited" if not v else str(v))
            cpu = _opt(arr.get("cpu_allowed"), lambda v: v or "all")
            lines.append(
                _box_line(
                    f"  {_DIM}Memory Usage{_NC}        |  {_opt(memory_mb, lambda v: f'{v} MB')}"
                )
            )
            lines.append(_box_line(f"  {_DIM}Memory Limit{_NC}        |  {mem_limit}"))
            lines.append(_box_line(f"  {_DIM}Memory Pre-alloc{_NC}    |  {mem_prealloc}"))
            lines.append(
                _box_line(
                    f"  {_DIM}Block Size{_NC}          |  {_opt(block_size, lambda v: f'{v} bytes')}"
                )
            )
            lines.append(_box_line(f"  {_DIM}Request Limit{_NC}       |  {req_limit}"))
            lines.append(_box_line(f"  {_DIM}CPU Affinity{_NC}        |  {cpu}"))

            # ── I/O Scheduler & Merge ──
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}I/O SCHEDULER & MERGE{_NC}"))
            lines.append(_box_sep())
            sched = arr.get("sched_enabled")
            mr_en = arr.get("merge_read_enabled")
            mw_en = arr.get("merge_write_enabled")
            adapt = arr.get("adaptive_merge")
            lines.append(_box_line(f"  {_DIM}Scheduler{_NC}           |  {_on_off(sched)}"))
            lines.append(_box_line(f"  {_DIM}Merge Read{_NC}          |  {_on_off(mr_en)}"))
            lines.append(_box_line(f"  {_DIM}Merge Write{_NC}         |  {_on_off(mw_en)}"))
            lines.append(_box_line(f"  {_DIM}Adaptive Merge{_NC}      |  {_on_off(adapt)}"))
            mr_max = arr.get("merge_read_max")
            mr_wait = arr.get("merge_read_wait")
            mw_max = arr.get("merge_write_max")
            mw_wait = arr.get("merge_write_wait")
            if any(v is not None for v in (mr_max, mr_wait, mw_max, mw_wait)):
                lines.append(_box_line(f"  {_DIM}Merge Read Max{_NC}      |  {_usecs(mr_max)}"))
                lines.append(_box_line(f"  {_DIM}Merge Read Wait{_NC}     |  {_usecs(mr_wait)}"))
                lines.append(_box_line(f"  {_DIM}Merge Write Max{_NC}     |  {_usecs(mw_max)}"))
                lines.append(_box_line(f"  {_DIM}Merge Write Wait{_NC}    |  {_usecs(mw_wait)}"))

            # ── TRIM / Discard ──
            # Two different facts. `discard` (the daemon's `discard_allowed`)
            # is what the array was CREATED to accept — create-only, since
            # RaidModify has no field for it — and the installer decides it
            # from the members' discard support (Installer/raid-spec §7.5).
            # `discard_active` is whether the daemon is processing discards
            # right now, which is not implied by the first: an initializing
            # array reports allowed=1 active=0. Showing only the configured
            # value claims TRIM reaches the media when it may not.
            #
            # There is no Drive TRIM row: `--drive_trim` TRIMs the disks
            # BEFORE the array is created, so it is an action with no state to
            # read back, and raid_show reports no such field.
            lines.append(_box_line())
            lines.append(_box_sep())
            lines.append(_box_line(f" {_BLD}{_CYN}TRIM / DISCARD{_NC}"))
            lines.append(_box_sep())
            lines.append(
                _box_line(f"  {_DIM}Discard (TRIM){_NC}      |  {_on_off(arr.get('discard'))}")
            )
            lines.append(
                _box_line(
                    f"  {_DIM}Discard Active{_NC}      |  {_yes_no(arr.get('discard_active'))}"
                )
            )

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
