"""Configuration History screen — browse and manage snapshots."""
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
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

try:
    from xinas_history.engine import SnapshotEngine
    from xinas_history.store import FilesystemStore
    from xinas_history.drift import DriftDetector
    from xinas_history.gc import GarbageCollector
    HAS_HISTORY = True
except ImportError:
    HAS_HISTORY = False

# ANSI colour shortcuts
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_MENU = [
    MenuItem("1", "View History"),
    MenuItem("2", "View Snapshot"),
    MenuItem("3", "Drift Check"),
    MenuItem("4", "Garbage Collect"),
    MenuItem("0", "Back"),
]


class ConfigHistoryScreen(Screen):
    """Browse configuration history: baseline, snapshots, current effective.

    Shows:
    - Immutable baseline "First installed configuration"
    - Last 10 rollback-eligible snapshots
    - Current effective snapshot
    - Per snapshot: timestamp, initiator, operation type, rollback class, status, diff summary

    Actions:
    - View snapshot detail (push SnapshotDetailScreen)
    - Rollback to a snapshot
    - Run drift check
    - Run GC
    """

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Configuration History", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="history-nav")
            yield ScrollableTextView(
                f"{_BLD}{_CYN}Configuration History{_NC}\n"
                "\n"
                f"  {_BLD}1{_NC}  {_CYN}View History{_NC}       {_DIM}Browse all snapshots{_NC}\n"
                f"  {_BLD}2{_NC}  {_CYN}View Snapshot{_NC}      {_DIM}Detail view of a single snapshot{_NC}\n"
                f"  {_BLD}3{_NC}  {_CYN}Drift Check{_NC}        {_DIM}Detect out-of-band configuration changes{_NC}\n"
                f"  {_BLD}4{_NC}  {_CYN}Garbage Collect{_NC}    {_DIM}Purge old snapshots beyond retention{_NC}\n",
                id="history-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._load_history()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._load_history()
        elif key == "2":
            self._pick_and_view_snapshot()
        elif key == "3":
            self._drift_check()
        elif key == "4":
            self._run_gc()

    # -- History list -------------------------------------------------------

    @work(exclusive=True)
    async def _load_history(self) -> None:
        """Load snapshot list in background thread."""
        view = self.query_one("#history-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}\n\n"
                f"  {_DIM}Install with: pip install -e ./xinas_history{_NC}"
            )
            return

        view.set_content(f"{_DIM}Loading configuration history...{_NC}")

        loop = asyncio.get_running_loop()
        try:
            engine = await loop.run_in_executor(None, _create_engine)
            summary = await loop.run_in_executor(None, engine.get_history_summary)
        except Exception as exc:
            view.set_content(
                f"{_RED}Failed to load history: {exc}{_NC}"
            )
            return

        text = _format_history(summary)
        view.set_content(text)

        try:
            self.app.audit.log("history.view", "list", "OK")
        except Exception:
            pass

    # -- View single snapshot -----------------------------------------------

    @work(exclusive=True)
    async def _pick_and_view_snapshot(self) -> None:
        """Let user pick a snapshot, then push detail screen."""
        view = self.query_one("#history-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        loop = asyncio.get_running_loop()
        try:
            engine = await loop.run_in_executor(None, _create_engine)
            summary = await loop.run_in_executor(None, engine.get_history_summary)
        except Exception as exc:
            view.set_content(f"{_RED}Failed to load history: {exc}{_NC}")
            return

        # Build selection list
        choices: list[str] = []
        id_map: dict[str, str] = {}

        baseline = summary.get("baseline")
        if baseline:
            label = _snapshot_label(baseline, is_baseline=True)
            choices.append(label)
            id_map[label] = baseline["id"]

        for snap in summary.get("snapshots", []):
            label = _snapshot_label(snap)
            choices.append(label)
            id_map[label] = snap["id"]

        if not choices:
            view.set_content(
                f"{_DIM}No snapshots found.{_NC}\n\n"
                f"  Snapshots are created when configuration changes are applied."
            )
            return

        chosen = await self.app.push_screen_wait(
            SelectDialog(
                choices,
                title="Select Snapshot",
                prompt="Choose a snapshot to view:",
            )
        )
        if chosen is None:
            return

        snapshot_id = id_map.get(chosen, "")
        if snapshot_id:
            from xinas_menu.screens.snapshot_detail import SnapshotDetailScreen
            self.app.push_screen(SnapshotDetailScreen(snapshot_id))

    # -- Drift check --------------------------------------------------------

    @work(exclusive=True)
    async def _drift_check(self) -> None:
        """Run drift detection and show results."""
        view = self.query_one("#history-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        view.set_content(f"{_DIM}Running drift detection...{_NC}")

        loop = asyncio.get_running_loop()
        try:
            store = FilesystemStore()
            engine = _create_engine(store=store)
            detector = DriftDetector(store=store, engine=engine)
            report = await loop.run_in_executor(None, detector.check)
        except Exception as exc:
            view.set_content(f"{_RED}Drift check failed: {exc}{_NC}")
            return

        text = _format_drift_report(report)
        view.set_content(text)

        try:
            status = "clean" if report.clean else f"{len(report.entries)} drifted"
            self.app.audit.log("history.drift_check", status, "OK")
        except Exception:
            pass

    # -- Garbage collection -------------------------------------------------

    @work(exclusive=True)
    async def _run_gc(self) -> None:
        """Run garbage collection on snapshot store."""
        view = self.query_one("#history-content", ScrollableTextView)

        if not HAS_HISTORY:
            view.set_content(
                f"{_RED}xinas_history package not installed.{_NC}"
            )
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Run garbage collection?\n\n"
                "This will remove snapshots beyond the retention limit\n"
                "(keeps baseline + 10 most recent rollback-eligible).",
                "Garbage Collection",
            )
        )
        if not confirmed:
            return

        view.set_content(f"{_DIM}Running garbage collection...{_NC}")

        loop = asyncio.get_running_loop()
        try:
            store = FilesystemStore()
            gc = GarbageCollector(store)
            engine = _create_engine(store=store)
            effective = await loop.run_in_executor(
                None, engine.get_current_effective,
            )
            effective_id = effective.id if effective else None
            purged = await loop.run_in_executor(
                None,
                lambda: gc.run(current_effective_id=effective_id),
            )
        except Exception as exc:
            view.set_content(f"{_RED}Garbage collection failed: {exc}{_NC}")
            return

        if purged:
            lines = [
                f"{_BLD}{_CYN}Garbage Collection Complete{_NC}",
                "",
                f"  Purged {len(purged)} snapshot(s):",
            ]
            for sid in purged:
                lines.append(f"    {_DIM}-{_NC} {sid}")
        else:
            lines = [
                f"{_GRN}Garbage collection complete.{_NC}",
                "",
                f"  {_DIM}No snapshots needed purging.{_NC}",
            ]

        view.set_content("\n".join(lines))

        try:
            self.app.audit.log("history.gc", f"purged={len(purged)}", "OK")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


def _create_engine(store: "FilesystemStore | None" = None) -> "SnapshotEngine":
    """Create a SnapshotEngine with default settings."""
    s = store or FilesystemStore()
    return SnapshotEngine(store=s)


def _snapshot_label(snap: dict, is_baseline: bool = False) -> str:
    """Build a human-readable one-line label for snapshot selection."""
    sid = snap.get("id", "?")
    ts = snap.get("timestamp", "")[:19].replace("T", " ")
    op = snap.get("operation", "")
    prefix = "[baseline] " if is_baseline else ""
    return f"{prefix}{ts}  {op}  ({sid})"


def _format_history(summary: dict) -> str:
    """Format history summary for display."""
    lines: list[str] = []

    total = summary.get("total_count", 0)
    rb_count = summary.get("rollback_eligible_count", 0)
    current = summary.get("current_effective")

    lines.append(f"{_BLD}{_CYN}{'=' * 72}{_NC}")
    lines.append(f"{_BLD}{_CYN}  CONFIGURATION HISTORY{_NC}")
    lines.append(f"{_BLD}{_CYN}{'=' * 72}{_NC}")
    lines.append("")
    lines.append(
        f"  {_DIM}Total snapshots:{_NC} {total}    "
        f"{_DIM}Rollback-eligible:{_NC} {rb_count}"
    )

    if current:
        lines.append(
            f"  {_DIM}Current effective:{_NC} "
            f"{_GRN}{current.get('id', '?')}{_NC}"
        )
    else:
        lines.append(f"  {_DIM}Current effective:{_NC} {_YLW}(none){_NC}")

    lines.append("")

    # Table header
    lines.append(f"  {_BLD}{_DIM}{'#':<4}{'Timestamp':<22}{'Operation':<18}{'Status':<12}{'Risk Class':<18}ID{_NC}")
    lines.append(f"  {_DIM}{'-' * 70}{_NC}")

    row = 0

    # Baseline
    baseline = summary.get("baseline")
    if baseline:
        row += 1
        _append_snapshot_row(lines, row, baseline, is_baseline=True, current_id=current.get("id") if current else "")

    # Regular snapshots (newest first for display)
    snapshots = list(summary.get("snapshots", []))
    snapshots.reverse()
    for snap in snapshots:
        row += 1
        _append_snapshot_row(lines, row, snap, current_id=current.get("id") if current else "")

    if row == 0:
        lines.append(f"  {_DIM}(no snapshots found){_NC}")

    lines.append("")
    lines.append(f"  {_DIM}{'-' * 70}{_NC}")
    lines.append(
        f"  {_DIM}Legend:{_NC} "
        f"{_GRN}*{_NC}=current  "
        f"{_GRN}applied{_NC}  "
        f"{_RED}failed{_NC}  "
        f"{_YLW}rolled_back{_NC}"
    )

    return "\n".join(lines)


def _append_snapshot_row(
    lines: list[str],
    row: int,
    snap: dict,
    is_baseline: bool = False,
    current_id: str = "",
) -> None:
    """Append a single snapshot row to the lines list."""
    sid = snap.get("id", "?")
    ts = snap.get("timestamp", "")[:19].replace("T", " ")
    op = snap.get("operation", "")
    status = snap.get("status", "?")
    risk = snap.get("rollback_class", "")

    # Status coloring
    if status == "applied":
        status_str = f"{_GRN}{status}{_NC}"
    elif status == "failed":
        status_str = f"{_RED}{status}{_NC}"
    elif status == "rolled_back":
        status_str = f"{_YLW}{status}{_NC}"
    else:
        status_str = f"{_DIM}{status}{_NC}"

    # Risk class coloring
    if risk == "destroying_data":
        risk_str = f"{_RED}{risk}{_NC}"
    elif risk == "changing_access":
        risk_str = f"{_YLW}{risk}{_NC}"
    elif risk == "non_disruptive":
        risk_str = f"{_DIM}{risk}{_NC}"
    else:
        risk_str = f"{_DIM}{risk or '-'}{_NC}"

    # Current effective marker
    is_current = (sid == current_id)
    marker = f"{_GRN}*{_NC}" if is_current else " "

    # Baseline marker
    type_tag = ""
    if is_baseline:
        type_tag = f" {_CYN}[baseline]{_NC}"

    # Short ID for display
    short_id = sid[:28] + "..." if len(sid) > 31 else sid

    lines.append(
        f" {marker}{row:<3} {ts:<22}{op:<18}{status_str:<22}{risk_str:<28}{short_id}{type_tag}"
    )

    # Diff summary if present
    diff_summary = snap.get("diff_summary")
    if diff_summary:
        lines.append(f"      {_DIM}{diff_summary}{_NC}")


def _format_drift_report(report) -> str:
    """Format a DriftReport for display."""
    lines: list[str] = []

    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append(f"{_BLD}{_CYN}  DRIFT DETECTION REPORT{_NC}")
    lines.append(f"{_BLD}{_CYN}{'=' * 60}{_NC}")
    lines.append("")

    if report.snapshot_id:
        lines.append(f"  {_DIM}Reference snapshot:{_NC} {report.snapshot_id}")
    lines.append(f"  {_DIM}Checked at:{_NC} {report.timestamp[:19].replace('T', ' ')}")
    lines.append("")

    if report.clean:
        lines.append(f"  {_GRN}No drift detected.{_NC}")
        lines.append("")
        lines.append(
            f"  {_DIM}All managed configuration files match the last applied snapshot.{_NC}"
        )
        return "\n".join(lines)

    n = len(report.entries)
    lines.append(f"  {_YLW}Found {n} drifted artifact{'s' if n != 1 else ''}.{_NC}")

    if report.has_blocking_drift:
        lines.append(f"  {_RED}BLOCKING drift detected - resolve before applying changes.{_NC}")
    if report.has_safety_impact:
        lines.append(f"  {_YLW}Safety-critical artifacts have been modified.{_NC}")

    lines.append("")
    lines.append(f"  {_BLD}{_DIM}{'Artifact':<40}{'Class':<16}{'Policy':<18}Impact{_NC}")
    lines.append(f"  {_DIM}{'-' * 70}{_NC}")

    for entry in report.entries:
        artifact = entry.artifact
        if len(artifact) > 38:
            artifact = "..." + artifact[-35:]

        cls = entry.artifact_class
        policy = entry.policy

        # Color by policy
        if policy == "block":
            policy_str = f"{_RED}{policy}{_NC}"
        elif policy == "warn_and_confirm":
            policy_str = f"{_YLW}{policy}{_NC}"
        else:
            policy_str = f"{_DIM}{policy}{_NC}"

        # Color by safety impact
        impact = entry.safety_impact
        if impact == "affects_rollback_safety":
            impact_str = f"{_RED}{impact}{_NC}"
        elif impact == "access_change":
            impact_str = f"{_YLW}{impact}{_NC}"
        else:
            impact_str = f"{_DIM}{impact}{_NC}"

        lines.append(f"  {artifact:<40}{cls:<16}{policy_str:<28}{impact_str}")

        if entry.detail:
            lines.append(f"    {_DIM}{entry.detail}{_NC}")

    lines.append("")
    lines.append(f"  {_DIM}{'-' * 70}{_NC}")
    lines.append(f"  {_DIM}{report.summary}{_NC}")

    return "\n".join(lines)
