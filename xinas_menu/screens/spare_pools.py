"""SparePoolScreen — Spare pool lifecycle management (create, delete, add/remove drives, activate/deactivate)."""
from __future__ import annotations

import logging
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


def _box_line(content: str = "", w: int = 66) -> str:
    visible = len(content.replace(_BLD, "").replace(_DIM, "").replace(_CYN, "")
                         .replace(_GRN, "").replace(_RED, "").replace(_YLW, "").replace(_NC, ""))
    pad = max(0, w - visible)
    return f"{_DIM}|{_NC}{content}{' ' * pad}{_DIM}|{_NC}"


def _box_sep(char: str = "-", w: int = 66) -> str:
    return f"{_DIM}+{char * (w + 1)}+{_NC}"


def _format_spare_pools(data: Any) -> str:
    """Format pool data for display. Shared with RAID screen."""
    W3 = 66
    lines: list[str] = []

    lines.append(_box_sep("="))
    pad = (W3 - len("SPARE POOLS")) // 2
    lines.append(f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}SPARE POOLS{_NC}{' ' * (W3 - pad - len('SPARE POOLS') + 1)}{_DIM}|{_NC}")
    lines.append(_box_sep("="))
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
        lines.append(f"  Use {_BLD}2{_NC} Create Pool to add one.")
        lines.append("")
        return "\n".join(lines)

    for name, pool in pools.items():
        if not isinstance(pool, dict):
            continue
        devices = pool.get("devices", [])
        serials = pool.get("serials", [])
        sizes = pool.get("sizes", [])
        state = pool.get("state", "unknown")
        if isinstance(state, list):
            state = state[0] if state else "unknown"

        state_color = _GRN if state == "active" else _YLW if state == "inactive" else _RED

        lines.append(_box_sep("-"))
        lines.append(_box_line(f" Pool: {_BLD}{name.upper()}{_NC}"))
        lines.append(_box_sep())
        lines.append(_box_line(f"  State:    {state_color}{state}{_NC}"))
        lines.append(_box_line(f"  Devices:  {len(devices)}"))
        lines.append(_box_sep())
        if devices:
            lines.append(_box_line(f"  {'Device':<22}{'Size':<16}Serial"))
            lines.append(_box_sep())
            for i, dev in enumerate(devices):
                dev_path = (dev[1] if isinstance(dev, list) and len(dev) > 1
                            else str(dev)).replace("/dev/", "")
                sz = sizes[i] if i < len(sizes) else "N/A"
                serial = str(serials[i])[:16] if i < len(serials) and serials[i] else "N/A"
                lines.append(_box_line(f"  {dev_path:<22}{sz:<16}{serial}"))
        lines.append(_box_line())
        lines.append(_box_sep("-"))
        lines.append("")

    lines.append(f"  Total: {len(pools)} pool(s)")
    lines.append(_box_sep("="))
    return "\n".join(lines)


async def _get_pool_names(grpc_client) -> list[str]:
    """Fetch list of existing pool names."""
    ok, data, _ = await grpc_client.pool_show()
    if not ok or not data:
        return []
    if isinstance(data, dict):
        return list(data.keys())
    if isinstance(data, list):
        return [p.get("name", "") for p in data if isinstance(p, dict) and p.get("name")]
    return []


async def _get_pool_drives(grpc_client, pool_name: str) -> list[str]:
    """Fetch drive paths in a specific pool."""
    ok, data, _ = await grpc_client.pool_show(name=pool_name)
    if not ok or not data:
        return []
    pool = None
    if isinstance(data, dict):
        pool = data.get(pool_name, data)
    elif isinstance(data, list):
        pool = next((p for p in data if isinstance(p, dict) and p.get("name") == pool_name), None)
    if not pool or not isinstance(pool, dict):
        return []
    devices = pool.get("devices", [])
    paths = []
    for dev in devices:
        if isinstance(dev, list) and len(dev) > 1:
            paths.append(dev[1])
        else:
            paths.append(str(dev))
    return paths


async def _get_free_nvme_drives(grpc_client) -> list[dict]:
    """Get NVMe drives that are not in any RAID array or spare pool."""
    ok, disks, _ = await grpc_client.disk_list()
    if not ok or not disks:
        return []

    # Get drives in pools
    pool_drives: set[str] = set()
    p_ok, p_data, _ = await grpc_client.pool_show()
    if p_ok and p_data:
        pools = p_data if isinstance(p_data, dict) else {}
        if isinstance(p_data, list):
            for p in p_data:
                if isinstance(p, dict):
                    pools[p.get("name", "")] = p
        for pool in pools.values():
            if isinstance(pool, dict):
                for dev in pool.get("devices", []):
                    path = dev[1] if isinstance(dev, list) and len(dev) > 1 else str(dev)
                    pool_drives.add(path)

    free = []
    for d in disks:
        name = d.get("name", "")
        if "nvme" not in name.lower():
            continue
        if d.get("system"):
            continue
        if d.get("raid_name"):
            continue
        dev_path = f"/dev/{name}" if not name.startswith("/dev/") else name
        if dev_path in pool_drives or name in pool_drives:
            continue
        free.append(d)
    return free


