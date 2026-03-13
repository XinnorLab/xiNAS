"""HealthScreen — runs health engine, displays report, offers remediation wizard."""
from __future__ import annotations

import asyncio
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_PROFILES_DIR = Path(__file__).parent.parent.parent / "healthcheck_profiles"

_MENU = [
    MenuItem("1", "Quick Check"),
    MenuItem("2", "Standard Check"),
    MenuItem("3", "Deep Check"),
    MenuItem("4", "View Last Report"),
    MenuItem("5", "Remediation Wizard"),
    MenuItem("0", "Back"),
]


class HealthScreen(Screen):
    """Health check management screen."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._last_json_path: str = ""

    def compose(self) -> ComposeResult:
        yield Label("  Health Check", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="health-nav")
            yield ScrollableTextView("  Select a profile to run a health check.", id="health-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._run_check("quick")
        elif key == "2":
            self._run_check("standard")
        elif key == "3":
            self._run_check("deep")
        elif key == "4":
            self._view_last()
        elif key == "5":
            self._remediation_wizard()

    @work(exclusive=True)
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
        loop = asyncio.get_running_loop()
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
            self._last_json_path = json_path
            if text:
                view.set_content(text)
            else:
                view.set_content("[yellow]No output from health engine.[/yellow]")

            # Auto-offer remediation if there are failures
            if json_path:
                await self._offer_remediation(json_path)
        except Exception as exc:
            view.set_content(f"[red]Health check failed: {exc}[/red]")

    async def _offer_remediation(self, json_path: str) -> None:
        """Check if the report has failures and offer to run the remediation wizard."""
        try:
            from xinas_menu.health.remediation import RemediationWizard
            wiz = RemediationWizard(json_path)
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, wiz.load)
            failed = wiz.failed_checks()
            if not failed:
                return
            n_fail = sum(1 for c in failed if c.get("status") == "FAIL")
            n_warn = sum(1 for c in failed if c.get("status") == "WARN")
            parts = []
            if n_fail:
                parts.append(f"{n_fail} failed")
            if n_warn:
                parts.append(f"{n_warn} warnings")
            summary = ", ".join(parts)
            run_wiz = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Found {summary}.\n\nRun Remediation Wizard to review and fix issues?",
                    "Remediation Wizard",
                )
            )
            if run_wiz:
                await self._run_remediation(json_path)
        except Exception:
            pass

    @work(exclusive=True)
    async def _remediation_wizard(self) -> None:
        """Menu item 5: run remediation wizard on last or latest report."""
        json_path = self._last_json_path
        if not json_path or not Path(json_path).exists():
            from xinas_menu.health.remediation import RemediationWizard
            found = RemediationWizard.latest_json_report()
            if found:
                json_path = str(found)
            else:
                view = self.query_one("#health-content", ScrollableTextView)
                view.set_content(
                    "[yellow]No health check report found.[/yellow]\n\n"
                    "  Run a health check first (Quick/Standard/Deep),\n"
                    "  then the wizard will analyze the results."
                )
                return
        await self._run_remediation(json_path)

    async def _run_remediation(self, json_path: str) -> None:
        """Core remediation logic: load report, show issues, let user pick fixes."""
        from xinas_menu.health.remediation import RemediationWizard
        view = self.query_one("#health-content", ScrollableTextView)
        view.set_content("[dim]Loading remediation data…[/dim]")

        loop = asyncio.get_running_loop()
        try:
            wiz = RemediationWizard(json_path)
            await loop.run_in_executor(None, wiz.load)
            actions = wiz.actions()
        except Exception as exc:
            view.set_content(f"[red]Failed to load report: {exc}[/red]")
            return

        if not actions:
            view.set_content(
                "[green]All checks passed — no remediation needed.[/green]"
            )
            return

        # ANSI color codes
        GRN, YLW, RED, CYN, BLD, DIM, NC = (
            "\033[32m", "\033[33m", "\033[31m", "\033[36m",
            "\033[1m", "\033[2m", "\033[0m",
        )

        # Build summary display
        auto_fixable = [a for a in actions if a.command]
        manual_only = [a for a in actions if not a.command]

        lines = [f"{BLD}{CYN}=== Remediation Wizard ==={NC}", ""]
        lines.append(f"  Report: {DIM}{json_path}{NC}")
        lines.append(f"  Issues found: {len(actions)}")
        lines.append(f"  Auto-fixable: {GRN}{len(auto_fixable)}{NC}")
        lines.append(f"  Manual only:  {YLW}{len(manual_only)}{NC}")
        lines.append("")

        for a in actions:
            sc = RED if a.status == "FAIL" else YLW
            fix_icon = f"{GRN}*{NC}" if a.command else f"{DIM}#{NC}"
            cmd_text = (
                f"{DIM} -> {' '.join(a.command)}{NC}"
                if a.command
                else f"{DIM} (manual){NC}"
            )
            lines.append(f"  {sc}[{a.status}]{NC} {fix_icon} {a.description}{cmd_text}")
            if a.evidence:
                lines.append(f"         {DIM}current: {a.evidence}{NC}")

        view.set_content("\n".join(lines))

        if not auto_fixable:
            view.append(
                f"\n{YLW}No auto-fixable issues. Review the manual items above.{NC}"
            )
            return

        # Let user choose which fixes to apply
        items = [f"[{a.status}] {a.description}" for a in auto_fixable]
        items.insert(0, "Apply ALL auto-fixes")

        chosen = await self.app.push_screen_wait(
            SelectDialog(
                items,
                title="Remediation Wizard",
                prompt="Select a fix to apply (or apply all):",
            )
        )
        if chosen is None:
            return

        if chosen.startswith("Apply ALL"):
            to_apply = auto_fixable
        else:
            idx = items.index(chosen) - 1  # -1 for the "Apply ALL" entry
            if 0 <= idx < len(auto_fixable):
                to_apply = [auto_fixable[idx]]
            else:
                return

        # Confirm before applying
        cmd_summary = "\n".join(
            f"  {' '.join(a.command)}" for a in to_apply if a.command
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Apply {len(to_apply)} fix(es)?\n\n{cmd_summary}",
                "Confirm Remediation",
            )
        )
        if not confirmed:
            return

        # Apply fixes
        results_lines = [f"\n{BLD}{CYN}=== Remediation Results ==={NC}", ""]
        for a in to_apply:
            ok, output = await loop.run_in_executor(
                None, lambda act=a: wiz.apply(act)
            )
            if ok:
                results_lines.append(f"  {GRN}OK{NC} {a.description}")
                self.app.audit.log("health.remediate", a.check_name, "OK")
            else:
                results_lines.append(f"  {RED}FAIL{NC} {a.description}: {output}")
                self.app.audit.log(
                    "health.remediate", a.check_name, f"FAIL: {output}"
                )
            if output:
                results_lines.append(f"    {DIM}{output}{NC}")

        view.append("\n".join(results_lines))

    @work(exclusive=True)
    async def _view_last(self) -> None:
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
