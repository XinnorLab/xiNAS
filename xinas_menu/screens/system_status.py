"""SystemStatusScreen — dashboard mirroring xinas-status MOTD."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Refresh"),
    MenuItem("0", "Back"),
]


class SystemStatusScreen(Screen):
    """System status dashboard — mirrors xinas-status MOTD output."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  System Status", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="status-nav")
            yield ScrollableTextView("  Loading...", id="status-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_status()
        self._auto_refresh = self.set_interval(10, self._refresh_status)

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._refresh_status()

    @work(exclusive=True)
    async def _refresh_status(self) -> None:
        view = self.query_one("#status-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        text = await loop.run_in_executor(None, _run_xinas_status)

        if text:
            view.set_content(text)
        else:
            fallback = await loop.run_in_executor(None, _build_fallback_status)
            view.set_content(fallback)

        try:
            ok, info, err = await asyncio.wait_for(
                self.app.grpc.get_server_info(), timeout=5,
            )
            if ok:
                view.append(f"\n  xiRAID: connected\n{_format_server_info(info)}")
            else:
                view.append(f"\n  xiRAID: {grpc_short_error(err)}")
        except asyncio.TimeoutError:
            view.append("\n  xiRAID: timed out")
        except Exception:
            _log.debug("gRPC server_info failed", exc_info=True)


def _run_xinas_status() -> str:
    """Run xinas-status if available and return its colored output."""
    xinas_status = shutil.which("xinas-status")
    if not xinas_status:
        return ""
    try:
        env = {**os.environ}
        env.setdefault("TERM", "xterm-256color")
        r = subprocess.run(
            ["bash", xinas_status],
            capture_output=True, text=True, timeout=10,
            env=env,
        )
        raw = r.stdout or r.stderr or ""
        if raw.strip():
            return raw
    except Exception:
        _log.debug("xinas-status failed", exc_info=True)
    return ""


def _build_fallback_status() -> str:
    """Build status from /proc, sysfs, etc. when xinas-status is not installed."""
    GRN, YLW, RED, CYN, BLD, DIM, NC = (
        "\033[32m", "\033[33m", "\033[31m", "\033[36m",
        "\033[1m", "\033[2m", "\033[0m",
    )
    lines: list[str] = [f"{BLD}{CYN}System Status{NC}\n"]

    # System info
    try:
        import platform
        lines.append(f"  {DIM}Hostname:{NC}  {GRN}{platform.node()}{NC}")
        lines.append(f"  {DIM}Kernel:{NC}    {platform.release()}")
    except Exception:
        pass

    # Uptime
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        days, rem = divmod(int(secs), 86400)
        hours, rem = divmod(rem, 3600)
        lines.append(f"  {DIM}Uptime:{NC}    {days}d {hours}h {rem // 60}m")
    except Exception:
        pass

    # NFS threads
    try:
        with open("/proc/fs/nfsd/threads") as f:
            threads = f.read().strip()
        lines.append(f"  {DIM}NFS Threads:{NC} {threads}")
    except Exception:
        pass

    lines.append("")

    # Resources
    lines.append(f"  {BLD}RESOURCES{NC}")
    try:
        with open("/proc/loadavg") as f:
            la = f.read().split()
        lines.append(f"  {DIM}Load:{NC}  {la[0]}  {la[1]}  {la[2]}")
    except Exception:
        pass

    try:
        with open("/proc/meminfo") as f:
            meminfo = {}
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    meminfo[parts[0].strip()] = parts[1].strip()
        total_kb = int(meminfo.get("MemTotal", "0 kB").split()[0])
        avail_kb = int(meminfo.get("MemAvailable", "0 kB").split()[0])
        used_kb = total_kb - avail_kb
        pct = (used_kb * 100 // total_kb) if total_kb else 0
        bar_len = 20
        filled = pct * bar_len // 100
        bar = f"{'█' * filled}{'░' * (bar_len - filled)}"
        color = GRN if pct < 70 else (YLW if pct < 90 else RED)
        lines.append(
            f"  {DIM}Memory:{NC} {color}{bar}{NC}  {pct}%  "
            f"({used_kb // 1048576:.1f} / {total_kb // 1048576:.1f} GB)"
        )
    except Exception:
        pass

    lines.append("")

    # Network
    lines.append(f"  {BLD}NETWORK{NC}")
    try:
        from pathlib import Path as _Path
        net_dir = _Path("/sys/class/net")
        for iface in sorted(net_dir.iterdir()):
            name = iface.name
            if name == "lo":
                continue
            try:
                state = (iface / "operstate").read_text().strip()
            except Exception:
                state = "unknown"
            icon = f"{GRN}●{NC}" if state == "up" else f"{RED}○{NC}"

            try:
                speed = (iface / "speed").read_text().strip()
                speed_str = f"{int(speed) // 1000}G" if int(speed) >= 1000 else f"{speed}M"
            except Exception:
                speed_str = "?"

            try:
                r = subprocess.run(
                    ["ip", "-4", "-o", "addr", "show", name],
                    capture_output=True, text=True, timeout=2,
                )
                m = re.search(r"inet\s+(\S+)", r.stdout)
                ip_str = m.group(1) if m else "no IP"
            except Exception:
                ip_str = "no IP"

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

            lines.append(f"  {icon} {name:<16} {DIM}{badge}{NC}  {ip_str:<20} {speed_str}")
    except Exception:
        pass

    lines.append("")

    # Services
    lines.append(f"  {BLD}SERVICES{NC}")
    try:
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        for svc in ("xiraid-server", "nfs-server", "xinas-nfs-helper", "xinas-mcp"):
            st = ctl.state(svc)
            if st.is_active:
                lines.append(f"  {GRN}●{NC} {svc:<28} {GRN}{st.active}{NC}")
            else:
                lines.append(f"  {RED}○{NC} {svc:<28} {RED}{st.active}{NC}")
    except Exception:
        pass

    return "\n".join(lines)


def _format_server_info(info) -> str:
    try:
        if isinstance(info, dict):
            lic = info.get("license")
            if lic:
                return f"  License: {lic}"
            return ""
        return f"  {info}"
    except Exception:
        return ""
