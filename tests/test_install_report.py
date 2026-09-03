"""Post-install role report renderer (docs/Installer/spec.md §2.9).

`xinas_menu/install_report.py` turns the callback's install-state.json into
the one-line-per-role table every install surface prints after
`ansible-playbook` returns. It is the single renderer for the bash menus,
autoinstall.sh and the xinas-setup TUI, and it must stay standard-library
only: on the bash paths it runs under the *system* python3 before the
management venv exists.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

from xinas_menu import install_report as ir

REPO = Path(__file__).resolve().parents[1]
MODULE = REPO / "xinas_menu" / "install_report.py"

EXPECTED = ["common", "doca_ofed", "net_controllers", "xiraid_classic", "nvme_namespace"]


def _state(roles, *, status, expected=EXPECTED, started=1000.0, updated=1252.0):
    return {
        "status": status,
        "preset": "default",
        "started": started,
        "updated": updated,
        "expected": list(expected),
        "roles": [
            {"role": r, "status": s, "ts": started + i, "tasks": {}}
            for i, (r, s) in enumerate(roles)
        ],
    }


def _text(lines):
    return "\n".join(lines)


# ── rendering ─────────────────────────────────────────────────────────────────


def test_complete_run_lists_every_role_and_says_complete():
    state = _state([(r, "ok") for r in EXPECTED], status="completed")
    lines, complete = ir.render(state, exit_code=0, log_path="/var/log/xinas/install.log")
    text = _text(lines)
    assert complete is True
    for role in EXPECTED:
        assert f"✓ {role}" in text
    assert "COMPLETE: 5 of 5 roles applied" in text
    assert "Log: /var/log/xinas/install.log" in text


def test_failure_marks_the_stopped_role_and_counts_roles_never_run():
    roles = [
        ("common", "ok"),
        ("doca_ofed", "ok"),
        ("net_controllers", "ok"),
        ("xiraid_classic", "failed"),
    ]
    state = _state(roles, status="failed")
    lines, complete = ir.render(state, exit_code=2)
    text = _text(lines)
    assert complete is False
    assert "✗ xiraid_classic" in text
    assert "install stopped here" in text
    assert "· nvme_namespace" in text
    assert "INCOMPLETE: 3 of 5 roles applied, failed at xiraid_classic, 1 not run" in text


def test_roles_are_listed_in_play_order_with_unstarted_ones_after():
    roles = [("common", "ok"), ("doca_ofed", "failed")]
    lines, _ = ir.render(_state(roles, status="failed"), exit_code=2)
    # Role lines are the indented ones that start with a status glyph; the
    # header and the summary also name roles and must not be counted.
    glyphs = set(ir.GLYPH.values())
    role_lines = [ln for ln in lines if ln.startswith("  ") and ln.strip()[:1] in glyphs]
    order = [next(r for r in EXPECTED if r in ln) for ln in role_lines]
    assert order == EXPECTED


def test_skipped_role_is_reported_but_not_counted_as_applied():
    roles = [
        ("common", "ok"),
        ("doca_ofed", "ok"),
        ("net_controllers", "ok"),
        ("xiraid_classic", "skipped"),
        ("nvme_namespace", "ok"),
    ]
    lines, complete = ir.render(_state(roles, status="completed"), exit_code=0)
    text = _text(lines)
    assert complete is True
    assert "– xiraid_classic" in text
    assert "COMPLETE: 4 of 5 roles applied, 1 skipped (xiraid_classic)" in text


def test_interrupted_run_names_the_role_that_was_executing():
    roles = [("common", "ok"), ("doca_ofed", "running")]
    lines, complete = ir.render(_state(roles, status="running"), exit_code=143)
    text = _text(lines)
    assert complete is False
    assert "… doca_ofed" in text
    assert "INCOMPLETE: 1 of 5 roles applied, interrupted during doca_ofed, 3 not run" in text


def test_header_carries_preset_start_time_and_duration():
    state = _state(
        [(r, "ok") for r in EXPECTED], status="completed", started=1000.0, updated=1252.0
    )
    lines, _ = ir.render(state, exit_code=0)
    header = lines[0]
    assert "preset default" in header
    assert "4 min 12 s" in header


def test_missing_state_reports_that_no_roles_ran():
    lines, complete = ir.render(None, exit_code=4, log_path="/tmp/x.log")
    text = _text(lines)
    assert complete is False
    assert "No roles ran" in text
    assert "exit 4" in text
    assert "Log: /tmp/x.log" in text


def test_state_older_than_this_run_is_treated_as_absent():
    state = _state([(r, "ok") for r in EXPECTED], status="completed", started=1000.0)
    lines, complete = ir.render(state, exit_code=1, run_started=2000.0)
    assert complete is False
    assert "No roles ran" in _text(lines)


def test_state_from_this_run_is_not_treated_as_stale():
    state = _state([(r, "ok") for r in EXPECTED], status="completed", started=2001.0)
    _, complete = ir.render(state, exit_code=0, run_started=2000.0)
    assert complete is True


def test_render_never_uses_color_unless_asked():
    state = _state([(r, "ok") for r in EXPECTED], status="completed")
    plain, _ = ir.render(state, exit_code=0)
    colored, _ = ir.render(state, exit_code=0, color=True)
    assert "\033[" not in _text(plain)
    assert "\033[" in _text(colored)


def test_load_state_tolerates_missing_and_corrupt_files(tmp_path):
    assert ir.load_state(tmp_path / "absent.json") is None
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert ir.load_state(bad) is None
    good = tmp_path / "good.json"
    good.write_text(json.dumps({"status": "completed", "roles": []}))
    assert ir.load_state(good) == {"status": "completed", "roles": []}


# ── script entry point (bash surfaces) ────────────────────────────────────────


def test_script_prints_the_report_and_exits_zero_even_for_a_failed_install(tmp_path):
    state_file = tmp_path / "install-state.json"
    roles = [("common", "ok"), ("doca_ofed", "failed")]
    state_file.write_text(json.dumps(_state(roles, status="failed")))
    proc = subprocess.run(
        [
            sys.executable,
            str(MODULE),
            "--state",
            str(state_file),
            "--exit-code",
            "2",
            "--log",
            "/var/log/xinas/install.log",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert "INCOMPLETE: 1 of 5 roles applied, failed at doca_ofed, 3 not run" in proc.stdout
    assert "Log: /var/log/xinas/install.log" in proc.stdout


def test_script_reports_no_roles_ran_when_the_state_file_is_missing(tmp_path):
    proc = subprocess.run(
        [sys.executable, str(MODULE), "--state", str(tmp_path / "nope.json"), "--exit-code", "4"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0
    assert "No roles ran" in proc.stdout and "exit 4" in proc.stdout


def test_module_imports_only_the_standard_library():
    # The bash surfaces run this file with the system python3 before the
    # management venv (and Textual) exist.
    tree = ast.parse(MODULE.read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert imported <= set(sys.stdlib_module_names), imported - set(sys.stdlib_module_names)
