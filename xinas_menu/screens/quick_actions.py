"""QuickActionsScreen — system status, restart NFS, logs, disk health, services."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.service_badge import ServiceBadge
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Show System Status"),
    MenuItem("2", "Restart NFS Server"),
    MenuItem("3", "View System Logs"),
    MenuItem("4", "Check Disk Health"),
    MenuItem("5", "Service Status"),
    MenuItem("6", "System Monitor (btop)"),
    MenuItem("7", "View Audit Log"),
    MenuItem("0", "Back"),
]

_SERVICES = [
    "nfs-server",
    "xiraid-server",
    "xiraid-exporter",
    "xinas-nfs-helper",
    "xinas-mcp",
    "nfsdcld",
    "rpcbind",
]


class QuickActionsScreen(Screen):
    """Quick system actions and status views."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self, show_status: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._show_status = show_status

    def compose(self) -> ComposeResult:
        yield Label("  Quick Actions", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="qa-nav")
            yield ScrollableTextView(id="qa-content")
        yield Footer()

    def on_mount(self) -> None:
        if self._show_status:
            self._system_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._system_status()
        elif key == "2":
            self._restart_nfs()
        elif key == "3":
            self._view_logs()
        elif key == "4":
            self._disk_health()
        elif key == "5":
            self._service_status()
        elif key == "6":
            self._system_monitor()
        elif key == "7":
            self._view_audit_log()

    @work(exclusive=True)
    async def _system_status(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Loading system status...")
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, _collect_system_status)
        view.set_content(text)
        try:
            ok, info, err = await asyncio.wait_for(
                self.app.grpc.get_server_info(), timeout=5,
            )
        except asyncio.TimeoutError:
            ok, info, err = False, None, "timed out"
        if ok:
            view.append(f"\n  xiRAID: connected\n{_format_server_info(info)}")
        else:
            view.append(f"\n  xiRAID: {_grpc_short_error(err)}")

    @work(exclusive=True)
    async def _restart_nfs(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart NFS server? Active mounts may disconnect.", "Restart NFS")
        )
        if not confirmed:
            return
        loop = asyncio.get_running_loop()
        from xinas_menu.utils.service_ctl import service_restart
        ok, err = await loop.run_in_executor(None, lambda: service_restart("nfs-server"))
        if ok:
            self.app.audit.log("service.restart", "nfs-server", "OK")
            await self.app.push_screen_wait(ConfirmDialog("NFS server restarted.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
    async def _view_logs(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Loading logs...")
        loop = asyncio.get_running_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["journalctl", "-n", "50", "--no-pager"],
                capture_output=True, text=True,
            )
        )
        BLD, CYN, NC = "\033[1m", "\033[36m", "\033[0m"
        text = f"{BLD}{CYN}=== Recent System Messages ==={NC}\n\n" + (r.stdout or "(no entries)")
        view.set_content(text)

    @work(exclusive=True)
    async def _disk_health(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Scanning drives...")
        ok, data, err = await self.app.grpc.disk_list()
        if not ok:
            view.set_content(f"\033[31m  Error: {err}\033[0m")
            return

        GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}{CYN}Drive Summary{NC}\n"]
        try:
            disks = data if isinstance(data, list) else []
            if not disks:
                lines.append(f"  {DIM}(no drives found){NC}")
            for d in disks:
                name = d.get("name", "?") if isinstance(d, dict) else str(d)
                model = (d.get("model", "") if isinstance(d, dict) else "").strip()
                size = d.get("size", "?") if isinstance(d, dict) else "?"
                raid_name = d.get("raid_name", "") if isinstance(d, dict) else ""
                member_state = d.get("member_state", "") if isinstance(d, dict) else ""
                transport = d.get("transport", "") if isinstance(d, dict) else ""
                ms = member_state.lower()
                if ms == "online":
                    sc = GRN
                elif ms in ("degraded", "rebuilding"):
                    sc = YLW
                elif ms in ("offline", "failed"):
                    sc = RED
                else:
                    sc = ""
                role = f"({raid_name}) {sc}{member_state}{NC}" if raid_name else f"{DIM}unassigned{NC}"
                lines.append(f"  {GRN}{name}{NC}  {model}  {size}  {transport}  {role}")
        except Exception as exc:
            lines.append(f"  {RED}(parse error: {exc}){NC}")
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _service_status(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Checking services...")
        loop = asyncio.get_running_loop()
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        GRN, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}{CYN}=== Service Status ==={NC}", ""]
        for svc in _SERVICES:
            state = await loop.run_in_executor(None, lambda s=svc: ctl.state(s))
            if state.is_active:
                icon = f"{GRN}*{NC}"
                status = f"{GRN}{state.active}{NC}"
            else:
                icon = f"{RED}o{NC}"
                status = f"{RED}{state.active}{NC}"
            lines.append(f"  {icon}  {svc:<30} {status}")
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _system_monitor(self) -> None:
        """Launch btop if available, otherwise show top output snapshot."""
        view = self.query_one("#qa-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        has_btop = await loop.run_in_executor(
            None, lambda: subprocess.run(["which", "btop"], capture_output=True).returncode == 0
        )
        if has_btop:
            view.set_content("Launching btop -- press q to return to menu.")
            await loop.run_in_executor(None, lambda: subprocess.run(["btop"]))
            self._system_status()
        else:
            view.set_content("btop is not installed.\n\nInstall with: sudo apt-get install btop")

    @work(exclusive=True)
    async def _view_audit_log(self) -> None:
        from xinas_menu.utils.audit import AUDIT_LOG
        view = self.query_one("#qa-content", ScrollableTextView)
        try:
            lines = AUDIT_LOG.read_text().splitlines()[-200:]
            view.set_content("\n".join(lines) or "  Audit log is empty.")
        except FileNotFoundError:
            view.set_content("  Audit log not found.")
        except Exception as exc:
            view.set_content(f"  Error: {exc}")


def _collect_system_status() -> str:
    """Run xinas-status if available and return its output with colors preserved."""
    import os
    import shutil

    xinas_status = shutil.which("xinas-status")
    if xinas_status:
        try:
            env = {**os.environ}
            env.setdefault("TERM", "xterm-256color")
            r = subprocess.run(
                ["bash", xinas_status],
                capture_output=True, text=True, timeout=5,
                env=env,
            )
            raw = r.stdout or r.stderr or ""
            if raw.strip():
                return raw
        except Exception:
            pass

    GRN, CYN, BLD, DIM, NC = "\033[32m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    # Fallback — basic info
    lines: list[str] = [f"{BLD}System Status{NC}\n{DIM}{'=' * 50}{NC}\n"]
    try:
        import platform
        lines.append(f"  {DIM}Hostname:{NC}  {GRN}{platform.node()}{NC}")
        lines.append(f"  {DIM}OS:{NC}        {platform.system()} {platform.release()}")
    except Exception:
        pass
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        days, rem = divmod(int(secs), 86400)
        hours, rem = divmod(rem, 3600)
        lines.append(f"  {DIM}Uptime:{NC}    {days}d {hours}h {rem // 60}m")
    except Exception:
        pass
    try:
        total, used, _ = shutil.disk_usage("/")
        lines.append(f"  {DIM}Root disk:{NC} {used // 2**30}G used / {total // 2**30}G total")
    except Exception:
        pass
    try:
        with open("/proc/loadavg") as f:
            la = f.read().split()
        lines.append(f"  {DIM}Load:{NC}      {la[0]}  {la[1]}  {la[2]}")
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


def _grpc_short_error(err: str) -> str:
    """Extract a human-readable one-liner from a verbose gRPC error string."""
    import re
    if not err:
        return "not connected"
    if "UNAVAILABLE" in err or "Connection refused" in err or "failed to connect" in err.lower():
        return "not connected  (xiRAID service unavailable)"
    if "UNAUTHENTICATED" in err:
        return "authentication failed"
    if "DEADLINE_EXCEEDED" in err or "Deadline" in err:
        return "timed out"
    if "stubs not available" in err:
        return err
    m = re.search(r'details\s*=\s*["\']([^"\']{1,120})', err)
    if m:
        return m.group(1)
    first_line = err.splitlines()[0] if err else err
    return first_line[:100] if len(first_line) > 100 else first_line
