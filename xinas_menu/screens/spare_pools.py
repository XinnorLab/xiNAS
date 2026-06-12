"""SparePoolScreen — Spare pool lifecycle management (create, delete, add/remove drives, activate/deactivate).

S9 T11 (ADR-0011): the screen rides the control-path API. Reads come
from GET /api/v1/pools (rows: ``{name, drives, active, referenced_by}``),
mutations go through ``plan_apply_wait`` — POST /api/v1/pools (create),
PATCH /api/v1/pools/{name} with exactly ONE intent (``add_drives`` |
``remove_drives`` | ``active``), DELETE /api/v1/pools/{name} (blocked
server-side while the pool is active or referenced by an array). Drive
candidates come from GET /api/v1/disks via the RAID screen's adapter.
"""

from __future__ import annotations

import asyncio
import logging
import re
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
from xinas_menu.screens.raid import _list_api_disks
from xinas_menu.widgets.checklist_dialog import ChecklistDialog
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_POOL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

_MENU = [
    MenuItem("1", "View Pools"),
    MenuItem("", "", separator=True),
    MenuItem("2", "Create Pool"),
    MenuItem("3", "Add Drives"),
    MenuItem("4", "Remove Drives"),
    MenuItem("", "", separator=True),
    MenuItem("5", "Activate Pool"),
    MenuItem("6", "Deactivate Pool"),
    MenuItem("7", "Delete Pool"),
    MenuItem("0", "Back"),
]

# ANSI helpers
_BLD = "\033[1m"
_DIM = "\033[2m"
_CYN = "\033[36m"
_GRN = "\033[32m"
_RED = "\033[31m"
_YLW = "\033[33m"
_NC = "\033[0m"


def _pool_error(action: str, err: str) -> str:
    """Format a pool operation error with short summary and full details."""
    raw = err.strip() if err else ""
    short = raw.splitlines()[0][:100] if raw else "unknown error"
    lines = [
        f"{_BLD}{_RED}ERROR:{_NC} {action}",
        "",
        f"  {_BLD}Reason:{_NC}  {short}",
    ]
    # Show full error if it contains more info than the short version
    if raw and raw != short and len(raw) > len(short):
        lines.append("")
        lines.append(f"  {_DIM}Full error:{_NC}")
        for raw_line in raw.splitlines():
            while len(raw_line) > 72:
                lines.append(f"    {raw_line[:72]}")
                raw_line = raw_line[72:]
            lines.append(f"    {raw_line}")
    return "\n".join(lines)


def _box_line(content: str = "", w: int = 66) -> str:
    visible = len(
        content.replace(_BLD, "")
        .replace(_DIM, "")
        .replace(_CYN, "")
        .replace(_GRN, "")
        .replace(_RED, "")
        .replace(_YLW, "")
        .replace(_NC, "")
    )
    pad = max(0, w - visible)
    return f"{_DIM}|{_NC}{content}{' ' * pad}{_DIM}|{_NC}"


def _box_sep(char: str = "-", w: int = 66) -> str:
    return f"{_DIM}+{char * (w + 1)}+{_NC}"


