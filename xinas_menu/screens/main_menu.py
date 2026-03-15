"""MainMenuScreen — top-level navigation (4 groups + Exit) with mini-status."""
from __future__ import annotations

import asyncio
import logging
import platform
import re
import subprocess

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_ITEMS = [
    MenuItem("1", "System"),
    MenuItem("2", "Storage"),
    MenuItem("3", "Network"),
    MenuItem("4", "Management"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Exit"),
]

# ANSI colour shortcuts for the mini-status pane
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"


class MainMenuScreen(Screen):
    """Root navigation screen — routes to group submenus."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=True, key_display="0/Esc"),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  xiNAS Management Console", id="main-prompt")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="main-nav")
            yield ScrollableTextView("  Loading status…", id="main-status")
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
            from xinas_menu.screens.system import SystemScreen
            self.app.push_screen(SystemScreen())
        elif key == "2":
            from xinas_menu.screens.storage import StorageScreen
            self.app.push_screen(StorageScreen())
        elif key == "3":
            from xinas_menu.screens.network import NetworkScreen
            self.app.push_screen(NetworkScreen())
        elif key == "4":
            from xinas_menu.screens.management import ManagementScreen
            self.app.push_screen(ManagementScreen())

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


# ── Mini-status builder (runs in thread) ────────────────────────────────


def _build_mini_status() -> str:
    """Collect NFS status, network info, and client instructions."""
    lines: list[str] = []

    # ── NFS Service Status ──────────────────────────────────────
    lines.append(f"  {_BLD}{_CYN}NFS Service{_NC}")
    try:
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        st = ctl.state("nfs-server")
        if st.is_active:
            lines.append(f"  {_GRN}●{_NC} nfs-server   {_GRN}{st.active}{_NC}")
        else:
            lines.append(f"  {_RED}○{_NC} nfs-server   {_RED}{st.active}{_NC}")
    except Exception:
        _log.debug("mini-status: nfs-server check failed", exc_info=True)
        lines.append(f"  {_DIM}nfs-server   unknown{_NC}")

    # NFS threads
    try:
        with open("/proc/fs/nfsd/threads") as f:
            threads = f.read().strip()
        lines.append(f"  {_DIM}Threads:{_NC}     {threads}")
    except Exception:
        pass

    # Active NFS clients
    try:
        r = subprocess.run(
            ["ss", "-tn", "state", "established", "( dport = :2049 )"],
            capture_output=True, text=True, timeout=3,
        )
        client_lines = [l for l in r.stdout.splitlines() if l.strip() and not l.startswith("State")]
        lines.append(f"  {_DIM}Clients:{_NC}     {len(client_lines)}")
    except Exception:
        pass

    # NFS exports
    try:
        r = subprocess.run(
            ["exportfs", "-s"], capture_output=True, text=True, timeout=3,
        )
        exports = [l.split()[0] for l in r.stdout.splitlines() if l.strip()]
        if exports:
            lines.append(f"  {_DIM}Exports:{_NC}     {len(exports)}")
            for exp in exports[:4]:
                lines.append(f"    {_DIM}•{_NC} {exp}")
            if len(exports) > 4:
                lines.append(f"    {_DIM}  … +{len(exports) - 4} more{_NC}")
    except Exception:
        pass

    lines.append("")

    # ── Network Interfaces ──────────────────────────────────────
    lines.append(f"  {_BLD}{_CYN}Network Interfaces{_NC}")
    try:
        from pathlib import Path
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
            icon = f"{_GRN}●{_NC}" if state == "up" else f"{_RED}○{_NC}"

            # Speed
            try:
                speed = int((iface / "speed").read_text().strip())
                speed_str = f"{speed // 1000}G" if speed >= 1000 else f"{speed}M"
            except Exception:
                speed_str = "—"

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

    # ── Client Connection Instructions ──────────────────────────
    lines.append(f"  {_BLD}{_CYN}Client Connection{_NC}")

    # Detect hostname / first routable IP
    hostname = platform.node() or "this-server"
    server_ip = _first_routable_ip() or hostname

    lines.append(f"  {_DIM}To connect NFS clients, run on the client:{_NC}")
    lines.append("")
    lines.append(f"  {_BLD}1.{_NC} Install the client package:")
    lines.append(f"     {_GRN}sudo apt install xinas-client{_NC}")
    lines.append("")
    lines.append(f"  {_BLD}2.{_NC} Run the setup wizard:")
    lines.append(f"     {_GRN}sudo xinas-client setup {server_ip}{_NC}")
    lines.append("")
    lines.append(f"  {_DIM}Or mount manually:{_NC}")
    lines.append(f"     {_GRN}mount -t nfs -o vers=4.2,proto=rdma,port=20049 \\")
    lines.append(f"       {server_ip}:/export /mnt/xinas{_NC}")

    return "\n".join(lines)


def _first_routable_ip() -> str:
    """Return the first non-loopback IPv4 address, or empty string."""
    try:
        r = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            capture_output=True, text=True, timeout=2,
        )
        m = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", r.stdout)
        return m.group(1) if m else ""
    except Exception:
        return ""
