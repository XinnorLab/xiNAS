"""QuickActionsScreen — system status, restart NFS, logs, disk health, services."""
from __future__ import annotations

import asyncio
import subprocess

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_RED = "\033[31m"
_GRN = "\033[32m"
_YLW = "\033[33m"
_CYN = "\033[36m"
_BLD = "\033[1m"
_DIM = "\033[2m"
_NC = "\033[0m"

_MENU = [
    MenuItem("1", "Restart NFS Server"),
    MenuItem("2", "View System Logs"),
    MenuItem("3", "Service Status"),
    MenuItem("4", "System Monitor (btop)"),
    MenuItem("5", "View Audit Log"),
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

    def compose(self) -> ComposeResult:
        yield Label("  Quick Actions", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="qa-nav")
            yield ScrollableTextView(id="qa-content")
        yield Footer()

    def on_mount(self) -> None:
        BLD, DIM, CYN, NC = "\033[1m", "\033[2m", "\033[36m", "\033[0m"
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content(
            f"{BLD}{CYN}Quick Actions{NC}\n"
            f"\n"
            f"  {BLD}1{NC}  {CYN}Restart NFS{NC}       {DIM}Restart NFS server (disconnects clients){NC}\n"
            f"  {BLD}2{NC}  {CYN}System Logs{NC}       {DIM}View recent journalctl entries{NC}\n"
            f"  {BLD}3{NC}  {CYN}Service Status{NC}    {DIM}Check all xiNAS service states{NC}\n"
            f"  {BLD}4{NC}  {CYN}System Monitor{NC}    {DIM}Launch btop interactive monitor{NC}\n"
            f"  {BLD}5{NC}  {CYN}Audit Log{NC}         {DIM}View xiNAS audit trail{NC}\n"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._restart_nfs()
        elif key == "2":
            self._view_logs()
        elif key == "3":
            self._service_status()
        elif key == "4":
            self._system_monitor()
        elif key == "5":
            self._view_audit_log()

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
        view = self.query_one("#qa-content", ScrollableTextView)
        if ok:
            self.app.audit.log("service.restart", "nfs-server", "OK")
            view.set_content(f"{_GRN}NFS server restarted.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")

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


