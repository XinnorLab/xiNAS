"""ManageMountsScreen -- list, view, unmount, and remount active NFS mounts."""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from dataclasses import dataclass, field

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog
from xinas_client.widgets.select_dialog import SelectDialog

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Select Mount"),
    MenuItem("2", "Refresh"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


@dataclass
class _MountInfo:
    """Parsed NFS mount entry."""

    mount_point: str = ""
    server: str = ""
    share_path: str = ""
    fs_type: str = ""
    options: str = ""
    protocol: str = "TCP"
    # Populated by df
    df_used: str = ""
    df_total: str = ""
    df_avail: str = ""
    df_pct: str = ""


class ManageMountsScreen(Screen):
    """List, inspect, unmount, or remount active NFS mounts."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._mounts: list[_MountInfo] = []

    def compose(self) -> ComposeResult:
        yield Label("  Manage NFS Mounts", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="mounts-nav")
            yield ScrollableTextView("  Scanning mounts\u2026", id="mounts-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_mounts()

    def on_screen_resume(self) -> None:
        self._refresh_mounts()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._select_mount()
        elif key == "2":
            self._refresh_mounts()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── Refresh ───────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _refresh_mounts(self) -> None:
        view = self.query_one("#mounts-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            mounts = await loop.run_in_executor(None, _get_nfs_mounts)
        except Exception:
            _log.debug("mount scan failed", exc_info=True)
            mounts = []
        self._mounts = mounts
        view.set_content(_build_mount_summary(mounts))

    # ── Select / Action ───────────────────────────────────────────────

    @work(exclusive=True)
    async def _select_mount(self) -> None:
        if not self._mounts:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No active NFS mounts found.",
                    "No Mounts",
                    ok_only=True,
                )
            )
            return

        # Let user pick a mount point
        labels = [
            f"{m.server}:{m.share_path}  \u2192  {m.mount_point}"
            for m in self._mounts
        ]
        selected = await self.app.push_screen_wait(
            SelectDialog(labels, title="Select Mount")
        )
        if selected is None:
            return

        # Find selected mount
        try:
            idx = labels.index(selected)
        except ValueError:
            return
        mount = self._mounts[idx]

        # Action sub-menu
        action = await self.app.push_screen_wait(
            SelectDialog(
                ["View Details", "Unmount", "Remount", "Back"],
                title=f"Action: {mount.mount_point}",
            )
        )
        if action is None or action == "Back":
            return

        if action == "View Details":
            await self._show_details(mount)
        elif action == "Unmount":
            await self._unmount(mount)
        elif action == "Remount":
            await self._remount(mount)

    async def _show_details(self, mount: _MountInfo) -> None:
        """Show full mount details in the text view."""
        view = self.query_one("#mounts-content", ScrollableTextView)
        view.set_content(_build_detail_view(mount))

    async def _unmount(self, mount: _MountInfo) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Unmount {mount.mount_point}?\n\n"
                f"Server: {mount.server}:{mount.share_path}\n"
                f"Protocol: {mount.protocol}",
                "Confirm Unmount",
            )
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        rc, out, err = await loop.run_in_executor(
            None, _run_umount, mount.mount_point
        )

        if rc == 0:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Successfully unmounted {mount.mount_point}",
                    "Unmount Complete",
                    ok_only=True,
                )
            )
        else:
            msg = err.strip() or out.strip() or f"umount exited with code {rc}"
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Failed to unmount {mount.mount_point}:\n\n{msg}",
                    "Unmount Failed",
                    ok_only=True,
                )
            )

        # Refresh mount list
        self._refresh_mounts()

    async def _remount(self, mount: _MountInfo) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Remount {mount.mount_point}?\n\n"
                f"This will re-apply mount options.",
                "Confirm Remount",
            )
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        rc, out, err = await loop.run_in_executor(
            None, _run_remount, mount.mount_point
        )

        if rc == 0:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Successfully remounted {mount.mount_point}",
                    "Remount Complete",
                    ok_only=True,
                )
            )
        else:
            msg = err.strip() or out.strip() or f"mount exited with code {rc}"
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Failed to remount {mount.mount_point}:\n\n{msg}",
                    "Remount Failed",
                    ok_only=True,
                )
            )

        # Refresh mount list
        self._refresh_mounts()


# ── Helpers (run in executor threads) ─────────────────────────────────


def _get_nfs_mounts() -> list[_MountInfo]:
    """Parse active NFS mounts from ``mount -t nfs,nfs4``."""
    mounts: list[_MountInfo] = []
    try:
        r = subprocess.run(
            ["mount", "-t", "nfs,nfs4"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return mounts
    except Exception:
        _log.debug("mount command failed", exc_info=True)
        return mounts

    # Format: server:/path on /mount/point type nfs4 (opts)
    for line in r.stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        m = _MountInfo()
        parts = line.split()
        if len(parts) < 5:
            continue

        source = parts[0]  # server:/share
        m.mount_point = parts[2]
        m.fs_type = parts[4] if len(parts) > 4 else "nfs"

        if ":" in source:
            m.server, m.share_path = source.split(":", 1)
        else:
            m.server = source
            m.share_path = ""

        # Extract options from parentheses
        opts_match = re.search(r"\(([^)]+)\)", line)
        m.options = opts_match.group(1) if opts_match else ""

        # Determine protocol
        if "rdma" in m.options.lower():
            m.protocol = "RDMA"
        else:
            m.protocol = "TCP"

        # Disk usage
        try:
            df_r = subprocess.run(
                ["df", "-h", m.mount_point],
                capture_output=True, text=True, timeout=3,
            )
            if df_r.returncode == 0:
                df_lines = df_r.stdout.strip().splitlines()
                if len(df_lines) >= 2:
                    df_parts = df_lines[-1].split()
                    if len(df_parts) >= 5:
                        m.df_total = df_parts[1]
                        m.df_used = df_parts[2]
                        m.df_avail = df_parts[3]
                        m.df_pct = df_parts[4]
        except Exception:
            pass

        mounts.append(m)

    return mounts


def _run_umount(mount_point: str) -> tuple[int, str, str]:
    """Run ``umount <mount_point>``. Returns (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["umount", mount_point],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "umount timed out after 30 seconds"
    except Exception as exc:
        return 1, "", str(exc)


def _run_remount(mount_point: str) -> tuple[int, str, str]:
    """Run ``mount -o remount <mount_point>``. Returns (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["mount", "-o", "remount", mount_point],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "mount -o remount timed out after 30 seconds"
    except Exception as exc:
        return 1, "", str(exc)


# ── Text builders ─────────────────────────────────────────────────────


def _build_mount_summary(mounts: list[_MountInfo]) -> str:
    """Build the overview text for all active NFS mounts."""
    lines: list[str] = []

    rule = f"  {_CYN}{'─' * 60}{_NC}"
    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}ACTIVE NFS MOUNTS{_NC}")
    lines.append(rule)
    lines.append("")

    if not mounts:
        lines.append(f"  {_DIM}No active NFS mounts found.{_NC}")
        lines.append("")
        lines.append(f"  {_DIM}Use \"Connect to NAS\" from the main menu")
        lines.append(f"  to mount an NFS share.{_NC}")
        return "\n".join(lines)

    lines.append(f"  {_DIM}Found {len(mounts)} mount(s).  Select [1] to manage.{_NC}")
    lines.append("")

    for i, m in enumerate(mounts, 1):
        proto_color = _GRN if m.protocol == "RDMA" else _YLW
        lines.append(
            f"  {_GRN}\u25cf{_NC} {_BLD}{m.mount_point}{_NC}"
        )
        lines.append(
            f"    {_DIM}Source:{_NC}    {m.server}:{m.share_path}"
        )
        lines.append(
            f"    {_DIM}Protocol:{_NC}  {proto_color}{m.protocol}{_NC}"
        )
        if m.df_pct:
            lines.append(
                f"    {_DIM}Usage:{_NC}     {m.df_used} / {m.df_total} ({m.df_pct})"
            )
        lines.append("")

    return "\n".join(lines)


def _build_detail_view(mount: _MountInfo) -> str:
    """Build detailed info text for a single mount."""
    lines: list[str] = []

    rule = f"  {_CYN}{'─' * 60}{_NC}"
    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}MOUNT DETAILS{_NC}")
    lines.append(rule)
    lines.append("")

    proto_color = _GRN if mount.protocol == "RDMA" else _YLW

    lines.append(f"  {_DIM}Mount Point:{_NC}   {_BLD}{mount.mount_point}{_NC}")
    lines.append(f"  {_DIM}Server:{_NC}        {mount.server}")
    lines.append(f"  {_DIM}Share Path:{_NC}    {mount.share_path}")
    lines.append(f"  {_DIM}Type:{_NC}          {mount.fs_type}")
    lines.append(f"  {_DIM}Protocol:{_NC}      {proto_color}{mount.protocol}{_NC}")
    lines.append("")

    # Disk usage
    if mount.df_total:
        lines.append(f"  {_BLD}Disk Usage{_NC}")
        lines.append(f"  {_DIM}Total:{_NC}         {mount.df_total}")
        lines.append(f"  {_DIM}Used:{_NC}          {mount.df_used}")
        lines.append(f"  {_DIM}Available:{_NC}     {mount.df_avail}")
        lines.append(f"  {_DIM}Use%:{_NC}          {mount.df_pct}")
        lines.append("")

    # Mount options
    lines.append(f"  {_BLD}Mount Options{_NC}")
    if mount.options:
        for opt in mount.options.split(","):
            opt = opt.strip()
            if opt:
                lines.append(f"    {_DIM}\u2022{_NC} {opt}")
    else:
        lines.append(f"    {_DIM}(none){_NC}")

    lines.append("")
    return "\n".join(lines)
