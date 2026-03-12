"""HealthScreen — runs health engine, displays report."""
from __future__ import annotations

import asyncio
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label
from textual.widgets import Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_PROFILES_DIR = Path(__file__).parent.parent.parent / "healthcheck_profiles"

_MENU = [
    MenuItem("1", "Quick Check"),
    MenuItem("2", "Standard Check"),
    MenuItem("3", "Deep Check"),
    MenuItem("4", "View Last Report"),
    MenuItem("0", "Back"),
]


class HealthScreen(Screen):
    """Health check management screen."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── Health Check ──", id="screen-title")
        yield NavigableMenu(_MENU, id="health-nav")
        yield ScrollableTextView(
        yield Footer()
            "  Select a profile to run a health check.", id="health-content"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._run_check("quick"))
        elif key == "2":
            asyncio.create_task(self._run_check("standard"))
        elif key == "3":
            asyncio.create_task(self._run_check("deep"))
        elif key == "4":
            asyncio.create_task(self._view_last())

    async def _run_check(self, profile: str) -> None:
        view = self.query_one("#health-content", ScrollableTextView)
        view.set_content(f"[dim]Running {profile} health check…[/dim]")

        # Resolve profile path
        profile_path = _find_profile(profile)
        if profile_path is None:
            view.set_content(
                f"[red]Profile '{profile}' not found in {_PROFILES_DIR}[/red]"
            )
            return

        from xinas_menu.health.engine import run_health_check
        loop = asyncio.get_event_loop()
        try:
            text, json_path = await loop.run_in_executor(
                None,
                lambda: run_health_check(
                    str(profile_path),
                    "/var/log/xinas/healthcheck",
                    [],
                ),
            )
            self.app.audit.log("health.check", profile, "OK")
            if text:
                view.set_content(text)
            else:
                view.set_content("[yellow]No output from health engine.[/yellow]")
        except Exception as exc:
            view.set_content(f"[red]Health check failed: {exc}[/red]")

    async def _view_last(self) -> None:
        import glob
        log_dir = Path("/var/log/xinas/healthcheck")
        reports = sorted(log_dir.glob("healthcheck_*.txt"), reverse=True)
        view = self.query_one("#health-content", ScrollableTextView)
        if reports:
            try:
                text = reports[0].read_text()
                view.set_content(text)
            except Exception as exc:
                view.set_content(f"[red]Cannot read report: {exc}[/red]")
        else:
            view.set_content("[dim]No health reports saved yet.[/dim]")


def _find_profile(name: str) -> Path | None:
    search_dirs = [
        _PROFILES_DIR,
        Path("/opt/xiNAS/healthcheck_profiles"),
        Path("/home/xinnor/xiNAS/healthcheck_profiles"),
    ]
    for d in search_dirs:
        for ext in (".yml", ".yaml"):
            p = d / f"{name}{ext}"
            if p.exists():
                return p
    return None
