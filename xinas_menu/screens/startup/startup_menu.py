"""StartupApp — provisioning/Ansible menu (replaces startup_menu.sh)."""
from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Footer

from xinas_menu.api.grpc_client import XiRAIDClient
from xinas_menu.api.nfs_client import NFSHelperClient
from xinas_menu.utils.audit import AuditLogger
from xinas_menu.utils.update_check import CheckResult, UpdateChecker, build_rebuild_cmd
from xinas_menu.widgets.header import XiNASHeader

_MENU_ITEMS_MAIN = [
    ("1", "Collect System Data"),
    ("2", "Enter License"),
    ("3", "Install"),
    ("4", "Advanced Settings"),
    ("0", "Exit"),
]


class StartupApp(App):
    """Provisioning app (xinas-setup / startup_menu.sh replacement)."""

    CSS_PATH: ClassVar[Path] = Path(__file__).parent.parent.parent / "styles.tcss"

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.grpc = XiRAIDClient()
        self.nfs = NFSHelperClient()
        self.audit = AuditLogger()
        self._update_checker = UpdateChecker()

    def compose(self) -> ComposeResult:
        yield XiNASHeader()
        yield Footer()

    async def on_mount(self) -> None:
        from xinas_menu.screens.startup._startup_main import StartupMainScreen
        await self.push_screen(StartupMainScreen())

    async def prompt_and_apply_update(self, result: CheckResult) -> None:
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        rebuilds = result.required_rebuilds
        if rebuilds:
            what = "the full site.yml" if rebuilds == ("all",) else ", ".join(rebuilds)
            msg = (
                "An update is available.\n\n"
                f"⚠ This update requires re-applying Ansible: {what}\n\n"
                "Apply update and run Ansible now?"
            )
        else:
            msg = "An update is available (no system rebuild required). Apply now?"
        if await self.push_screen_wait(ConfirmDialog(msg, "Update Available")):
            await self._apply_update(result)

    async def _apply_update(self, result: CheckResult | None = None) -> None:
        import asyncio
        loop = asyncio.get_running_loop()
        ok, msg = await loop.run_in_executor(None, self._update_checker.apply_update)
        if not ok:
            self.notify(f"Update failed: {msg}", severity="error")
            return
        self.audit.log("system.update", "git pull succeeded")
        rebuilds = result.required_rebuilds if result else ()
        cmd = build_rebuild_cmd(rebuilds)
        if cmd:
            from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen
            self.audit.log("system.update", f"rebuild required: {' '.join(cmd)}")
            rc = await self.push_screen_wait(
                PlaybookRunScreen(cmd=cmd, title="Applying update — Ansible rebuild")
            )
            if rc != 0:
                self.notify(
                    "Update applied but Ansible failed — not restarting. "
                    "Review the log and re-run the role manually.",
                    severity="error",
                    timeout=15,
                )
                return
        self.audit.log("system.update", "complete — restarting")
        self._update_checker.restart_self()

    async def on_unmount(self) -> None:
        await self.grpc.close()
