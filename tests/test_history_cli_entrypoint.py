"""Regression guard for finding #12 (InstallationFeedback-2026-05-28).

The deployed ``/usr/local/bin/xinas-history`` wrapper invokes the package as
``python3 -m xinas_history`` — from an arbitrary working directory, resolving
the package only via the venv editable install or ``PYTHONPATH=/opt/xiNAS``.
The previous role shipped neither, so the wrapper died with
``No module named xinas_history`` and the install's baseline snapshot silently
failed (#13).

These tests pin the entrypoint contract the wrapper depends on: invoked as a
subprocess, from a cwd *outside* the repo, with the package reachable only
through ``PYTHONPATH`` (the belt-and-suspenders the fixed wrapper sets),
``python -m xinas_history snapshot list --format json`` must exit 0 and emit
parseable JSON. Direct ``_cmd_*`` unit tests do not cover ``main()`` dispatch,
argparse wiring, or the module-execution path — exactly where #12 lived.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_cli(tmp_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Invoke the CLI the way the deployed wrapper does: as a module, from a
    cwd outside the repo, with the package reachable only via PYTHONPATH."""
    return subprocess.run(
        [sys.executable, "-m", "xinas_history", "--store-path", str(tmp_path), *args],
        cwd=tmp_path,  # NOT the repo root — mirrors the wrapper's arbitrary cwd
        env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )


def test_cli_entrypoint_snapshot_list_emits_json(tmp_path):
    result = _run_cli(tmp_path, "snapshot", "list", "--format", "json")
    assert result.returncode == 0, f"stderr: {result.stderr}"
    assert json.loads(result.stdout) == []


def test_cli_entrypoint_module_is_importable(tmp_path):
    # The bare module-execution path must resolve at all — this is the literal
    # `No module named xinas_history` failure mode of #12. `--help` drives the
    # full import chain (__main__ -> engine/store/yaml) with no gRPC/store side
    # effects and exits 0.
    result = _run_cli(tmp_path, "--help")
    assert "No module named xinas_history" not in result.stderr
    assert result.returncode == 0, f"stderr: {result.stderr}"
