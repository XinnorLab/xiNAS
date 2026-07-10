"""WS3 (T5b): configure_git_repo repoints REPO_DIR at an arbitrary URL/branch
and `git pull origin <branch>` — a Release-Policy violation (CLAUDE.md: no
branch fallback in a user-facing update path). It is now a dev-only feature,
gated OFF by default behind XINAS_DEV_REPO_CONFIG=1, so it cannot be reached
in a normal expert session.

Behavioral: extracts and runs configure_git_repo() with the gate unset (must
refuse before touching any git remote/checkout/pull) and with the gate set
(must proceed past the gate). git/network calls are stubbed; the test asserts
on whether the destructive git operations were attempted.
"""

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = (REPO / "startup_menu.sh").read_text()


def _extract_fn(name: str) -> str:
    m = re.search(rf"^{name}\(\) \{{.*?^\}}", SRC, re.M | re.S)
    assert m, f"{name}() not found"
    return m.group(0)


def _run(tmp_path, *, gate: str | None):
    stub = tmp_path / "bin"
    stub.mkdir()
    gitlog = tmp_path / "git.log"
    (stub / "git").write_text(f'#!/bin/bash\necho "$@" >> "{gitlog}"\nexit 0\n')
    (stub / "git").chmod(0o755)
    # stub the menu-lib UI primitives configure_git_repo calls
    prelude = (
        "text_box() { :; }\n"
        "msg_box() { :; }\n"
        "yes_no() { return 0; }\n"  # "yes, modify"
        'input_box() { echo "https://evil.example/x.git"; }\n'  # url/branch
        f'TMP_DIR="{tmp_path}"\n'
    )
    env = {"PATH": f"{stub}:/usr/bin:/bin", "HOME": str(tmp_path)}
    if gate is not None:
        env["XINAS_DEV_REPO_CONFIG"] = gate
    snippet = (
        f"set -uo pipefail\n{prelude}\n{_extract_fn('configure_git_repo')}\nconfigure_git_repo\n"
    )
    proc = subprocess.run(
        ["bash", "-c", snippet], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20
    )
    calls = gitlog.read_text() if gitlog.exists() else ""
    return proc, calls


def test_gate_off_refuses_before_any_destructive_git(tmp_path):
    # Default (unset) must refuse: no remote set-url, no checkout, no pull/clone.
    proc, calls = _run(tmp_path, gate=None)
    assert "remote set-url" not in calls
    assert "checkout" not in calls
    assert "pull" not in calls
    assert "clone" not in calls


def test_gate_off_explicit_zero_also_refuses(tmp_path):
    proc, calls = _run(tmp_path, gate="0")
    assert "remote set-url" not in calls and "pull" not in calls


def test_gate_on_proceeds_past_the_guard(tmp_path):
    # With the dev gate set, it may attempt git ops (stubbed) — proving the
    # guard is what blocks it, not some unrelated failure.
    proc, calls = _run(tmp_path, gate="1")
    assert ("remote set-url" in calls) or ("clone" in calls), (
        f"gate on should reach the git ops; calls={calls!r} stderr={proc.stderr}"
    )


def test_menu_dispatch_still_present():
    # The menu still dispatches to configure_git_repo (the gate is inside the
    # function, so the entry can remain); if you also hide the entry, update
    # this test to match.
    assert "configure_git_repo" in SRC
