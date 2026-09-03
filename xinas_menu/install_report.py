"""Post-install role report (docs/Installer/spec.md §2.9).

Renders the callback-written install-state.json (§7.7) as one line per role,
in play order, plus a COMPLETE / INCOMPLETE summary. This is the single
renderer behind every install surface — the bash menus, autoinstall.sh and
the xinas-setup TUI — so the same run reads the same on all of them.

Standard library only, by contract: on the bash paths this file runs under
the *system* python3 (``python3 /opt/xiNAS/xinas_menu/install_report.py``)
before the ``xinas_menu`` role has created the management venv, so nothing
here may import Textual or any other third-party package.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

DEFAULT_STATE_PATH = "/var/lib/xinas/install-state.json"

# Role status -> glyph. Order here is also the legend order.
GLYPH = {
    "ok": "✓",
    "skipped": "–",
    "failed": "✗",
    "not_run": "·",
    "running": "…",
}

_ANSI = {
    "ok": "\033[32m",
    "skipped": "\033[2m",
    "failed": "\033[1;31m",
    "not_run": "\033[2m",
    "running": "\033[33m",
    "head": "\033[1m",
    "bad": "\033[1;31m",
    "good": "\033[1;32m",
    "reset": "\033[0m",
}

_ROLE_COLUMN = 26


def load_state(path: str | os.PathLike[str]) -> dict | None:
    """Return the parsed state file, or None when it is missing or unreadable."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def role_rows(state: dict) -> list[tuple[str, str]]:
    """(role, status) pairs in play order; roles that never started are ``not_run``.

    Order follows ``expected`` (the play's role list). Roles recorded in
    ``roles[]`` but absent from ``expected`` — state files written before
    the list existed — are appended in the order they ran.
    """
    recorded: dict[str, str] = {}
    for entry in state.get("roles", []) or []:
        if isinstance(entry, dict) and isinstance(entry.get("role"), str):
            recorded[entry["role"]] = str(entry.get("status") or "running")
    order = [r for r in (state.get("expected") or []) if isinstance(r, str)]
    for role in recorded:
        if role not in order:
            order.append(role)
    return [(role, recorded.get(role, "not_run")) for role in order]


def _duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours} h {minutes} min"
    if minutes:
        return f"{minutes} min {secs} s"
    return f"{secs} s"


def summary(rows: list[tuple[str, str]], state: dict) -> tuple[str, bool]:
    """The one-line verdict and whether the install is complete."""
    total = len(rows)
    applied = [r for r, s in rows if s == "ok"]
    skipped = [r for r, s in rows if s == "skipped"]
    failed = [r for r, s in rows if s == "failed"]
    running = [r for r, s in rows if s == "running"]
    not_run = [r for r, s in rows if s == "not_run"]
    head = f"{len(applied)} of {total} roles applied"
    if failed:
        return f"INCOMPLETE: {head}, failed at {failed[0]}, {len(not_run)} not run", False
    if running or state.get("status") == "running":
        during = running[0] if running else "an unknown role"
        return f"INCOMPLETE: {head}, interrupted during {during}, {len(not_run)} not run", False
    if not_run:
        return f"INCOMPLETE: {head}, {len(not_run)} not run", False
    line = f"COMPLETE: {head}"
    if skipped:
        line += f", {len(skipped)} skipped ({', '.join(skipped)})"
    return line, True


def _paint(text: str, key: str, color: bool) -> str:
    if not color:
        return text
    return f"{_ANSI[key]}{text}{_ANSI['reset']}"


def render(
    state: dict | None,
    *,
    exit_code: int | None = None,
    log_path: str | None = None,
    run_started: float | None = None,
    color: bool = False,
) -> tuple[list[str], bool]:
    """Render the report lines. Returns (lines, complete).

    ``run_started`` is the epoch second at which the caller launched
    ``ansible-playbook``; a state file that started before it belongs to an
    earlier run and is treated as absent, so a play that died before its
    first PLAY can never borrow a previous install's report.
    """
    lines: list[str] = []
    stale = (
        state is not None
        and run_started is not None
        and float(state.get("started") or 0.0) < float(run_started)
    )
    if state is None or stale:
        what = "No roles ran"
        if exit_code is not None:
            what += f" (ansible-playbook exit {exit_code})"
        lines.append(_paint(what, "bad", color))
        lines.append("  The play stopped before its first role — a syntax error, no hosts")
        lines.append("  matched, or the install state was not recorded for this run.")
        if log_path:
            lines.append(f"Log: {log_path}")
        return lines, False

    rows = role_rows(state)
    started = float(state.get("started") or 0.0)
    updated = float(state.get("updated") or started)
    when = datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M") if started else "unknown time"
    # A state file written before the callback learned to resolve the preset
    # carries null; the rule is the same — no preset applied means the release
    # defaults, i.e. the default preset (docs/Installer/spec.md §7.7).
    preset = state.get("preset") or "default"
    header = f"Install report — preset {preset} · {when} · {_duration(updated - started)}"
    lines.append(_paint(header, "head", color))
    for role, status in rows:
        glyph = GLYPH.get(status, "?")
        cell = f"{glyph} {role}"
        if status == "failed":
            cell = f"{cell:<{_ROLE_COLUMN}} ← install stopped here"
        elif status == "running":
            cell = f"{cell:<{_ROLE_COLUMN}} ← was running when the install stopped"
        lines.append("  " + _paint(cell, status if status in _ANSI else "not_run", color))
    verdict, complete = summary(rows, state)
    lines.append(_paint(verdict, "good" if complete else "bad", color))
    if log_path:
        lines.append(f"Log: {log_path}")
    return lines, complete


def build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="install_report",
        description="Print the per-role report for the last xiNAS install run.",
    )
    parser.add_argument(
        "--state",
        default=os.environ.get("XINAS_INSTALL_STATE_PATH", DEFAULT_STATE_PATH),
        help="install-state.json written by the xinas_install_state callback",
    )
    parser.add_argument("--exit-code", type=int, default=None, help="ansible-playbook's exit code")
    parser.add_argument("--log", default=None, help="install log path to name at the end")
    parser.add_argument(
        "--since",
        type=float,
        default=None,
        help="epoch second the run was launched; an older state file is ignored",
    )
    parser.add_argument("--color", choices=("auto", "always", "never"), default="auto")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Script entry point. Always returns 0: the report must never change the install's status."""
    args = build_argparser().parse_args(argv)
    color = args.color == "always" or (args.color == "auto" and sys.stdout.isatty())
    try:
        lines, _ = render(
            load_state(args.state),
            exit_code=args.exit_code,
            log_path=args.log,
            run_started=args.since,
            color=color,
        )
    except Exception as exc:  # noqa: BLE001 — a report failure must not mask the install result
        lines = [f"Install report unavailable ({exc}); see {args.state}"]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