def _format_spare_pools(data: Any) -> str:
    """Format GET /api/v1/pools rows for display. Shared with RAID screen.

    Rows are ``{name, drives: ["/dev/..."], active: bool,
    referenced_by: [array names]}``. Pools referenced by an array are
    marked clearly — they cannot be deleted until released.
    """
    W3 = 66
    lines: list[str] = []

    lines.append(_box_sep("="))
    pad = (W3 - len("SPARE POOLS")) // 2
    lines.append(
        f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}SPARE POOLS{_NC}{' ' * (W3 - pad - len('SPARE POOLS') + 1)}{_DIM}|{_NC}"
    )
    lines.append(_box_sep("="))
    lines.append("")

    pools = [p for p in data if isinstance(p, dict)] if isinstance(data, list) else []

    if not pools:
        lines.append("  No spare pools configured.")
        lines.append("")
        lines.append(f"  Use {_BLD}2{_NC} Create Pool to add one.")
        lines.append("")
        return "\n".join(lines)

    for pool in pools:
        name = str(pool.get("name", "?"))
        drives = [str(d) for d in pool.get("drives") or []]
        active = pool.get("active") is True
        refs = [str(r) for r in pool.get("referenced_by") or []]

        state = "active" if active else "inactive"
        state_color = _GRN if active else _YLW

        header = f" Pool: {_BLD}{name.upper()}{_NC}"
        if refs:
            header += f"  {_YLW}[in use]{_NC}"

        lines.append(_box_sep("-"))
        lines.append(_box_line(header))
        lines.append(_box_sep())
        lines.append(_box_line(f"  State:    {state_color}{state}{_NC}"))
        used_by = f"{_YLW}{', '.join(refs)}{_NC}" if refs else f"{_DIM}-{_NC}"
        lines.append(_box_line(f"  Used by:  {used_by}"))
        lines.append(_box_line(f"  Drives:   {len(drives)}"))
        if drives:
            lines.append(_box_sep())
            for path in drives:
                lines.append(_box_line(f"  {path.replace('/dev/', '')}"))
        lines.append(_box_line())
        lines.append(_box_sep("-"))
        lines.append("")

    lines.append(f"  Total: {len(pools)} pool(s)")
    lines.append(_box_sep("="))
    return "\n".join(lines)


async def _get_pools(control: ControlClient) -> list[dict[str, Any]]:
    """GET /api/v1/pools → pool rows ``{name, drives, active, referenced_by}``.

    Raises ControlPathError when the api is unreachable.
    """
    rows = await asyncio.to_thread(control.result, "/api/v1/pools")
    return [p for p in rows if isinstance(p, dict)] if isinstance(rows, list) else []


async def _get_pool_names(control: ControlClient) -> list[str]:
    """Fetch list of existing pool names."""
    return [str(p["name"]) for p in await _get_pools(control) if p.get("name")]


async def _get_pool_drives(control: ControlClient, pool_name: str) -> list[str]:
    """Fetch drive paths in a specific pool."""
    for pool in await _get_pools(control):
        if pool.get("name") == pool_name:
            return [str(d) for d in pool.get("drives") or []]
    return []


async def _get_free_nvme_drives(control: ControlClient) -> list[dict[str, Any]]:
    """NVMe drives available for pool use.

    ``safe_for_use``, not the system disk, not a member/spare of an
    observed array (``claimed``), and not already in any spare pool.
    Raises ControlPathError when the api is unreachable.
    """
    rows = await _list_api_disks(control)

    pool_drives: set[str] = set()
    for pool in await _get_pools(control):
        for raw in pool.get("drives") or []:
            path = str(raw)
            pool_drives.add(path)
            pool_drives.add(path.rsplit("/", 1)[-1])

    free: list[dict[str, Any]] = []
    for d in rows:
        name = d.get("name", "")
        if "nvme" not in name.lower():
            continue
        if d.get("system") or not d.get("safe_for_use") or d.get("claimed"):
            continue
        if d.get("device_path") in pool_drives or name in pool_drives:
            continue
        free.append(d)
    return free


def _to_dev_paths(selected: list[str], rows: list[dict[str, Any]]) -> list[str]:
    """Map picker drive NAMES onto /dev/ paths (the pool spec contract)."""
    path_by_name = {str(d.get("name")): str(d.get("device_path")) for d in rows}
    return [path_by_name.get(n) or (n if n.startswith("/dev/") else f"/dev/{n}") for n in selected]


