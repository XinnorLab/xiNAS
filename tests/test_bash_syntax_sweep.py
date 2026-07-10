"""Every *.sh in the repo must at least parse. Cheap, repo-wide guard —
complements the per-file `bash -n` checks already embedded in individual
test files (test_uninstall_script_safety.py, etc.) with one sweep that
catches new scripts automatically.
"""

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__"}


def _all_shell_scripts():
    for p in REPO.rglob("*.sh"):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        yield p


def test_every_shell_script_parses():
    scripts = list(_all_shell_scripts())
    assert scripts, "no *.sh files found — sweep glob is broken"
    failures = []
    for script in scripts:
        proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        if proc.returncode != 0:
            failures.append(f"{script.relative_to(REPO)}: {proc.stderr.strip()}")
    assert not failures, "bash -n failed for:\n" + "\n".join(failures)
