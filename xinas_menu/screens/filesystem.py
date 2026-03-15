"""FilesystemScreen — Create and manage XFS filesystems on xiRAID arrays."""
from __future__ import annotations

import json
import logging
from typing import Any

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
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Show Filesystems"),
    MenuItem("2", "Create Filesystem"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

# RAID levels typically used as data vs log arrays
_DATA_LEVELS = {"5", "6", "50", "60"}
_LOG_LEVELS = {"0", "1", "10"}


def _classify_role(level: str) -> str:
    """Suggest 'data' or 'log' based on RAID level."""
    if str(level) in _DATA_LEVELS:
        return "data"
    return "log"


def _array_label(arr: dict) -> str:
    """Format array info for selection dialog."""
    name = arr.get("name", "?")
    level = arr.get("level", "?")
    devices = arr.get("devices", [])
    dev_count = len(devices) if isinstance(devices, list) else 0
    strip = arr.get("strip_size", "?")
    role_hint = _classify_role(level)
    return f"{name}  (RAID-{level}, {dev_count} drives, {strip}KB strip)  [{role_hint}]"


class FilesystemScreen(Screen):
    """Filesystem management — show existing and create new XFS filesystems."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Filesystem", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="fs-nav")
            yield ScrollableTextView(id="fs-content")
        yield Footer()

    def on_mount(self) -> None:
        BLD, DIM, CYN, NC = "\033[1m", "\033[2m", "\033[36m", "\033[0m"
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content(
            f"{BLD}{CYN}Filesystem Management{NC}\n\n"
            f"  {BLD}1{NC}  {CYN}Show Filesystems{NC}    {DIM}Display currently mounted XFS filesystems{NC}\n"
            f"  {BLD}2{NC}  {CYN}Create Filesystem{NC}   {DIM}Create optimized XFS on xiRAID arrays{NC}\n"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_filesystems()
        elif key == "2":
            self._create_filesystem_wizard()

    # ── Show Filesystems ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _show_filesystems(self) -> None:
        """Display currently mounted XFS filesystems."""
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content("  Scanning filesystems...")

        ok, out, err = await run_async_cmd(
            "findmnt", "-t", "xfs", "-J", timeout=10
        )
        GRN, BLD, DIM, CYN, NC = "\033[32m", "\033[1m", "\033[2m", "\033[36m", "\033[0m"
        lines = [f"{BLD}{CYN}XFS Filesystems{NC}\n"]

        if not ok or not out:
            lines.append(f"  {DIM}No XFS filesystems found.{NC}")
            view.set_content("\n".join(lines))
            return

        try:
            data = json.loads(out)
            filesystems = data.get("filesystems", [])
            if not filesystems:
                lines.append(f"  {DIM}No XFS filesystems found.{NC}")
            for fs in filesystems:
                target = fs.get("target", "?")
                source = fs.get("source", "?")
                options = fs.get("options", "")
                lines.append(f"  {GRN}{target}{NC}")
                lines.append(f"    Device:  {source}")
                lines.append(f"    Options: {DIM}{options}{NC}")
                lines.append("")
        except (json.JSONDecodeError, KeyError) as exc:
            lines.append(f"  {DIM}(parse error: {exc}){NC}")

        view.set_content("\n".join(lines))

    # ── Create Filesystem Wizard ──────────────────────────────────────────

    @work(exclusive=True)
    async def _create_filesystem_wizard(self) -> None:
        """Multi-step wizard: validate arrays → pick data → pick log → label → mount → confirm → execute."""
        from xinas_menu.utils.xfs_helpers import (
            build_mount_options,
            calculate_stripe_width,
            check_existing_filesystem,
            create_mount_unit,
            mkfs_xfs,
            mount_filesystem,
        )

        view = self.query_one("#fs-content", ScrollableTextView)

        # ── Pre-check: fetch RAID arrays ──────────────────────────────────
        ok, data, err = await self.app.grpc.raid_show(extended=True)
        if not ok:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Failed to query RAID arrays.\n{grpc_short_error(err)}",
                    "Error",
                )
            )
            return

        # Parse arrays
        arrays = _parse_arrays(data)
        if len(arrays) < 2:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Filesystem creation requires at least 2 RAID arrays\n"
                    f"(one for data, one for log).\n\n"
                    f"Currently {len(arrays)} array(s) found.\n\n"
                    f"Please create RAID arrays first via Storage → RAID Management.",
                    "Cannot Create Filesystem",
                )
            )
            return

        # ── Step 1: Select DATA array ─────────────────────────────────────
        # Sort: data-suggested arrays first
        sorted_arrays = sorted(arrays, key=lambda a: 0 if _classify_role(a.get("level", "")) == "data" else 1)
        labels = [_array_label(a) for a in sorted_arrays]

        data_choice = await self.app.push_screen_wait(
            SelectDialog(
                labels,
                title="Create Filesystem — Step 1",
                prompt="Select DATA array (typically RAID-5/6):",
            )
        )
        if not data_choice:
            return

        data_idx = labels.index(data_choice)
        data_array = sorted_arrays[data_idx]
        data_name = data_array.get("name", "?")

        # ── Step 2: Select LOG array ──────────────────────────────────────
        remaining = [a for a in sorted_arrays if a.get("name") != data_name]
        remaining_sorted = sorted(remaining, key=lambda a: 0 if _classify_role(a.get("level", "")) == "log" else 1)
        remaining_labels = [_array_label(a) for a in remaining_sorted]

        if len(remaining_labels) == 1:
            # Only one option — auto-select and confirm
            log_array = remaining_sorted[0]
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Log array will be:\n\n  {_array_label(log_array)}\n\nProceed?",
                    "Create Filesystem — Step 2",
                )
            )
            if not confirmed:
                return
        else:
            log_choice = await self.app.push_screen_wait(
                SelectDialog(
                    remaining_labels,
                    title="Create Filesystem — Step 2",
                    prompt="Select LOG array (typically RAID-1/10):",
                )
            )
            if not log_choice:
                return
            log_idx = remaining_labels.index(log_choice)
            log_array = remaining_sorted[log_idx]

        log_name = log_array.get("name", "?")

        # ── Step 3: Filesystem label ──────────────────────────────────────
        label = await self.app.push_screen_wait(
            InputDialog(
                "Filesystem label:",
                "Create Filesystem — Step 3",
                default="nfsdata",
                placeholder="nfsdata",
            )
        )
        if not label:
            return

        # ── Step 4: Mount point ───────────────────────────────────────────
        mountpoint = await self.app.push_screen_wait(
            InputDialog(
                "Mount point path:",
                "Create Filesystem — Step 4",
                default="/mnt/data",
                placeholder="/mnt/data",
            )
        )
        if not mountpoint or not mountpoint.startswith("/"):
            if mountpoint:
                self.app.notify("Mount point must be an absolute path.", severity="error")
            return

        # ── Calculate XFS parameters ──────────────────────────────────────
        data_device = f"/dev/xi_{data_name}"
        log_device = f"/dev/xi_{log_name}"

        data_devices = data_array.get("devices", [])
        data_dev_count = len(data_devices) if isinstance(data_devices, list) else 0
        data_level = str(data_array.get("level", "5"))
        strip_size = data_array.get("strip_size", 128)
        try:
            su_kb = int(strip_size)
        except (ValueError, TypeError):
            su_kb = 128

        sw = calculate_stripe_width(data_dev_count, data_level)
        mount_opts = build_mount_options(log_device)

        # ── Step 5: Confirmation ──────────────────────────────────────────
        summary = (
            f"Create XFS Filesystem?\n\n"
            f"  Label:          {label}\n"
            f"  Data Array:     {data_name} (RAID-{data_level}, /dev/xi_{data_name})\n"
            f"  Log Array:      {log_name} (RAID-{log_array.get('level', '?')}, /dev/xi_{log_name})\n"
            f"  Mount Point:    {mountpoint}\n"
            f"\n"
            f"  XFS Parameters:\n"
            f"    su (strip unit):   {su_kb} KB\n"
            f"    sw (stripe width): {sw}\n"
            f"    sector size:       4k\n"
            f"    log size:          1G (capped to device)\n"
            f"\n"
            f"  Mount Options:\n"
            f"    {mount_opts}\n"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(summary, "Confirm Filesystem Creation")
        )
        if not confirmed:
            return

        # ── Execute ───────────────────────────────────────────────────────
        view.set_content("  Creating filesystem...")

        # Check existing filesystem
        fs_type, fs_label = await check_existing_filesystem(data_device)
        if fs_type:
            warn_confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"WARNING: {data_device} already has a {fs_type} filesystem"
                    f"{f' labeled {chr(34)}{fs_label}{chr(34)}' if fs_label else ''}.\n\n"
                    f"This will DESTROY all existing data.\n\nContinue?",
                    "⚠ Existing Filesystem",
                )
            )
            if not warn_confirmed:
                view.set_content("  Filesystem creation cancelled.")
                return

        # Run mkfs.xfs
        view.set_content(f"  Running mkfs.xfs on {data_device}...")
        ok, out, err = await mkfs_xfs(
            label=label,
            data_device=data_device,
            log_device=log_device,
            su_kb=su_kb,
            sw=sw,
            sector_size="4k",
            log_size="1G",
        )
        if not ok:
            await self.app.push_screen_wait(
                ConfirmDialog(f"mkfs.xfs failed:\n\n{err}", "Error")
            )
            view.set_content(f"\033[31m  mkfs.xfs failed.\033[0m")
            return

        # Create systemd mount unit
        view.set_content(f"  Creating mount unit for {mountpoint}...")
        ok, err = await create_mount_unit(mountpoint, data_device, log_device, mount_opts)
        if not ok:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to create mount unit:\n\n{err}", "Error")
            )
            view.set_content(f"\033[31m  Mount unit creation failed.\033[0m")
            return

        # Enable and start mount
        view.set_content(f"  Mounting {mountpoint}...")
        ok, err = await mount_filesystem(mountpoint)
        if not ok:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to mount filesystem:\n\n{err}", "Error")
            )
            view.set_content(f"\033[31m  Mount failed.\033[0m")
            return

        # Success
        self.app.audit.log(
            "fs.create",
            f"label={label} data={data_device} log={log_device} mount={mountpoint}",
            "OK",
        )
        GRN, BLD, NC = "\033[32m", "\033[1m", "\033[0m"
        view.set_content(
            f"{BLD}{GRN}Filesystem created successfully!{NC}\n\n"
            f"  Label:       {label}\n"
            f"  Data:        {data_device}\n"
            f"  Log:         {log_device}\n"
            f"  Mounted at:  {mountpoint}\n"
            f"  Mount opts:  {mount_opts}\n"
        )
        self.app.notify("Filesystem created and mounted successfully!", severity="information")


def _parse_arrays(data: Any) -> list[dict]:
    """Parse raid_show response into a list of array dicts."""
    if isinstance(data, list):
        return [a for a in data if isinstance(a, dict)]
    if isinstance(data, dict):
        result = []
        for name, arr in data.items():
            if isinstance(arr, dict):
                arr.setdefault("name", name)
                result.append(arr)
        return result
    return []
