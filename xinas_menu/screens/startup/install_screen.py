"""InstallScreen — preset selection + Ansible playbook execution."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu import install_report
from xinas_menu.apptype import StartupAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_REPO_ROOT_CANDIDATES = [
    Path("/opt/xiNAS"),
    Path("/home/xinnor/xiNAS"),
]


def _repo_root() -> Path:
    for p in _REPO_ROOT_CANDIDATES:
        if p.exists():
            return p
    return _REPO_ROOT_CANDIDATES[0]


def _preset_items() -> tuple[list[MenuItem], list[str]]:
    presets_dir = _repo_root() / "presets"
    presets = (
        [p.name for p in sorted(presets_dir.iterdir()) if p.is_dir()]
        if presets_dir.exists()
        else ["default"]
    )
    items = [MenuItem(str(i + 1), p) for i, p in enumerate(presets)]
    items.append(MenuItem("0", "Back"))
    return items, presets


def install_command(repo: Path, preset: str) -> list[str]:
    """The ansible-playbook argv for an install of *preset* from *repo*.

    Runs `playbooks/site.yml` against `inventories/lab.ini` — the same
    playbook and inventory the bash menus and autoinstall.sh use
    (docs/Installer/spec.md §2.1). The screen used to pass
    `inventories/hosts`, which has never existed: Ansible matched no hosts,
    exited 0, and the screen announced success for an install that never ran.
    """
    return [
        "ansible-playbook",
        str(repo / "playbooks" / "site.yml"),
        "-i",
        str(repo / "inventories" / "lab.ini"),
        "--extra-vars",
        f"preset={preset}",
    ]


def install_environment() -> dict[str, str]:
    """Extra environment for the install run: mark it so the
    xinas_install_state callback records per-role progress (spec §7.7)."""
    return {"XINAS_RECORD_INSTALL_STATE": "1"}


def report_message(
    *,
    exit_code: int,
    run_started: float,
    state_path: str | os.PathLike[str] | None = None,
    log_path: str | None = None,
) -> tuple[str, bool]:
    """The §2.9 role report as plain dialog text, plus whether it is complete."""
    path = state_path or os.environ.get(
        "XINAS_INSTALL_STATE_PATH", install_report.DEFAULT_STATE_PATH
    )
    lines, complete = install_report.render(
        install_report.load_state(path),
        exit_code=exit_code,
        log_path=log_path,
        run_started=run_started,
        color=False,
    )
    return "\n".join(lines), complete


class InstallScreen(StartupAppMixin, Screen):
    """Multi-step install: preset → confirm → run playbook → role report."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._preset_menu_items, self._presets = _preset_items()

    def compose(self) -> ComposeResult:
        yield Label("  ── Install — Select Preset ──")
        yield NavigableMenu(self._preset_menu_items, id="install-nav")
        yield ScrollableTextView("  Select a preset to begin installation.", id="install-content")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
            return
        try:
            idx = int(event.key) - 1
            if 0 <= idx < len(self._presets):
                asyncio.create_task(self._confirm_and_run(self._presets[idx]))
        except ValueError:
            pass

    async def _confirm_and_run(self, preset: str) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Install using preset '{preset}'?\n\n"
                "This will run ansible-playbook site.yml.\n"
                "Existing data will NOT be wiped unless xfs_force_mkfs is set.",
                "Confirm Installation",
            )
        )
        if not confirmed:
            return

        # Check license
        if not (Path("/tmp/license").exists()):
            self.app.notify(
                "No license found at /tmp/license. Enter your license first.", severity="warning"
            )
            return

        from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

        repo = _repo_root()
        cmd = install_command(repo, preset)
        # Launch time, so the report can tell this run's install state from a
        # file an earlier install left behind (spec §2.9).
        run_started = time.time()
        exit_code = await self.app.push_screen_wait(
            PlaybookRunScreen(
                cmd=cmd,
                title=f"Installing — {preset}",
                workdir=repo,
                env=install_environment(),
            )
        )
        report, complete = report_message(
            exit_code=exit_code,
            run_started=run_started,
            log_path="/var/log/xinas/install.log",
        )
        # Success is what the report says, not what the exit code says: a
        # play that matched no hosts exits 0 having installed nothing.
        if exit_code == 0 and complete:
            # Record a baseline snapshot when the running app provides the
            # helper (XiNASApp). StartupApp does not — and does not need to:
            # the xinas_history Ansible role creates the baseline during the
            # install itself. The old unconditional call crashed the SUCCESS
            # path under StartupApp with AttributeError before the
            # notification below could ever show.
            snapshots = getattr(self.app, "snapshots", None)
            if snapshots is not None:
                await snapshots.record_baseline(preset=preset)
            await self.app.push_screen_wait(
                ConfirmDialog(report, "Installation Complete", ok_only=True)
            )
            self.app.notify("Installation completed successfully!", severity="information")
        else:
            go_collect = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"{report}\n\n"
                    f"Installation did not complete (ansible-playbook exit {exit_code}).\n"
                    "Please run Collect Logs -> Collect All, then\n"
                    "Upload Archive to send diagnostics to support\n"
                    "at support@xinnor.io.",
                    title="Installation Incomplete",
                    yes_label="Go to Collect Logs",
                    no_label="Close",
                )
            )
            if go_collect:
                from xinas_menu.screens.collect_logs import CollectLogsScreen

                self.app.push_screen(CollectLogsScreen())