class SparePoolScreen(Screen):
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

    # ── View ─────────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _view_pools(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content("Loading spare pools…")
        ok, data, err = await self.app.grpc.pool_show()
        view.set_content(
            _format_spare_pools(data) if ok
            else f"Could not load pool info: {grpc_short_error(err)}"
        )

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
        free_drives = await _get_free_nvme_drives(self.app.grpc)
        if not free_drives:
            await self.app.push_screen_wait(
                ConfirmDialog("No available drives found.\nAll drives are assigned to RAID arrays or other pools.", "Error")
            )
            return

        selected = await self.app.push_screen_wait(
            DrivePickerScreen(free_drives, title="Create Pool — Select Drives")
        )
        if not selected:
            return

        # Confirm
        summary = (
            f"Pool Name:  {name}\n"
            f"Drives:     {', '.join(selected)}\n"
            f"Count:      {len(selected)}"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(summary, "Create Pool — Confirm")
        )
        if not confirmed:
            return

        # Normalize to /dev/ paths (drive picker returns bare names)
        drives = [d if d.startswith("/dev/") else f"/dev/{d}" for d in selected]

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Creating pool '{name}'…")
        ok, data, err = await self.app.grpc.pool_create(name=name, drives=drives)
        if ok:
            self.app.notify(f"Pool '{name}' created successfully.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to create pool: {grpc_short_error(err)}")

    # ── Add Drives ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _add_drives(self) -> None:
        pool_names = await _get_pool_names(self.app.grpc)
        if not pool_names:
            await self.app.push_screen_wait(ConfirmDialog("No spare pools exist.", "Error"))
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Add Drives", prompt="Select pool:")
        )
        if not pool:
            return

        free_drives = await _get_free_nvme_drives(self.app.grpc)
        if not free_drives:
            await self.app.push_screen_wait(
                ConfirmDialog("No available drives found.", "Error")
            )
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

        # Normalize to /dev/ paths (drive picker returns bare names)
        drives = [d if d.startswith("/dev/") else f"/dev/{d}" for d in selected]

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Adding drives to pool '{pool}'…")
        ok, data, err = await self.app.grpc.pool_add(name=pool, drives=drives)
        if ok:
            self.app.notify(f"Drives added to pool '{pool}'.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to add drives: {grpc_short_error(err)}")

    # ── Remove Drives ────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _remove_drives(self) -> None:
        pool_names = await _get_pool_names(self.app.grpc)
        if not pool_names:
            await self.app.push_screen_wait(ConfirmDialog("No spare pools exist.", "Error"))
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Remove Drives", prompt="Select pool:")
        )
        if not pool:
            return

        drives = await _get_pool_drives(self.app.grpc, pool)
        if not drives:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Pool '{pool}' has no drives.", "Error")
            )
            return

        # Use checklist so user can pick which drives to remove
        drive_labels = [d.replace("/dev/", "") for d in drives]
        selected_indices = await self.app.push_screen_wait(
            ChecklistDialog(
                drive_labels,
                title=f"Remove Drives from '{pool}'",
                prompt="Select drives to remove:",
            )
        )
        if not selected_indices:
            return

        selected_drives = [drives[i] for i in selected_indices]

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
        ok, data, err = await self.app.grpc.pool_remove(name=pool, drives=selected_drives)
        if ok:
            self.app.notify(f"Drives removed from pool '{pool}'.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to remove drives: {grpc_short_error(err)}")

    # ── Activate ─────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _activate_pool(self) -> None:
        pool_names = await _get_pool_names(self.app.grpc)
        if not pool_names:
            await self.app.push_screen_wait(ConfirmDialog("No spare pools exist.", "Error"))
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Activate Pool", prompt="Select pool to activate:")
        )
        if not pool:
            return

        view = self.query_one("#pool-content", ScrollableTextView)
        view.set_content(f"Activating pool '{pool}'…")
        ok, data, err = await self.app.grpc.pool_activate(name=pool)
        if ok:
            self.app.notify(f"Pool '{pool}' activated.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to activate pool: {grpc_short_error(err)}")

    # ── Deactivate ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _deactivate_pool(self) -> None:
        pool_names = await _get_pool_names(self.app.grpc)
        if not pool_names:
            await self.app.push_screen_wait(ConfirmDialog("No spare pools exist.", "Error"))
            return

        pool = await self.app.push_screen_wait(
            SelectDialog(sorted(pool_names), title="Deactivate Pool", prompt="Select pool to deactivate:")
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
        ok, data, err = await self.app.grpc.pool_deactivate(name=pool)
        if ok:
            self.app.notify(f"Pool '{pool}' deactivated.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to deactivate pool: {grpc_short_error(err)}")

    # ── Delete ───────────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _delete_pool(self) -> None:
        pool_names = await _get_pool_names(self.app.grpc)
        if not pool_names:
            await self.app.push_screen_wait(ConfirmDialog("No spare pools exist.", "Error"))
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
        ok, data, err = await self.app.grpc.pool_delete(name=pool)
        if ok:
            self.app.notify(f"Pool '{pool}' deleted.", severity="information")
            self._view_pools()
        else:
            view.set_content(f"Failed to delete pool: {grpc_short_error(err)}")