class SparePoolScreen(XiNASAppMixin, Screen):
    """Spare pool management — view, create, modify, and delete spare pools."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Spare Pools", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="pool-nav")
            yield ScrollableTextView(
                f"{_BLD}{_CYN}Spare Pool Management{_NC}\n"
                f"\n"
                f"  {_BLD}1{_NC}  {_CYN}View Pools{_NC}         {_DIM}View all spare pools and their drives{_NC}\n"
                f"  {_BLD}2{_NC}  {_CYN}Create Pool{_NC}        {_DIM}Create a new spare pool from available drives{_NC}\n"
                f"  {_BLD}3{_NC}  {_CYN}Add Drives{_NC}         {_DIM}Add available drives to an existing pool{_NC}\n"
                f"  {_BLD}4{_NC}  {_CYN}Remove Drives{_NC}      {_DIM}Remove drives from a pool{_NC}\n"
                f"  {_BLD}5{_NC}  {_CYN}Activate Pool{_NC}      {_DIM}Load a pool into active memory{_NC}\n"
                f"  {_BLD}6{_NC}  {_CYN}Deactivate Pool{_NC}    {_DIM}Unload a pool from memory{_NC}\n"
                f"  {_BLD}7{_NC}  {_CYN}Delete Pool{_NC}        {_DIM}Permanently delete a spare pool{_NC}\n",
                id="pool-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._view_pools()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._view_pools()
        elif key == "2":
            self._create_pool()
        elif key == "3":
            self._add_drives()
        elif key == "4":
            self._remove_drives()
        elif key == "5":
            self._activate_pool()
        elif key == "6":
            self._deactivate_pool()
        elif key == "7":
            self._delete_pool()

    def _task_progress(self, label: str):
        """Build an ``on_progress`` callback for ``plan_apply_wait``.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before raising the toast.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    async def _pool_names_or_dialog(self) -> list[str] | None:
        """Pool names for the verb flows; shows the error/empty dialogs.

        Returns None when the flow should abort (api unreachable or no
        pools exist) — the dialog has already been shown.
        """
        try:
            pool_names = await _get_pool_names(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Could not list pools.\n{exc}", "Error"))
            return None
        if not pool_names:
            await self.app.push_screen_wait(
                ConfirmDialog("No spare pools exist.", "Error", ok_only=True)
            )
            return None
        return pool_names

    # ── View ─────────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _view_pools(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content("Loading spare pools…")
        try:
            pools = await _get_pools(self.app.control)
        except ControlPathError as exc:
            view.set_content(f"Could not load pool info: {exc}")
            return
        view.set_content(_format_spare_pools(pools))

    # ── Create Pool ──────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _create_pool(self) -> None:
        # Step 1: Pool name
        while True:
            name = await self.app.push_screen_wait(
                InputDialog("Pool name:", "Create Pool — Step 1", placeholder="spare0")
            )
            if not name:
                return
            if not _POOL_NAME_RE.match(name):
                self.app.notify(
                    "Pool name must contain only letters, digits, hyphens, and underscores.",
                    severity="error",
                )
                continue
            break

        # Step 2: Select drives
        try:
            free_drives = await _get_free_nvme_drives(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Could not list drives.\n{exc}", "Error")
            )
            return
        if not free_drives:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No available drives found.\nAll drives are assigned to RAID arrays or other pools.",
                    "Error",
                )
            )
            return

        selected = await self.app.push_screen_wait(
            DrivePickerScreen(free_drives, title="Create Pool — Select Drives")
        )
        if not selected:
            return

        # Confirm
        summary = (
            f"Pool Name:  {name}\nDrives:     {', '.join(selected)}\nCount:      {len(selected)}"
        )
        confirmed = await self.app.push_screen_wait(ConfirmDialog(summary, "Create Pool — Confirm"))
        if not confirmed:
            return

        # The picker returns drive NAMES; the pool spec wants /dev/ paths.
        drives = _to_dev_paths(selected, free_drives)

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Creating pool '{name}'…")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/pools",
                {"name": name, "drives": drives},
                on_progress=self._task_progress("Create Pool"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to create pool", str(exc)))
            return
        self.app.notify(f"Pool '{name}' created successfully.", severity="information")
        self._view_pools()

    # ── Add Drives ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _add_drives(self) -> None:
        pool_names = await self._pool_names_or_dialog()
        if pool_names is None:
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Add Drives", prompt="Select pool:")
        )
        if not pool:
            return

        try:
            free_drives = await _get_free_nvme_drives(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Could not list drives.\n{exc}", "Error")
            )
            return
        if not free_drives:
            await self.app.push_screen_wait(ConfirmDialog("No available drives found.", "Error"))
            return

        selected = await self.app.push_screen_wait(
            DrivePickerScreen(free_drives, title=f"Add Drives to '{pool}'")
        )
        if not selected:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Add {len(selected)} drive(s) to pool '{pool}'?\n\n{', '.join(selected)}",
                "Confirm Add Drives",
            )
        )
        if not confirmed:
            return

        # The picker returns drive NAMES; the pool spec wants /dev/ paths.
        drives = _to_dev_paths(selected, free_drives)

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Adding drives to pool '{pool}'…")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/pools/{pool}",
                {"add_drives": drives},
                on_progress=self._task_progress("Add Drives"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to add drives", str(exc)))
            return
        self.app.notify(f"Drives added to pool '{pool}'.", severity="information")
        self._view_pools()

    # ── Remove Drives ────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _remove_drives(self) -> None:
        pool_names = await self._pool_names_or_dialog()
        if pool_names is None:
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Remove Drives", prompt="Select pool:")
        )
        if not pool:
            return

        try:
            drives = await _get_pool_drives(self.app.control, pool)
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Could not list pool drives.\n{exc}", "Error")
            )
            return
        if not drives:
            await self.app.push_screen_wait(ConfirmDialog(f"Pool '{pool}' has no drives.", "Error"))
            return

        # Use checklist so user can pick which drives to remove
        label_to_path = {d.rsplit("/", 1)[-1]: d for d in drives}
        selected_values = await self.app.push_screen_wait(
            ChecklistDialog(
                [(label, label, False) for label in label_to_path],
                title=f"Remove Drives from '{pool}'",
                prompt="Select drives to remove:",
            )
        )
        if not selected_values:
            return

        selected_drives = [label_to_path.get(v, f"/dev/{v}") for v in selected_values]

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Remove {len(selected_drives)} drive(s) from pool '{pool}'?\n\n"
                + ", ".join(d.replace("/dev/", "") for d in selected_drives),
                "Confirm Remove Drives",
            )
        )
        if not confirmed:
            return

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Removing drives from pool '{pool}'…")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/pools/{pool}",
                {"remove_drives": selected_drives},
                on_progress=self._task_progress("Remove Drives"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to remove drives", str(exc)))
            return
        self.app.notify(f"Drives removed from pool '{pool}'.", severity="information")
        self._view_pools()

    # ── Activate ─────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _activate_pool(self) -> None:
        pool_names = await self._pool_names_or_dialog()
        if pool_names is None:
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(
                sorted(pool_names), title="Activate Pool", prompt="Select pool to activate:"
            )
        )
        if not pool:
            return

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Activating pool '{pool}'…")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/pools/{pool}",
                {"active": True},
                on_progress=self._task_progress("Activate Pool"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to activate pool", str(exc)))
            return
        self.app.notify(f"Pool '{pool}' activated.", severity="information")
        self._view_pools()

    # ── Deactivate ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _deactivate_pool(self) -> None:
        pool_names = await self._pool_names_or_dialog()
        if pool_names is None:
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(
                sorted(pool_names), title="Deactivate Pool", prompt="Select pool to deactivate:"
            )
        )
        if not pool:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Deactivate pool '{pool}'?\n\nThe pool will be unloaded from memory. "
                "Drives will remain assigned but will not be available for automatic replacement.",
                "Confirm Deactivate",
            )
        )
        if not confirmed:
            return

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Deactivating pool '{pool}'…")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/pools/{pool}",
                {"active": False},
                on_progress=self._task_progress("Deactivate Pool"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to deactivate pool", str(exc)))
            return
        self.app.notify(f"Pool '{pool}' deactivated.", severity="information")
        self._view_pools()

    # ── Delete ───────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _delete_pool(self) -> None:
        pool_names = await self._pool_names_or_dialog()
        if pool_names is None:
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Delete Pool", prompt="Select pool to delete:")
        )
        if not pool:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"{_RED}WARNING: This will permanently delete pool '{pool}'.{_NC}\n\n"
                "All drives will be released from the pool.\n"
                "This action cannot be undone.",
                "Confirm Delete Pool",
            )
        )
        if not confirmed:
            return

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Deleting pool '{pool}'…")
        # Active/referenced pools are blocked server-side (pool_active /
        # pool_referenced plan blockers) — the message lands in _pool_error.
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "DELETE",
                f"/api/v1/pools/{pool}",
                {},
                on_progress=self._task_progress("Delete Pool"),
            )
        except ControlPathError as exc:
            view.set_content(_pool_error("Failed to delete pool", str(exc)))
            return
        self.app.notify(f"Pool '{pool}' deleted.", severity="information")
        self._view_pools()
