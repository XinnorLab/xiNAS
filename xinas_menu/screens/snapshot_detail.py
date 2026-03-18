"""Snapshot detail screen — full view of a configuration snapshot."""
from __future__ import annotations

import asyncio
import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

try:
    from xinas_history.engine import SnapshotEngine
    from xinas_history.store import FilesystemStore
    from xinas_history.runner import TransactionalRunner
    from xinas_history.models import SnapshotStatus, SnapshotType, RollbackClass
    HAS_HISTORY = True
except ImportError:
    HAS_HISTORY = False

# ANSI colour shortcuts
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_MENU = [
    MenuItem("1", "Manifest"),
    MenuItem("2", "Full Diff"),
    MenuItem("3", "Rollback"),
    MenuItem("0", "Back"),
]


class SnapshotDetailScreen(Screen):
    """Full detail view of a single snapshot.

    Shows:
    - Manifest metadata (ID, timestamp, user, source, operation, status, risk class)
    - Diff from parent snapshot
    - Affected resources
    - Validation notes
    - Rollback eligibility
    - Dependency blockers (if any)

    Actions:
    - Rollback to this snapshot
    - View full diff
    - Back to history list
    """

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self, snapshot_id: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self._snapshot_id = snapshot_id

    def compose(self) -> ComposeResult:
        yield Label("  Snapshot Detail", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="detail-nav")
            yield ScrollableTextView(
                f"{_DIM}Loading snapshot {self._snapshot_id}...{_NC}",
                id="detail-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._load_detail()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._load_detail()
        elif key == "2":
            self._show_diff()
        elif key == "3":
            self._do_rollback()

    # -- Load manifest detail -----------------------------------------------

    @work(exclusive=True)
    async def _load_detail(self) -> None:
        """Load snapshot details in background."""
        view = self.query_one("#detail-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        view.set_content(f"{_DIM}Loading snapshot...{_NC}")

        loop = asyncio.get_running_loop()
        try:
            engine = await loop.run_in_executor(None, _create_engine)
            manifest = await loop.run_in_executor(
                None, engine.get_snapshot, self._snapshot_id,
            )
        except Exception as exc:
            view.set_content(f"{_RED}Failed to load snapshot: {exc}{_NC}")
            return

        if manifest is None:
            view.set_content(
                f"{_RED}Snapshot not found: {self._snapshot_id}{_NC}"
            )
            return

        text = _format_manifest(manifest)

        # If there is a parent, show a brief diff summary
        if manifest.parent_id:
            try:
                diff_result = await loop.run_in_executor(
                    None,
                    lambda: engine.diff(manifest.parent_id, manifest.id),
                )
                text += "\n" + _format_diff_summary(diff_result)
            except Exception as exc:
                text += (
                    f"\n\n  {_DIM}Could not compute diff from parent: {exc}{_NC}"
                )

        view.set_content(text)

        try:
            self.app.audit.log(
                "history.view", f"snapshot={self._snapshot_id}", "OK",
            )
        except Exception:
            pass

    # -- Full diff view -----------------------------------------------------

    @work(exclusive=True)
    async def _show_diff(self) -> None:
        """Show full unified diff from parent."""
        view = self.query_one("#detail-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        view.set_content(f"{_DIM}Computing diff...{_NC}")

        loop = asyncio.get_running_loop()
        try:
            engine = await loop.run_in_executor(None, _create_engine)
            manifest = await loop.run_in_executor(
                None, engine.get_snapshot, self._snapshot_id,
            )
        except Exception as exc:
            view.set_content(f"{_RED}Failed to load snapshot: {exc}{_NC}")
            return

        if manifest is None:
            view.set_content(
                f"{_RED}Snapshot not found: {self._snapshot_id}{_NC}"
            )
            return

        if not manifest.parent_id:
            view.set_content(
                f"{_YLW}No parent snapshot.{_NC}\n\n"
                f"  {_DIM}This is a baseline or the first snapshot; "
                f"there is no previous state to compare against.{_NC}"
            )
            return

        try:
            diff_result = await loop.run_in_executor(
                None,
                lambda: engine.diff(manifest.parent_id, manifest.id),
            )
        except Exception as exc:
            view.set_content(f"{_RED}Diff failed: {exc}{_NC}")
            return

        text = _format_full_diff(diff_result)
        view.set_content(text)

    # -- Rollback -----------------------------------------------------------

    @work(exclusive=True)
    async def _do_rollback(self) -> None:
        """Initiate rollback to this snapshot (with confirmation)."""
        view = self.query_one("#detail-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        loop = asyncio.get_running_loop()
        try:
            engine = await loop.run_in_executor(None, _create_engine)
            manifest = await loop.run_in_executor(
                None, engine.get_snapshot, self._snapshot_id,
            )
        except Exception as exc:
            view.set_content(f"{_RED}Failed to load snapshot: {exc}{_NC}")
            return

        if manifest is None:
            view.set_content(
                f"{_RED}Snapshot not found: {self._snapshot_id}{_NC}"
            )
            return

        # Check rollback eligibility
        if manifest.type == SnapshotType.BASELINE.value:
            view.set_content(
                f"{_YLW}The baseline snapshot is immutable and cannot be used "
                f"as a direct rollback target.{_NC}\n\n"
                f"  {_DIM}Select a rollback-eligible snapshot instead.{_NC}"
            )
            return

        if manifest.type != SnapshotType.ROLLBACK_ELIGIBLE.value:
            view.set_content(
                f"{_YLW}This snapshot is of type '{manifest.type}' and is not "
                f"eligible for rollback.{_NC}\n\n"
                f"  {_DIM}Only rollback-eligible snapshots can be used as targets.{_NC}"
            )
            return

        # Build risk warning
        risk = manifest.rollback_class
        risk_warning = ""
        if risk == RollbackClass.DESTROYING_DATA.value:
            risk_warning = (
                f"\n{_RED}WARNING: This rollback may result in DATA LOSS.{_NC}\n"
                f"{_RED}Ensure you have backups before proceeding.{_NC}\n"
            )
        elif risk == RollbackClass.CHANGING_ACCESS.value:
            risk_warning = (
                f"\n{_YLW}NOTE: This rollback may change NFS access rules "
                f"or network settings.{_NC}\n"
            )

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Roll back to snapshot?\n\n"
                f"  ID:        {manifest.id}\n"
                f"  Operation: {manifest.operation}\n"
                f"  Timestamp: {manifest.timestamp}\n"
                f"  Risk:      {risk}\n"
                f"{risk_warning}\n"
                f"This will create a new snapshot and re-apply the\n"
                f"configuration from the selected snapshot.",
                "Confirm Rollback",
            )
        )
        if not confirmed:
            return

        _progress_lines: list[str] = []

        def _on_progress(line: str) -> None:
            _progress_lines.append(line)
            # Keep last 30 lines for display
            tail = _progress_lines[-30:]
            self.app.call_from_thread(
                view.set_content,
                f"{_DIM}Executing rollback to {self._snapshot_id}...{_NC}\n\n"
                + "\n".join(tail),
            )

        view.set_content(
            f"{_DIM}Executing rollback to {self._snapshot_id}...{_NC}\n\n"
            f"  {_DIM}This may take a few minutes while the configuration "
            f"is re-applied.{_NC}"
        )

        try:
            self.app.audit.log(
                "history.rollback_attempt",
                f"snapshot={self._snapshot_id}",
                "STARTED",
            )
        except Exception:
            pass

        # Build a rollback apply_fn that restores config from the target snapshot
        target_id = self._snapshot_id

        try:
            store = FilesystemStore()
            runner = TransactionalRunner(
                engine=SnapshotEngine(store=store),
            )

            # The rollback restores config files from the target snapshot
            # then re-applies them via Ansible playbook
            target_manifest = await loop.run_in_executor(
                None, engine.get_snapshot, target_id,
            )

            preset = target_manifest.preset or "default"

            run_result = await runner.execute_ansible(
                operation="rollback",
                source="xinas_menu",
                preset=preset,
                playbook=f"presets/{preset}/playbook.yml",
                skip_tags=["hostname", "packages", "kernel", "ntp", "timezone", "security"],
                diff_summary=f"Rollback to snapshot {target_id}",
                progress_cb=_on_progress,
            )

            if run_result.success:
                # Record the rollback snapshot
                await self.app.snapshots.record(
                    "rollback",
                    diff_summary=f"Rolled back to snapshot {target_id}",
                )
                # Mark the target snapshot as rolled_back
                try:
                    store.update_manifest(
                        target_id,
                        {"status": SnapshotStatus.ROLLED_BACK.value},
                    )
                except Exception:
                    pass

                view.set_content(
                    f"{_GRN}{_BLD}Rollback completed successfully!{_NC}\n\n"
                    f"  {_DIM}Target:{_NC}    {target_id}\n"
                    f"  {_DIM}Preset:{_NC}    {preset}\n"
                    f"  {_DIM}Result:{_NC}    {_GRN}applied{_NC}\n"
                )
                self.app.notify("Rollback completed successfully.", severity="information")

                try:
                    self.app.audit.log(
                        "history.rollback",
                        f"snapshot={target_id}",
                        "OK",
                    )
                except Exception:
                    pass
            else:
                error_msg = run_result.error or "Unknown error"
                rb_status = ""
                if run_result.rollback_performed:
                    if run_result.rollback_success:
                        rb_status = f"\n  {_YLW}Auto-rollback succeeded — system restored to pre-change state.{_NC}"
                    else:
                        rb_status = f"\n  {_RED}Auto-rollback FAILED — system may be in inconsistent state!{_NC}"

                output_section = ""
                if run_result.output:
                    output_section = (
                        f"\n  {_DIM}{'─' * 60}{_NC}\n"
                        f"  {_BLD}Ansible output:{_NC}\n\n"
                        f"{run_result.output}\n"
                    )

                view.set_content(
                    f"{_RED}{_BLD}Rollback failed.{_NC}\n\n"
                    f"  {_DIM}Target:{_NC}    {target_id}\n"
                    f"  {_DIM}Error:{_NC}     {error_msg}\n"
                    f"{rb_status}"
                    f"{output_section}"
                )
                self.app.notify("Rollback failed.", severity="error")

                try:
                    self.app.audit.log(
                        "history.rollback",
                        f"snapshot={target_id} error={error_msg[:100]}",
                        "FAIL",
                    )
                except Exception:
                    pass

        except Exception as exc:
            _log.exception("Rollback failed: %s", exc)
            view.set_content(
                f"{_RED}Rollback failed: {exc}{_NC}\n\n"
                f"  {_DIM}Snapshot ID: {target_id}{_NC}"
            )
            self.app.notify(f"Rollback error: {exc}", severity="error")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_engine(store: "FilesystemStore | None" = None) -> "SnapshotEngine":
    """Create a SnapshotEngine with default settings."""
    s = store or FilesystemStore()
    return SnapshotEngine(store=s)


def _format_manifest(manifest) -> str:
    """Format manifest as a readable key-value display."""
    lines: list[str] = []

    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append(f"{_BLD}{_CYN}  SNAPSHOT DETAIL{_NC}")
    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append("")

    # Status coloring
    status = manifest.status
    if status == "applied":
        status_str = f"{_GRN}{status}{_NC}"
    elif status == "failed":
        status_str = f"{_RED}{status}{_NC}"
    elif status == "rolled_back":
        status_str = f"{_YLW}{status}{_NC}"
    else:
        status_str = f"{_DIM}{status}{_NC}"

    # Risk class coloring
    risk = manifest.rollback_class
    if risk == "destroying_data":
        risk_str = f"{_RED}{risk}{_NC}"
    elif risk == "changing_access":
        risk_str = f"{_YLW}{risk}{_NC}"
    elif risk == "non_disruptive":
        risk_str = f"{_GRN}{risk}{_NC}"
    else:
        risk_str = f"{_DIM}{risk or '-'}{_NC}"

    # Type coloring
    snap_type = manifest.type
    if snap_type == "baseline":
        type_str = f"{_CYN}{snap_type}{_NC}"
    elif snap_type == "rollback_eligible":
        type_str = f"{_GRN}{snap_type}{_NC}"
    else:
        type_str = f"{_DIM}{snap_type}{_NC}"

    ts_display = manifest.timestamp[:19].replace("T", " ")

    lines.append(f"  {_BLD}Metadata{_NC}")
    lines.append(f"  {_DIM}{'-' * 56}{_NC}")
    lines.append(f"  {_DIM}ID:{_NC}             {manifest.id}")
    lines.append(f"  {_DIM}Timestamp:{_NC}      {ts_display}")
    lines.append(f"  {_DIM}User:{_NC}           {manifest.user}")
    lines.append(f"  {_DIM}Source:{_NC}         {manifest.source}")
    lines.append(f"  {_DIM}Operation:{_NC}      {manifest.operation}")
    lines.append(f"  {_DIM}Status:{_NC}         {status_str}")
    lines.append(f"  {_DIM}Type:{_NC}           {type_str}")
    lines.append(f"  {_DIM}Risk Class:{_NC}     {risk_str}")

    if manifest.preset:
        lines.append(f"  {_DIM}Preset:{_NC}         {manifest.preset}")
    if manifest.hostname:
        lines.append(f"  {_DIM}Hostname:{_NC}       {manifest.hostname}")
    if manifest.parent_id:
        lines.append(f"  {_DIM}Parent ID:{_NC}      {manifest.parent_id}")
    if manifest.repo_commit:
        lines.append(f"  {_DIM}Repo Commit:{_NC}    {manifest.repo_commit[:12]}")
    if manifest.hardware_id:
        lines.append(f"  {_DIM}Hardware ID:{_NC}    {manifest.hardware_id}")
    if manifest.playbook:
        lines.append(f"  {_DIM}Playbook:{_NC}       {manifest.playbook}")

    # Extra vars
    if manifest.extra_vars:
        lines.append("")
        lines.append(f"  {_BLD}Extra Variables{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        for k, v in manifest.extra_vars.items():
            lines.append(f"  {_DIM}{k}:{_NC} {v}")

    # Checksums
    if manifest.checksums:
        lines.append("")
        lines.append(f"  {_BLD}Checksums{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        for k, v in manifest.checksums.items():
            # Shorten sha256:abc... to just the first 16 hex chars
            short_v = v
            if isinstance(v, str) and v.startswith("sha256:"):
                short_v = f"sha256:{v[7:23]}..."
            lines.append(f"  {_DIM}{k}:{_NC} {short_v}")

    # Validation
    if manifest.validation:
        lines.append("")
        lines.append(f"  {_BLD}Validation{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        passed = manifest.validation.get("passed", True)
        if passed:
            lines.append(f"  {_GRN}Validation passed.{_NC}")
        else:
            lines.append(f"  {_RED}Validation failed.{_NC}")
        blockers = manifest.validation.get("blockers", [])
        for b in blockers:
            lines.append(f"    {_RED}BLOCKER:{_NC} {b}")
        warnings = manifest.validation.get("warnings", [])
        for w in warnings:
            lines.append(f"    {_YLW}WARNING:{_NC} {w}")

    # Diff summary
    if manifest.diff_summary:
        lines.append("")
        lines.append(f"  {_BLD}Diff Summary{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        lines.append(f"  {manifest.diff_summary}")

    return "\n".join(lines)


def _format_diff_summary(diff_result) -> str:
    """Format a brief diff summary (appended to manifest view)."""
    lines: list[str] = []

    total = len(diff_result.config_changes) + len(diff_result.runtime_changes)
    if total == 0:
        lines.append(f"\n  {_DIM}No changes from parent snapshot.{_NC}")
        return "\n".join(lines)

    lines.append("")
    lines.append(f"  {_BLD}Changes from Parent{_NC}")
    lines.append(f"  {_DIM}{'-' * 56}{_NC}")

    if diff_result.summary:
        lines.append(f"  {diff_result.summary}")

    # Risk class for this diff
    risk = diff_result.rollback_class
    if risk:
        if risk == "destroying_data":
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_RED}{risk}{_NC}")
        elif risk == "changing_access":
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_YLW}{risk}{_NC}")
        else:
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_DIM}{risk}{_NC}")

    # Show up to 8 change entries
    shown = 0
    for change in diff_result.config_changes[:5]:
        icon = _change_icon(change.get("change_type", ""))
        lines.append(f"    {icon} {change.get('summary', change.get('file', '?'))}")
        shown += 1

    for change in diff_result.runtime_changes[:3]:
        icon = _change_icon(change.get("change_type", ""))
        lines.append(f"    {icon} {change.get('summary', change.get('resource', '?'))}")
        shown += 1

    remaining = total - shown
    if remaining > 0:
        lines.append(f"    {_DIM}... +{remaining} more change(s){_NC}")

    return "\n".join(lines)


def _format_full_diff(diff_result) -> str:
    """Format a full diff view."""
    lines: list[str] = []

    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append(f"{_BLD}{_CYN}  FULL DIFF{_NC}")
    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append("")
    lines.append(f"  {_DIM}From:{_NC} {diff_result.from_id}")
    lines.append(f"  {_DIM}To:{_NC}   {diff_result.to_id}")

    if diff_result.summary:
        lines.append(f"  {_DIM}Summary:{_NC} {diff_result.summary}")

    risk = diff_result.rollback_class
    if risk:
        if risk == "destroying_data":
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_RED}{risk}{_NC}")
        elif risk == "changing_access":
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_YLW}{risk}{_NC}")
        else:
            lines.append(f"  {_DIM}Rollback risk:{_NC} {_DIM}{risk}{_NC}")

    lines.append("")

    # Config changes
    if diff_result.config_changes:
        lines.append(f"  {_BLD}Configuration Changes{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        for change in diff_result.config_changes:
            icon = _change_icon(change.get("change_type", ""))
            lines.append(
                f"    {icon} {change.get('summary', change.get('file', '?'))}"
            )
        lines.append("")

    # Runtime changes
    if diff_result.runtime_changes:
        lines.append(f"  {_BLD}Runtime State Changes{_NC}")
        lines.append(f"  {_DIM}{'-' * 56}{_NC}")
        for change in diff_result.runtime_changes:
            icon = _change_icon(change.get("change_type", ""))
            lines.append(
                f"    {icon} {change.get('summary', change.get('resource', '?'))}"
            )
        lines.append("")

    total = len(diff_result.config_changes) + len(diff_result.runtime_changes)
    if total == 0:
        lines.append(f"  {_GRN}No differences found.{_NC}")

    lines.append(f"  {_DIM}{'-' * 56}{_NC}")

    return "\n".join(lines)


def _change_icon(change_type: str) -> str:
    """Return a colored icon for a change type."""
    if change_type == "added":
        return f"{_GRN}+{_NC}"
    if change_type == "removed":
        return f"{_RED}-{_NC}"
    if change_type == "modified":
        return f"{_YLW}~{_NC}"
    return f"{_DIM}?{_NC}"
