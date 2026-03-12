"""QuickActionsScreen — system status, restart NFS, logs, disk health, services."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.service_badge import ServiceBadge
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "System Status"),
    MenuItem("2", "Restart NFS"),
    MenuItem("3", "View System Logs"),
    MenuItem("4", "Disk Health (SMART)"),
    MenuItem("5", "Service Status"),
    MenuItem("6", "View Audit Log"),
    MenuItem("0", "Back"),
]

_SERVICES = [
    "xiraid-server",
    "nfs-server",
    "xinas-nfs-helper",
    "xinas-mcp",
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
        yield Label("  ── Quick Actions ──", id="screen-title")
        yield NavigableMenu(_MENU, id="qa-nav")
        yield ScrollableTextView(id="qa-content")

    def on_mount(self) -> None:
        if self._show_status:
            asyncio.create_task(self._system_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._system_status())
        elif key == "2":
            asyncio.create_task(self._restart_nfs())
        elif key == "3":
            asyncio.create_task(self._view_logs())
        elif key == "4":
            asyncio.create_task(self._disk_health())
        elif key == "5":
            asyncio.create_task(self._service_status())
        elif key == "6":
            asyncio.create_task(self._view_audit_log())

    async def _system_status(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        loop = asyncio.get_event_loop()
        # Show basic status immediately — don't wait for gRPC
        text = await loop.run_in_executor(None, _collect_system_status)
        view.set_content(text)
        # Append gRPC info when available (may take a moment)
        ok, info, err = await self.app.grpc.get_server_info()
        if ok:
            view.append(f"\n[bold]xiRAID Server Info[/bold]\n{_format_server_info(info)}")
        else:
            view.append(f"\n[yellow]xiRAID: {err[:80]}[/yellow]")

    async def _restart_nfs(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart NFS server? Active mounts may disconnect.", "Restart NFS")
        )
        if not confirmed:
            return
        loop = asyncio.get_event_loop()
        from xinas_menu.utils.service_ctl import service_restart
        ok, err = await loop.run_in_executor(None, lambda: service_restart("nfs-server"))
        if ok:
            self.app.audit.log("service.restart", "nfs-server", "OK")
            await self.app.push_screen_wait(ConfirmDialog("NFS server restarted.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _view_logs(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        loop = asyncio.get_event_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["journalctl", "-n", "100", "--no-pager", "-u", "nfs-server",
                 "-u", "xiraid-server"],
                capture_output=True, text=True,
            )
        )
        view.set_content(r.stdout or "[dim]No log entries.[/dim]")

    async def _disk_health(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("[dim]Scanning drives…[/dim]")
        ok, data, err = await self.app.grpc.disk_list()
        if not ok:
            view.set_content(f"[red]{err}[/red]")
            return

        lines = ["[bold]Drive Summary[/bold]\n"]
        try:
            disks = data if isinstance(data, list) else []
            if not disks:
                lines.append("  (no drives found)")
            for d in disks:
                name = d.get("name", "?") if isinstance(d, dict) else str(d)
                model = (d.get("model", "") if isinstance(d, dict) else "").strip()
                size = d.get("size", "?") if isinstance(d, dict) else "?"
                raid_name = d.get("raid_name", "") if isinstance(d, dict) else ""
                member_state = d.get("member_state", "") if isinstance(d, dict) else ""
                transport = d.get("transport", "") if isinstance(d, dict) else ""
                role = f"[{raid_name}] {member_state}" if raid_name else "unassigned"
                color = "green" if raid_name else "cyan"
                lines.append(f"  [{color}]{name}[/{color}]  {model}  {size}  {transport}  {role}")
        except Exception as exc:
            lines.append(f"[dim](parse error: {exc})[/dim]")
        view.set_content("\n".join(lines))

    async def _service_status(self) -> None:
        loop = asyncio.get_event_loop()
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        lines = ["[bold]Service Status[/bold]\n"]
        for svc in _SERVICES:
            state = await loop.run_in_executor(None, lambda s=svc: ctl.state(s))
            color = "green" if state.is_active else "red"
            lines.append(f"  [{color}]●[/{color}] {svc:<35} {state.active}")
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    async def _view_audit_log(self) -> None:
        from xinas_menu.utils.audit import AUDIT_LOG
        view = self.query_one("#qa-content", ScrollableTextView)
        try:
            lines = AUDIT_LOG.read_text().splitlines()[-200:]
            view.set_content("\n".join(lines) or "[dim]Audit log is empty.[/dim]")
        except FileNotFoundError:
            view.set_content("[dim]Audit log not found.[/dim]")
        except Exception as exc:
            view.set_content(f"[red]{exc}[/red]")


def _collect_system_status() -> str:
    import os
    lines = ["[bold]System Status[/bold]\n"]
    try:
        import platform
        lines.append(f"  Hostname:  {platform.node()}")
        lines.append(f"  OS:        {platform.system()} {platform.release()}")
    except Exception:
        pass
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        days, rem = divmod(int(secs), 86400)
        hours, rem = divmod(rem, 3600)
        mins = rem // 60
        lines.append(f"  Uptime:    {days}d {hours}h {mins}m")
    except Exception:
        pass
    try:
        import shutil
        total, used, free = shutil.disk_usage("/")
        lines.append(f"  Root disk: {used//2**30}G used / {total//2**30}G total")
    except Exception:
        pass
    return "\n".join(lines)


def _format_server_info(info) -> str:
    try:
        if isinstance(info, dict):
            lic = info.get("license")
            if lic:
                return f"  License: {lic}"
            return "  Connected"
        return f"  {info}"
    except Exception:
        return "  Connected"
