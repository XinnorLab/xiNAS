"""NetworkScreen -- network settings submenu with interface inspection."""
from __future__ import annotations

import asyncio
import logging
import re
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
from xinas_client.widgets.select_dialog import SelectDialog
from xinas_client.utils.network_utils import get_interfaces

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "View Network Config"),
    MenuItem("2", "View Interface Details"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


class NetworkScreen(Screen):
    """Network settings submenu with split-panel layout."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Network Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="network-nav")
            yield ScrollableTextView("  Loading\u2026", id="network-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_config()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_config()
        elif key == "2":
            self._pick_interface()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── View Network Config ───────────────────────────────────────────

    @work(exclusive=True)
    async def _show_config(self) -> None:
        view = self.query_one("#network-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_config_view)
        except Exception:
            _log.debug("network config build failed", exc_info=True)
            text = f"  {_RED}Error reading network configuration{_NC}"
        view.set_content(text)

    # ── View Interface Details ────────────────────────────────────────

    @work(exclusive=True)
    async def _pick_interface(self) -> None:
        loop = asyncio.get_running_loop()
        ifaces = await loop.run_in_executor(None, get_interfaces)

        if not ifaces:
            view = self.query_one("#network-content", ScrollableTextView)
            view.set_content(f"  {_DIM}No network interfaces detected.{_NC}")
            return

        labels = [iface["name"] for iface in ifaces]
        selected = await self.app.push_screen_wait(
            SelectDialog(labels, title="Select Interface")
        )
        if selected is None:
            return

        # Find the selected interface
        try:
            idx = labels.index(selected)
        except ValueError:
            return
        iface_name = ifaces[idx]["name"]

        view = self.query_one("#network-content", ScrollableTextView)
        try:
            text = await loop.run_in_executor(None, _build_detail_view, iface_name)
        except Exception:
            _log.debug("interface detail build failed", exc_info=True)
            text = f"  {_RED}Error reading interface details{_NC}"
        view.set_content(text)


# ── Text builders (run in executor threads) ───────────────────────────


def _speed_str(speed: int) -> str:
    """Format link speed for display."""
    if speed >= 1000:
        return f"{_GRN}{speed // 1000}Gb/s{_NC}"
    if speed > 0:
        return f"{_YLW}{speed}Mb/s{_NC}"
    return f"{_DIM}---{_NC}"


def _build_config_view() -> str:
    """Build the overview text showing all network interfaces."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}NETWORK INTERFACES{_NC}")
    lines.append(rule)
    lines.append("")

    ifaces = get_interfaces()
    if not ifaces:
        lines.append(f"  {_DIM}No network interfaces detected.{_NC}")
        return "\n".join(lines)

    # Header
    lines.append(
        f"  {_DIM}{'NAME':<16} {'TYPE':<6} {'IP ADDRESS':<22} "
        f"{'SPEED':<12} {'STATE'}{_NC}"
    )
    lines.append(f"  {_DIM}{'─' * 70}{_NC}")

    for iface in ifaces:
        name = iface["name"]
        state = iface["state"]
        speed = iface["speed"]
        ip = iface["ip"] or f"{_DIM}no IP{_NC}"
        badge = iface["driver_badge"]

        if state == "up":
            icon = f"{_GRN}\u25b2{_NC}"
            state_str = f"{_GRN}UP{_NC}"
        else:
            icon = f"{_RED}\u25bc{_NC}"
            state_str = f"{_RED}DOWN{_NC}"

        lines.append(
            f"  {icon} {name:<15} {_DIM}{badge:<5}{_NC} {ip:<21} "
            f"{_speed_str(speed):<20} {state_str}"
        )

    lines.append("")
    lines.append(f"  {_DIM}Select [2] to view detailed interface information.{_NC}")
    lines.append("")

    return "\n".join(lines)


