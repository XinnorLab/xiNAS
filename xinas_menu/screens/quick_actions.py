"""QuickActionsScreen — system status, restart NFS, logs, disk health, services."""

from __future__ import annotations

import asyncio
import subprocess

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.apptype import XiNASAppMixin
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


def _services() -> list[str]:
    """Units listed on the Service Status view.

    The xiRAID exporter unit is resolved at call time rather than hardcoded —
    the .deb spells it with an underscore, older builds with a hyphen.
    """
    from xinas_menu.utils.service_ctl import xiraid_exporter_unit

    return [
        "nfs-server",
        "xiraid-server",
        xiraid_exporter_unit(),
        "xinas-nfs-helper",
        "xinas-api",
        "xinas-agent",
        "nfsdcld",
        "rpcbind",
    ]


class QuickActionsScreen(XiNASAppMixin, Screen):
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
                capture_output=True,
                text=True,
            ),
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
        GRN, RED, CYN, BLD, _DIM, NC = (
            "\033[32m",
            "\033[31m",
            "\033[36m",
            "\033[1m",
            "\033[2m",
            "\033[0m",
        )
        lines = [f"{BLD}{CYN}=== Service Status ==={NC}", ""]
        for svc in await loop.run_in_executor(None, _services):
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
        """Unified audit view: local audit.log merged with the control-path
        ``GET /audit`` trail (share/RAID/network/MCP activity). See
        docs/Management/audit-log-spec.md."""
        from xinas_menu.api.control_client import ControlPathError
        from xinas_menu.utils.audit import AUDIT_LOG
        from xinas_menu.utils.audit_view import merge_audit

        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Loading audit log...")
        loop = asyncio.get_running_loop()

        # Local trail (TUI-direct actions: users, service restart, updates).
        def _read_local() -> list[str] | None:
            try:
                return AUDIT_LOG.read_text().splitlines()
            except FileNotFoundError:
                return None

        local_lines = await loop.run_in_executor(None, _read_local)

        # Control-path trail (share.create, RAID, network — any client).
        control_rows: list[dict] = []
        control_note = ""
        try:
            result = await asyncio.to_thread(self.app.control.result, "/api/v1/audit?limit=200")
            if isinstance(result, list):
                control_rows = [r for r in result if isinstance(r, dict)]
        except ControlPathError as exc:
            control_note = f"  (control-path audit unavailable: {exc})"
        except Exception as exc:  # defensive: never break the view
            control_note = f"  (control-path audit error: {exc})"

        merged = merge_audit(local_lines or [], control_rows, limit=200)
        body = "\n".join(merged) if merged else "  Audit log is empty."
        if control_note:
            body = f"{body}\n\n{control_note}"
        view.set_content(body)
