"""ClientMainMenuScreen -- top-level navigation with mini-status pane."""
from __future__ import annotations

import asyncio
import logging
import platform
import re
import shutil
import subprocess

from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_ITEMS = [
    MenuItem("1", "System Status"),
    MenuItem("2", "Connect to NAS"),
    MenuItem("3", "Advanced Settings"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Exit"),
]

# ANSI colour shortcuts for the mini-status pane
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"


class ClientMainMenuScreen(Screen):
    """Root navigation screen for the xiNAS client."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=True, key_display="0/Esc"),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  xiNAS Client Console", id="main-prompt")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="main-nav")
            yield ScrollableTextView("  Loading status\u2026", id="main-status")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_status()
        self._auto_refresh = self.set_interval(15, self._refresh_status)

    def on_screen_resume(self) -> None:
        """Refresh status when returning from a submenu."""
        self._refresh_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.exit()
        elif key == "1":
            from xinas_client.screens.system_status import SystemStatusScreen

            self.app.push_screen(SystemStatusScreen())
        elif key == "2":
            from xinas_client.screens.mount_wizard import MountWizardScreen

            self.app.push_screen(MountWizardScreen())
        elif key == "3":
            from xinas_client.screens.advanced import AdvancedSettingsScreen

            self.app.push_screen(AdvancedSettingsScreen())

    def action_exit_app(self) -> None:
        self.app.exit()

    @work(exclusive=True)
    async def _refresh_status(self) -> None:
        """Build the mini-status pane in a background thread."""
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, _build_mini_status)
        try:
            view = self.query_one("#main-status", ScrollableTextView)
            view.set_content(text)
        except Exception:
            _log.debug("mini-status: view not available", exc_info=True)


# -- Mini-status builder (runs in thread) ------------------------------------


def _build_mini_status() -> str:
    """Collect system, NFS, RDMA, and network info for the status pane."""
    lines: list[str] = []

    # -- System ---------------------------------------------------------------
    lines.append(f"  {_BLD}{_CYN}System{_NC}")

    hostname = platform.node() or "unknown"
    lines.append(f"  {_DIM}Hostname:{_NC}  {hostname}")

    kernel = platform.release()
    lines.append(f"  {_DIM}Kernel:{_NC}    {kernel}")

    uptime = _get_uptime()
    if uptime:
        lines.append(f"  {_DIM}Uptime:{_NC}    {uptime}")

    lines.append("")

    # -- NFS Mounts -----------------------------------------------------------
    lines.append(f"  {_BLD}{_CYN}NFS Mounts{_NC}")

    mounts = _active_nfs_mounts()
    if not mounts:
        lines.append(f"  {_DIM}No active NFS mounts{_NC}")
    else:
        lines.append(f"  {_DIM}Active:{_NC}    {len(mounts)}")
        for server, remote_path, local_path in mounts:
            usage = _mount_usage(local_path)
            if usage:
                used, total, pct = usage
                color = _GRN if pct < 80 else (_YLW if pct < 90 else _RED)
                bar_w = 10
                filled = round(pct / 100 * bar_w)
                bar = f"{color}{'\u2588' * filled}{'\u2591' * (bar_w - filled)}{_NC}"
                lines.append(
                    f"  {color}\u25cf{_NC} {server}:{remote_path}"
                )
                lines.append(
                    f"    {_DIM}\u2514{_NC} {local_path}  {bar}  {pct:>3}%  "
                    f"{_DIM}({used} / {total}){_NC}"
                )
            else:
                lines.append(
                    f"  {_GRN}\u25cf{_NC} {server}:{remote_path}"
                )
                lines.append(
                    f"    {_DIM}\u2514{_NC} {local_path}"
                )

    lines.append("")

    # -- RDMA Status ----------------------------------------------------------
    lines.append(f"  {_BLD}{_CYN}RDMA Status{_NC}")

    ib_path = Path("/sys/class/infiniband")
    if ib_path.exists():
        try:
            devices = sorted(d.name for d in ib_path.iterdir())
        except Exception:
            devices = []

        if devices:
            lines.append(f"  {_GRN}\u25cf{_NC} RDMA available")
            for dev in devices:
                lines.append(f"    {_DIM}\u2514{_NC} {dev}")
        else:
            lines.append(f"  {_YLW}\u25cb{_NC} RDMA module loaded, no devices")
    else:
        lines.append(f"  {_RED}\u25cb{_NC} RDMA not available")

    lines.append("")

    # -- Network Interfaces ---------------------------------------------------
    lines.append(f"  {_BLD}{_CYN}Network Interfaces{_NC}")

    try:
        net_dir = Path("/sys/class/net")
        for iface in sorted(net_dir.iterdir()):
            name = iface.name
            if name == "lo":
                continue

            # Link state
            try:
                state = (iface / "operstate").read_text().strip()
            except Exception:
                state = "unknown"
            icon = f"{_GRN}\u25cf{_NC}" if state == "up" else f"{_RED}\u25cb{_NC}"

            # Speed
            try:
                speed = int((iface / "speed").read_text().strip())
                speed_str = f"{speed // 1000}G" if speed >= 1000 else f"{speed}M"
            except Exception:
                speed_str = "\u2014"

            # IP address
            try:
                r = subprocess.run(
                    ["ip", "-4", "-o", "addr", "show", name],
                    capture_output=True, text=True, timeout=2,
                )
                m = re.search(r"inet\s+(\S+)", r.stdout)
                ip_str = m.group(1) if m else "no IP"
            except Exception:
                ip_str = "no IP"

            # Driver badge
            badge = "ETH"
            try:
                driver = (iface / "device" / "driver").resolve().name
                if "mlx" in driver:
                    badge = "RDMA"
            except Exception:
                pass
            try:
                itype = (iface / "type").read_text().strip()
                if itype == "32":
                    badge = "IB"
            except Exception:
                pass

            lines.append(
                f"  {icon} {name:<14} {_DIM}{badge:>4}{_NC}  "
                f"{ip_str:<20} {speed_str}"
            )
    except Exception:
        _log.debug("mini-status: network scan failed", exc_info=True)

    lines.append("")

    # -- Components -----------------------------------------------------------
    lines.append(f"  {_BLD}{_CYN}Components{_NC}")

    nfs_tool = shutil.which("mount.nfs4")
    if nfs_tool:
        lines.append(f"  {_GRN}\u25cf{_NC} NFS tools   installed")
    else:
        lines.append(f"  {_RED}\u25cb{_NC} NFS tools   {_RED}missing{_NC}")

    doca_installed = (
        Path("/usr/bin/ofed_info").exists()
        or Path("/usr/sbin/ofed_info").exists()
    )
    if doca_installed:
        lines.append(f"  {_GRN}\u25cf{_NC} DOCA        installed")
    else:
        lines.append(f"  {_YLW}\u25cb{_NC} DOCA        {_DIM}not installed{_NC}")

    return "\n".join(lines)


# -- Helpers ------------------------------------------------------------------


def _get_uptime() -> str:
    """Return a human-readable uptime string, or empty on failure."""
    try:
        with open("/proc/uptime") as f:
            secs = int(float(f.read().split()[0]))
        days, rem = divmod(secs, 86400)
        hours, rem = divmod(rem, 3600)
        mins, _ = divmod(rem, 60)
        parts: list[str] = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        parts.append(f"{mins}m")
        return " ".join(parts)
    except Exception:
        return ""


def _active_nfs_mounts() -> list[tuple[str, str, str]]:
    """Return list of (server, remote_path, local_path) for active NFS4 mounts."""
    mounts: list[tuple[str, str, str]] = []
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 3 and parts[2] in ("nfs", "nfs4"):
                    source = parts[0]  # e.g. 10.0.0.1:/export
                    local = parts[1]
                    if ":" in source:
                        server, remote = source.split(":", 1)
                    else:
                        server, remote = source, ""
                    mounts.append((server, remote, local))
    except Exception:
        pass
    return mounts


def _mount_usage(path: str) -> tuple[str, str, int] | None:
    """Return (used, total, percent_int) for a mount path, or None."""
    try:
        r = subprocess.run(
            ["df", "-h", path], capture_output=True, text=True, timeout=3,
        )
        if r.returncode == 0:
            parts = r.stdout.strip().splitlines()[-1].split()
            if len(parts) >= 5:
                pct = int(parts[4].rstrip("%"))
                return (parts[2], parts[1], pct)
    except Exception:
        pass
    return None