def _build_detail_view(name: str) -> str:
    """Build detailed information for a single interface."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"
    iface_path = Path("/sys/class/net") / name

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}INTERFACE: {name}{_NC}")
    lines.append(rule)
    lines.append("")

    # IP address (with prefix/netmask)
    ip_addr = ""
    try:
        r = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", name],
            capture_output=True, text=True, timeout=2,
        )
        m = re.search(r"inet\s+(\S+)", r.stdout)
        if m:
            ip_addr = m.group(1)
    except Exception:
        pass
    lines.append(f"  {_DIM}IP Address:{_NC}    {ip_addr or 'not configured'}")

    # Netmask (extract from CIDR or ip addr output)
    if ip_addr and "/" in ip_addr:
        try:
            prefix = int(ip_addr.split("/")[1])
            mask_int = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
            netmask = ".".join(
                str((mask_int >> (24 - i * 8)) & 0xFF) for i in range(4)
            )
            lines.append(f"  {_DIM}Netmask:{_NC}       {netmask} (/{prefix})")
        except (ValueError, IndexError):
            pass

    # MAC address
    try:
        mac = (iface_path / "address").read_text().strip()
        lines.append(f"  {_DIM}MAC Address:{_NC}   {mac}")
    except OSError:
        pass

    lines.append("")

    # Driver
    try:
        driver = (iface_path / "device" / "driver").resolve().name
        lines.append(f"  {_DIM}Driver:{_NC}        {driver}")
    except (OSError, ValueError):
        lines.append(f"  {_DIM}Driver:{_NC}        unknown")

    # Speed
    try:
        speed = int((iface_path / "speed").read_text().strip())
        if speed >= 1000:
            lines.append(f"  {_DIM}Speed:{_NC}         {_GRN}{speed // 1000}Gb/s{_NC} ({speed} Mb/s)")
        elif speed > 0:
            lines.append(f"  {_DIM}Speed:{_NC}         {_YLW}{speed}Mb/s{_NC}")
        else:
            lines.append(f"  {_DIM}Speed:{_NC}         ---")
    except (OSError, ValueError):
        lines.append(f"  {_DIM}Speed:{_NC}         ---")

    # MTU
    try:
        mtu = (iface_path / "mtu").read_text().strip()
        lines.append(f"  {_DIM}MTU:{_NC}           {mtu}")
    except OSError:
        pass

    # operstate
    try:
        state = (iface_path / "operstate").read_text().strip()
        if state == "up":
            lines.append(f"  {_DIM}State:{_NC}         {_GRN}UP{_NC}")
        else:
            lines.append(f"  {_DIM}State:{_NC}         {_RED}{state.upper()}{_NC}")
    except OSError:
        pass

    # Interface type badge
    badge = "Ethernet"
    try:
        drv = (iface_path / "device" / "driver").resolve().name
        if "mlx" in drv:
            badge = "RDMA-capable (Mellanox)"
    except (OSError, ValueError):
        pass
    try:
        itype = (iface_path / "type").read_text().strip()
        if itype == "32":
            badge = "InfiniBand"
    except OSError:
        pass
    lines.append(f"  {_DIM}Type:{_NC}          {badge}")

    # ── Statistics ────────────────────────────────────────────────────
    stats_dir = iface_path / "statistics"
    if stats_dir.is_dir():
        lines.append("")
        lines.append(f"  {_BLD}Statistics{_NC}")
        lines.append(f"  {_DIM}{'─' * 40}{_NC}")

        stat_files = [
            ("rx_bytes", "RX Bytes"),
            ("tx_bytes", "TX Bytes"),
            ("rx_packets", "RX Packets"),
            ("tx_packets", "TX Packets"),
            ("rx_errors", "RX Errors"),
            ("tx_errors", "TX Errors"),
            ("rx_dropped", "RX Dropped"),
            ("tx_dropped", "TX Dropped"),
            ("collisions", "Collisions"),
        ]

        for stat_file, label in stat_files:
            try:
                val = int((stats_dir / stat_file).read_text().strip())
                if stat_file.endswith("_bytes"):
                    val_str = _human_bytes(val)
                else:
                    val_str = f"{val:,}"
                # Highlight errors/drops in red if non-zero
                if ("error" in stat_file or "drop" in stat_file) and val > 0:
                    lines.append(f"  {_DIM}{label + ':':<16}{_NC} {_RED}{val_str}{_NC}")
                else:
                    lines.append(f"  {_DIM}{label + ':':<16}{_NC} {val_str}")
            except (OSError, ValueError):
                pass

    lines.append("")
    return "\n".join(lines)


def _human_bytes(b: int) -> str:
    """Convert bytes to human-readable string."""
    if b >= 1_073_741_824:
        return f"{b / 1_073_741_824:.2f} GB"
    if b >= 1_048_576:
        return f"{b / 1_048_576:.2f} MB"
    if b >= 1024:
        return f"{b / 1024:.2f} KB"
    return f"{b} B"
