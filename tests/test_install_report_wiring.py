"""The bash install surfaces print the post-install role report
(docs/Installer/spec.md §2.9) and record the state it is rendered from.

Behavioral where the surface can be driven hermetically: `xinas_run_playbook`
is sourced from the real lib/menu_lib.sh and run with a stub
`ansible-playbook` that writes (or fails to write) an install-state.json,
the way the real callback would. `autoinstall.sh --status` is run for real.
The one thing that cannot be driven end-to-end — autoinstall.sh's full run
(root, license, apt) — is pinned structurally.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"
AUTOINSTALL = REPO / "autoinstall.sh"

EXPECTED = ["common", "doca_ofed", "xiraid_classic"]


def _state(roles, status):
    return {
        "status": status,
        "preset": "default",
        "started": 4102444800.0,  # far future: newer than any test's launch time
        "updated": 4102445052.0,
        "expected": EXPECTED,
        "roles": [{"role": r, "status": s, "ts": 0, "tasks": {}} for r, s in roles],
    }


def _stub_ansible(bin_dir: Path, *, exit_code: int, writes_state: dict | None) -> None:
    body = "#!/bin/bash\n"
    if writes_state is not None:
        payload = json.dumps(writes_state)
        body += f"printf '%s' '{payload}' > \"$XINAS_INSTALL_STATE_PATH\"\n"
    body += f"exit {exit_code}\n"
    (bin_dir / "ansible-playbook").write_text(body)
    (bin_dir / "ansible-playbook").chmod(0o755)


def _run_menu_lib(
    tmp_path: Path,
    *,
    exit_code: int,
    writes_state: dict | None,
    pre_existing=None,
    install_run: bool = True,
):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub_ansible(bin_dir, exit_code=exit_code, writes_state=writes_state)
    # A whiptail that answers "close" keeps the failure dialog from blocking.
    (bin_dir / "whiptail").write_text("#!/bin/bash\necho close >&2\nexit 0\n")
    (bin_dir / "whiptail").chmod(0o755)
    state_path = tmp_path / "install-state.json"
    if pre_existing is not None:
        state_path.write_text(json.dumps(pre_existing))
    env = dict(
        os.environ,
        PATH=f"{bin_dir}:{os.environ['PATH']}",
        XINAS_INSTALL_STATE_PATH=str(state_path),
    )
    env.pop("XINAS_RECORD_INSTALL_STATE", None)
    if install_run:
        # What both menus export for their install run (spec §7.7).
        env["XINAS_RECORD_INSTALL_STATE"] = "1"
    script = f'set -euo pipefail\nsource "{MENU_LIB}"\nxinas_run_playbook site.yml -i inventory\n'
    return subprocess.run(
        ["bash", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


# ── xinas_run_playbook (both bash menus) ──────────────────────────────────────


def test_menu_run_prints_the_role_report_after_a_successful_run(tmp_path):
    state = _state([(r, "ok") for r in EXPECTED], status="completed")
    proc = _run_menu_lib(tmp_path, exit_code=0, writes_state=state)
    assert proc.returncode == 0, proc.stderr
    assert "Install report" in proc.stdout, proc.stdout
    for role in EXPECTED:
        assert f"✓ {role}" in proc.stdout
    assert "COMPLETE: 3 of 3 roles applied" in proc.stdout


def test_menu_run_prints_the_role_report_before_the_failure_dialog(tmp_path):
    state = _state([("common", "ok"), ("doca_ofed", "failed")], status="failed")
    proc = _run_menu_lib(tmp_path, exit_code=2, writes_state=state)
    assert proc.returncode == 2
    assert "✗ doca_ofed" in proc.stdout
    assert "· xiraid_classic" in proc.stdout
    assert "INCOMPLETE: 1 of 3 roles applied, failed at doca_ofed, 1 not run" in proc.stdout


def test_menu_run_does_not_borrow_an_earlier_installs_state(tmp_path):
    # ansible-playbook died before its first play (wrote nothing); a state
    # file from a previous install is lying around. The report must say no
    # roles ran, not replay the old success.
    old = _state([(r, "ok") for r in EXPECTED], status="completed")
    old["started"] = 1000.0
    old["updated"] = 1200.0
    proc = _run_menu_lib(tmp_path, exit_code=4, writes_state=None, pre_existing=old)
    assert proc.returncode == 4
    assert "No roles ran" in proc.stdout, proc.stdout
    assert "COMPLETE: 3 of 3" not in proc.stdout


def test_day2_runs_that_record_no_state_get_no_report(tmp_path):
    # Without the install marker the callback recorded nothing; printing
    # "No roles ran" after a day-2 `--tags xinas_mcp` run would be a lie.
    state = _state([(r, "ok") for r in EXPECTED], status="completed")
    proc = _run_menu_lib(tmp_path, exit_code=0, writes_state=state, install_run=False)
    assert proc.returncode == 0, proc.stderr
    assert "Install report" not in proc.stdout
    assert "No roles ran" not in proc.stdout


def test_menu_run_still_returns_ansibles_exit_code_when_the_renderer_is_missing(tmp_path):
    # The report must never change the install's exit status — even if the
    # renderer cannot be found (e.g. a checkout without xinas_menu/).
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub_ansible(bin_dir, exit_code=0, writes_state=None)
    (bin_dir / "python3").write_text("#!/bin/bash\nexit 127\n")
    (bin_dir / "python3").chmod(0o755)
    env = dict(
        os.environ,
        PATH=f"{bin_dir}:{os.environ['PATH']}",
        XINAS_INSTALL_STATE_PATH=str(tmp_path / "state.json"),
    )
    script = f'set -euo pipefail\nsource "{MENU_LIB}"\nxinas_run_playbook site.yml\necho "rc=$?"\n'
    proc = subprocess.run(
        ["bash", "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60
    )
    assert proc.returncode == 0, proc.stderr
    assert "rc=0" in proc.stdout


def test_both_bash_menus_record_install_state():
    # The callback only records when the menu exports this; simple_menu.sh —
    # the default path — used to leave it unset, so the default install never
    # recorded anything.
    for name in ("simple_menu.sh", "startup_menu.sh"):
        body = (REPO / name).read_text()
        assert re.search(r"^export XINAS_RECORD_INSTALL_STATE=1$", body, re.M), (
            f"{name} does not export XINAS_RECORD_INSTALL_STATE=1"
        )


# ── autoinstall.sh ────────────────────────────────────────────────────────────


def _run_autoinstall_status(tmp_path: Path, state, *extra):
    state_path = tmp_path / "install-state.json"
    if state is not None:
        state_path.write_text(json.dumps(state))
    env = dict(os.environ, XINAS_INSTALL_STATE_PATH=str(state_path))
    return subprocess.run(
        ["bash", str(AUTOINSTALL), "--status", *extra],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_autoinstall_status_prints_the_role_table(tmp_path):
    state = _state([("common", "ok"), ("doca_ofed", "failed")], status="failed")
    proc = _run_autoinstall_status(tmp_path, state)
    assert proc.returncode == 0, proc.stderr
    assert "✗ doca_ofed" in proc.stdout
    assert "INCOMPLETE: 1 of 3 roles applied, failed at doca_ofed, 1 not run" in proc.stdout


def test_autoinstall_status_json_prints_the_raw_state(tmp_path):
    state = _state([("common", "ok")], status="completed")
    proc = _run_autoinstall_status(tmp_path, state, "--json")
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == state


def test_autoinstall_status_without_state_exits_one(tmp_path):
    proc = _run_autoinstall_status(tmp_path, None)
    assert proc.returncode == 1
    assert "No install state recorded" in proc.stderr


def test_autoinstall_prints_the_report_after_the_playbook_run():
    body = AUTOINSTALL.read_text()
    run = body.index('"${ansible_cmd[@]}" 2>&1 | tee -a "$LOG_FILE"')
    tail = body[run:]
    m = re.search(r"(render_install_report|install_report\.py)[^\n]*--exit-code \"\$rc\"", tail)
    assert m, "autoinstall.sh does not render the role report with the run's exit code"
    assert "--since" in tail[m.start() : m.end() + 200], "the report must ignore a stale state file"
    # The renderer wrapper itself must call the standard-library module.
    assert re.search(r"render_install_report\(\) \{[^}]*install_report\.py", body, re.S)


def test_autoinstall_help_documents_status_json():
    body = AUTOINSTALL.read_text()
    assert "--json" in body and "--status" in body
    m = re.search(r"--json\)\s+", body)
    assert m, "autoinstall.sh does not parse --json"
