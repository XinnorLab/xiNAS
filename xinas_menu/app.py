"""XiNASApp — root Textual application for xinas-menu."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import ClassVar

_log = logging.getLogger(__name__)

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.reactive import reactive

from xinas_menu.api.grpc_client import XiRAIDClient
from xinas_menu.api.nfs_client import NFSHelperClient
from xinas_menu.utils.audit import AuditLogger
from xinas_menu.utils.snapshot_helper import SnapshotHelper
from xinas_menu.utils.update_check import CheckResult, UpdateChecker, build_rebuild_cmd
from xinas_menu.widgets.alert_bar import AlertBar
from xinas_menu.widgets.header import XiNASHeader
from xinas_menu.widgets.status_footer import StatusFooter

__all__ = ["XiNASApp"]


class XiNASApp(App):
    """Main management application (post-deploy xinas-menu)."""

    CSS_PATH: ClassVar[Path] = Path(__file__).parent / "styles.tcss"

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
        Binding("ctrl+y", "copy_content", "Copy output", show=True),
        Binding("u", "check_update", "Check updates", show=True),
        Binding("?", "help", "Help", show=True),
        Binding("pageup", "scroll_up", "Scroll", show=True, key_display="PgUp/Dn"),
        Binding("pagedown", "scroll_down", "Scroll", show=False),
    ]

    update_available: reactive[bool] = reactive(False)

    def __init__(
        self,
        no_welcome: bool = False,
        grpc_address: str = "localhost:6066",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._no_welcome = no_welcome
        self.grpc = XiRAIDClient(grpc_address)
        self.nfs = NFSHelperClient()
        self.audit = AuditLogger()
        self.snapshots = SnapshotHelper(grpc_address=grpc_address)
        self._update_checker = UpdateChecker()
        self._last_check_result: CheckResult | None = None

    def compose(self) -> ComposeResult:
        yield XiNASHeader()
        yield AlertBar()
        yield StatusFooter()

    async def on_mount(self) -> None:
        from xinas_menu.screens.main_menu import MainMenuScreen
        from xinas_menu.screens.welcome import WelcomeScreen

        if self._no_welcome:
            await self.push_screen(MainMenuScreen())
        else:
            await self.push_screen(WelcomeScreen())

        # Background update check
        task = asyncio.create_task(self._bg_update_check())
        task.add_done_callback(
            lambda t: t.exception() if not t.cancelled() and t.exception() else None
        )

        # Background license monitor
        lic_task = asyncio.create_task(self._bg_license_check())
        lic_task.add_done_callback(
            lambda t: t.exception() if not t.cancelled() and t.exception() else None
        )

        # Background NFS service monitor
        nfs_task = asyncio.create_task(self._bg_nfs_check())
        nfs_task.add_done_callback(
            lambda t: t.exception() if not t.cancelled() and t.exception() else None
        )

    async def _bg_update_check(self) -> None:
        try:
            result = await self._update_checker.check()
            if result.error:
                _log.debug("background update check failed: %s", result.error)
                return
            self._last_check_result = result
            if result.available:
                self.update_available = True
                header = self.query_one(XiNASHeader)
                header.update_available = True
        except Exception:
            _log.debug("background update check failed", exc_info=True)

    async def _bg_license_check(self) -> None:
        """Periodically check license status and update AlertBar + StatusFooter."""
        alert_bar = self.query_one(AlertBar)
        status_footer = self.query_one(StatusFooter)
        while True:
            try:
                ok, data, err = await asyncio.wait_for(
                    self.grpc.license_show(),
                    timeout=5,
                )
                if not ok:
                    alert_bar.set_alert(
                        "license",
                        "error",
                        "License check failed — xiRAID not reachable",
                    )
                    status_footer.set_issue("license", "xiRAID not reachable")
                elif isinstance(data, dict):
                    status = str(data.get("status", "")).lower()
                    if status == "valid":
                        alert_bar.clear_alert("license")
                        status_footer.clear_issue("license")
                    elif status == "expired":
                        alert_bar.set_alert(
                            "license",
                            "error",
                            "xiRAID license has expired",
                        )
                        status_footer.set_issue("license", "License expired")
                    elif status == "invalid":
                        alert_bar.set_alert(
                            "license",
                            "error",
                            "xiRAID license is invalid",
                        )
                        status_footer.set_issue("license", "License invalid")
                    else:
                        alert_bar.set_alert(
                            "license",
                            "warning",
                            f"License status: {status}",
                        )
                        status_footer.set_issue("license", f"License: {status}")
                else:
                    alert_bar.set_alert(
                        "license",
                        "warning",
                        "License status unknown",
                    )
                    status_footer.set_issue("license", "License unknown")
            except asyncio.TimeoutError:
                alert_bar.set_alert(
                    "license",
                    "warning",
                    "License check timed out",
                )
                status_footer.set_issue("license", "License check timed out")
            except Exception:
                _log.debug("bg license check failed", exc_info=True)

            await asyncio.sleep(60)

    async def _bg_nfs_check(self) -> None:
        """Periodically check NFS service status and update AlertBar + StatusFooter."""
        alert_bar = self.query_one(AlertBar)
        status_footer = self.query_one(StatusFooter)
        while True:
            try:
                loop = asyncio.get_running_loop()
                state = await loop.run_in_executor(None, self._check_nfs_state)
                if state.load != "loaded":
                    # Service not installed — not an issue
                    alert_bar.clear_alert("nfs")
                    status_footer.clear_issue("nfs")
                elif state.is_active:
                    alert_bar.clear_alert("nfs")
                    status_footer.clear_issue("nfs")
                else:
                    msg = f"NFS service {state.active}"
                    alert_bar.set_alert("nfs", "error", msg)
                    status_footer.set_issue("nfs", msg)
            except Exception:
                _log.debug("bg nfs check failed", exc_info=True)

            await asyncio.sleep(30)

    @staticmethod
    def _check_nfs_state():
        from xinas_menu.utils.service_ctl import ServiceController

        return ServiceController().state("nfs-server")

    def watch_update_available(self, value: bool) -> None:
        try:
            header = self.query_one(XiNASHeader)
            header.update_available = value
        except Exception:
            _log.debug("could not update header badge", exc_info=True)

    @work(exclusive=True)
    async def action_check_update(self) -> None:
        if not self.update_available:
            return
        result = self._last_check_result
        if result is None or not result.available:
            return
        await self.prompt_and_apply_update(result)

    async def prompt_and_apply_update(self, result: CheckResult) -> None:
        """Confirm with the user, then run ``_apply_update(result)``.

        The dialog message reflects whether the incoming commits include
        a ``Requires-Rebuild:`` trailer — see CLAUDE.md "Update rebuild
        markers". When no rebuild is required we promise the user a
        zero-ansible update; when one is required we name the affected
        roles so they know what is about to re-run.
        """
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
        confirmed = await self.push_screen_wait(ConfirmDialog(msg, "Update Available"))
        if confirmed:
            await self._apply_update(result)

    async def _apply_update(self, result: CheckResult | None = None) -> None:
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

    def action_copy_content(self) -> None:
        """Copy the visible content panel text to clipboard (Ctrl+Y)."""
        from xinas_menu.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            text = view.get_text()
            if text:
                self._do_copy(text)
        except Exception:
            _log.debug("copy content failed (no text view on screen?)", exc_info=True)

    def _do_copy(self, text: str) -> None:
        """Send *text* to the clipboard with a recovery file.

        Thin delegate to the shared, app-generic implementation in
        ``xinas_menu.clipboard`` (hoisted so the Confirm/TextArea dialogs'
        copy action also works under StartupApp).
        """
        from xinas_menu.clipboard import copy_with_recovery

        copy_with_recovery(self, text)

    def action_scroll_up(self) -> None:
        """Scroll the content panel up."""
        from xinas_menu.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            log = view.query_one("#text-view-area")
            log.scroll_page_up()
        except Exception:
            _log.debug("scroll up failed (no text view on screen?)", exc_info=True)

    def action_scroll_down(self) -> None:
        """Scroll the content panel down."""
        from xinas_menu.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            log = view.query_one("#text-view-area")
            log.scroll_page_down()
        except Exception:
            _log.debug("scroll down failed (no text view on screen?)", exc_info=True)

    def action_help(self) -> None:
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog

        self.push_screen(
            ConfirmDialog(
                "xiNAS Management Console\n\n"
                "Arrow keys / number keys — navigate\n"
                "Enter — select\n"
                "0 or Esc — back\n"
                "PgUp / PgDn — scroll output panel\n"
                "U — check for updates\n"
                "Ctrl+Y — copy output to clipboard\n"
                "         (also saved to ~/.xinas/clipboard.txt if your\n"
                "         terminal doesn't support OSC 52 — e.g. Apple Terminal)\n"
                "Ctrl+C — quit",
                "Help",
                ok_only=True,
            )
        )

    async def on_unmount(self) -> None:
        await self.grpc.close()
