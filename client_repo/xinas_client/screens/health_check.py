"""HealthCheckScreen -- run client health check profiles."""
from __future__ import annotations

import logging
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.input_dialog import InputDialog
from xinas_client.utils.subprocess_runner import stream_cmd

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Run Default Check"),
    MenuItem("2", "Run AI Training Profile"),
    MenuItem("3", "Run Custom Profile"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}Client Health Check{_NC}
  {_CYN}{'─' * 60}{_NC}

  {_BLD}[1]{_NC} Run Default Check
  {_DIM}    Standard NFS client health diagnostics{_NC}

  {_BLD}[2]{_NC} Run AI Training Profile
  {_DIM}    Checks optimized for GPU/RDMA AI workloads{_NC}

  {_BLD}[3]{_NC} Run Custom Profile
  {_DIM}    Specify a custom profile name to run{_NC}
"""


def _find_healthcheck_script() -> Path | None:
    """Locate the client_healthcheck.sh script."""
    candidates = [
        Path(__file__).resolve().parent.parent.parent / "client_healthcheck.sh",
        Path("/opt/xinas-client/client_healthcheck.sh"),
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


class HealthCheckScreen(Screen):
    """Run client health check diagnostics."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Client Health Check", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="health-nav")
            yield ScrollableTextView(_HELP_TEXT, id="health-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._run_profile("default")
        elif key == "2":
            self._run_profile("ai-training")
        elif key == "3":
            self._ask_custom_profile()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── Run a named profile ──────────────────────────────────────────

    @work(exclusive=True)
    async def _run_profile(self, profile: str) -> None:
        view = self.query_one("#health-content", ScrollableTextView)

        script = _find_healthcheck_script()
        if script is None:
            view.set_content(
                f"  {_RED}[FAIL]{_NC} client_healthcheck.sh not found.\n\n"
                f"  {_DIM}Searched:{_NC}\n"
                f"    {_DIM}\u2022 {Path(__file__).resolve().parent.parent.parent / 'client_healthcheck.sh'}{_NC}\n"
                f"    {_DIM}\u2022 /opt/xinas-client/client_healthcheck.sh{_NC}\n\n"
                f"  {_DIM}Ensure the script is installed.{_NC}"
            )
            return

        rule = f"  {_CYN}{'─' * 60}{_NC}"
        view.set_content(
            f"\n{rule}\n"
            f"  {_BLD}HEALTH CHECK: {profile}{_NC}\n"
            f"{rule}\n\n"
            f"  {_DIM}Running {script.name} --profile {profile}{_NC}\n"
        )

        cmd = ["bash", str(script), "--profile", profile]

        try:
            rc = await stream_cmd(cmd, view, cwd=str(script.parent))
        except Exception as exc:
            _log.debug("health check failed", exc_info=True)
            view.append(f"\n  {_RED}[FAIL]{_NC} Error running health check: {exc}")
            return

        view.append("")
        if rc == 0:
            view.append(f"  {_GRN}Health check completed successfully.{_NC}")
        else:
            view.append(
                f"  {_YLW}Health check finished with exit code {rc}.{_NC}"
            )
        view.append("")

    # ── Custom profile ───────────────────────────────────────────────

    @work(exclusive=True)
    async def _ask_custom_profile(self) -> None:
        profile = await self.app.push_screen_wait(
            InputDialog(
                "Enter the health check profile name:",
                title="Custom Profile",
                placeholder="e.g. gpu-only, network, storage",
            )
        )
        if not profile or not profile.strip():
            return
        await self._run_profile_inner(profile.strip())

    async def _run_profile_inner(self, profile: str) -> None:
        """Shared implementation for running a profile (called from custom)."""
        view = self.query_one("#health-content", ScrollableTextView)

        script = _find_healthcheck_script()
        if script is None:
            view.set_content(
                f"  {_RED}[FAIL]{_NC} client_healthcheck.sh not found.\n"
                f"  {_DIM}Ensure the script is installed.{_NC}"
            )
            return

        rule = f"  {_CYN}{'─' * 60}{_NC}"
        view.set_content(
            f"\n{rule}\n"
            f"  {_BLD}HEALTH CHECK: {profile}{_NC}\n"
            f"{rule}\n\n"
            f"  {_DIM}Running {script.name} --profile {profile}{_NC}\n"
        )

        cmd = ["bash", str(script), "--profile", profile]

        try:
            rc = await stream_cmd(cmd, view, cwd=str(script.parent))
        except Exception as exc:
            _log.debug("health check failed", exc_info=True)
            view.append(f"\n  {_RED}[FAIL]{_NC} Error running health check: {exc}")
            return

        view.append("")
        if rc == 0:
            view.append(f"  {_GRN}Health check completed successfully.{_NC}")
        else:
            view.append(
                f"  {_YLW}Health check finished with exit code {rc}.{_NC}"
            )
        view.append("")
