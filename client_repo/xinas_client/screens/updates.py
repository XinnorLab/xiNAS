"""UpdateCheckScreen -- check for and apply xiNAS client updates."""
from __future__ import annotations

import asyncio
import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog
from xinas_client.utils.update_check import UpdateChecker

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Check for Updates"),
    MenuItem("2", "Apply Update"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}Update Manager{_NC}
  {_CYN}{'─' * 60}{_NC}

  {_BLD}[1]{_NC} Check for Updates
  {_DIM}    Fetch from upstream and compare with local version{_NC}

  {_BLD}[2]{_NC} Apply Update
  {_DIM}    Pull the latest changes and restart the client{_NC}
"""


class UpdateCheckScreen(Screen):
    """Check for and apply xiNAS client updates."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._checker = UpdateChecker()
        self._update_available = False

    def compose(self) -> ComposeResult:
        yield Label("  Check for Updates", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="update-nav")
            yield ScrollableTextView(_HELP_TEXT, id="update-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._check_updates()
        elif key == "2":
            self._apply_update()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── [1] Check for Updates ────────────────────────────────────────

    @work(exclusive=True)
    async def _check_updates(self) -> None:
        view = self.query_one("#update-content", ScrollableTextView)

        rule = f"  {_CYN}{'─' * 60}{_NC}"
        view.set_content(
            f"\n{rule}\n"
            f"  {_BLD}Checking for Updates{_NC}\n"
            f"{rule}\n\n"
            f"  {_DIM}Fetching from upstream repository...{_NC}\n"
        )

        try:
            available = await self._checker.check()
            self._update_available = available
        except Exception as exc:
            _log.debug("update check failed", exc_info=True)
            view.append(
                f"  {_RED}[FAIL]{_NC} Error checking for updates: {exc}\n\n"
                f"  {_DIM}Ensure the repository has a configured remote.{_NC}"
            )
            return

        if available:
            view.append(
                f"  {_GRN}\u25cf{_NC} {_BLD}Update available!{_NC}\n\n"
                f"  {_DIM}A newer version is available upstream.{_NC}\n"
                f"  {_DIM}Select [2] \"Apply Update\" to install it.{_NC}"
            )
        else:
            view.append(
                f"  {_GRN}\u25cf{_NC} {_BLD}Up to date{_NC}\n\n"
                f"  {_DIM}You are running the latest version.{_NC}"
            )

        # Show current version if available
        try:
            from xinas_client.version import __version__
            view.append(f"\n  {_DIM}Current version: {__version__}{_NC}")
        except Exception:
            pass

    # ── [2] Apply Update ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _apply_update(self) -> None:
        view = self.query_one("#update-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        if not self._update_available:
            # Run a quick check first
            try:
                available = await self._checker.check()
                self._update_available = available
            except Exception:
                pass

            if not self._update_available:
                view.set_content(
                    f"  {_DIM}No update available.{_NC}\n\n"
                    f"  {_DIM}Run \"Check for Updates\" first, or you are "
                    f"already on the latest version.{_NC}"
                )
                return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Apply the available update?\n\n"
                "This will pull the latest changes from upstream\n"
                "and restart the client application.",
                "Apply Update",
            )
        )
        if not confirmed:
            return

        rule = f"  {_CYN}{'─' * 60}{_NC}"
        view.set_content(
            f"\n{rule}\n"
            f"  {_BLD}Applying Update{_NC}\n"
            f"{rule}\n\n"
            f"  {_DIM}Pulling latest changes...{_NC}\n"
        )

        try:
            ok, message = await loop.run_in_executor(
                None, self._checker.apply_update
            )
        except Exception as exc:
            _log.debug("update apply failed", exc_info=True)
            view.append(f"  {_RED}[FAIL]{_NC} Error applying update: {exc}")
            return

        if ok:
            view.append(f"  {_GRN}[OK]{_NC}   Update applied successfully")
            if message.strip():
                for line in message.strip().splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")

            view.append(
                f"\n  {_BLD}Restarting client...{_NC}"
            )

            # Brief delay so the user sees the message before restart
            await asyncio.sleep(1.5)

            try:
                UpdateChecker.restart_self()
            except Exception as exc:
                _log.debug("restart failed", exc_info=True)
                view.append(
                    f"\n  {_YLW}[WARN]{_NC} Auto-restart failed: {exc}\n"
                    f"  {_DIM}Please restart the client manually.{_NC}"
                )
        else:
            view.append(f"  {_RED}[FAIL]{_NC} Update failed: {message}")
            view.append(
                f"\n  {_DIM}You may need to resolve conflicts manually.{_NC}"
            )
