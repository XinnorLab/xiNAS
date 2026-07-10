"""WS3 (T6, F7): a missing or failing ./hwkey must not kill the whole menu
under `set -euo pipefail`. Two failure vectors in enter_license():
`[ -x ./hwkey ] || chmod +x ./hwkey` (chmod on a missing file fails) and
`hwkey_val=$(./hwkey | tr ... | tr ...)` (pipefail surfaces a failure
anywhere in the pipe, not just the last stage).

Extracts the two exact guarded lines from each real file (so this fails if a
future edit removes the guard) and executes them under set -euo pipefail
with a real failing/missing ./hwkey — proving the menu script survives.
Avoids driving the full interactive enter_license() function, which reads
the hardcoded absolute path /tmp/license and would be unsafe to exercise
against a real machine's /tmp/license.
"""

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _extract_hwkey_lines(script: str) -> tuple[str, str]:
    text = (REPO / script).read_text()
    chmod_line = re.search(r"^\s*\[ -x \./hwkey \] \|\| chmod \+x \./hwkey.*$", text, re.M)
    pipe_line = re.search(r"^\s*hwkey_val=\$\(\./hwkey.*$", text, re.M)
    assert chmod_line, f"{script}: hwkey chmod-guard line not found"
    assert pipe_line, f"{script}: hwkey_val pipe line not found"
    return chmod_line.group(0).strip(), pipe_line.group(0).strip()


def _run(
    script: str, tmp_path: Path, *, hwkey_exists: bool, hwkey_body: str = "exit 1\n"
) -> subprocess.CompletedProcess:
    chmod_line, pipe_line = _extract_hwkey_lines(script)
    if hwkey_exists:
        hwkey = tmp_path / "hwkey"
        hwkey.write_text(f"#!/bin/bash\n{hwkey_body}")
        hwkey.chmod(0o755)
    snippet = (
        f'set -euo pipefail\n{chmod_line}\n{pipe_line}\necho "SURVIVED hwkey_val=[$hwkey_val]"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_startup_menu_survives_missing_hwkey(tmp_path):
    proc = _run("startup_menu.sh", tmp_path, hwkey_exists=False)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[]" in proc.stdout


def test_startup_menu_survives_failing_hwkey(tmp_path):
    proc = _run("startup_menu.sh", tmp_path, hwkey_exists=True)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[]" in proc.stdout


def test_startup_menu_working_hwkey_still_reports_value(tmp_path):
    proc = _run("startup_menu.sh", tmp_path, hwkey_exists=True, hwkey_body="echo abc123\n")
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[ABC123]" in proc.stdout


def test_simple_menu_survives_missing_hwkey(tmp_path):
    proc = _run("simple_menu.sh", tmp_path, hwkey_exists=False)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[]" in proc.stdout


def test_simple_menu_survives_failing_hwkey(tmp_path):
    proc = _run("simple_menu.sh", tmp_path, hwkey_exists=True)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[]" in proc.stdout


def test_simple_menu_working_hwkey_still_reports_value(tmp_path):
    proc = _run("simple_menu.sh", tmp_path, hwkey_exists=True, hwkey_body="echo abc123\n")
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout
    assert "hwkey_val=[ABC123]" in proc.stdout


def test_display_says_unavailable_rather_than_blank():
    """A failing/missing hwkey yields hwkey_val="" (see the guard above). The
    dialog must not then render a bare "HWKEY: " — it tells the operator to
    quote the key to support, so a blank field reads as a UI glitch rather
    than a failed hardware read. `${hwkey_val:-unavailable}` also covers the
    case where hwkey exits 0 but prints nothing.
    """
    for script in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / script).read_text()
        assert "HWKEY: ${hwkey_val:-unavailable}" in body, (
            f"{script}: hwkey dialog must substitute 'unavailable' for an "
            "empty hardware key, not render a blank"
        )
        assert "HWKEY: ${hwkey_val}\\n" not in body, (
            f"{script}: bare ${{hwkey_val}} in the dialog would render blank"
        )
