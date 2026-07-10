"""WS3.4 (T8, F9): autoinstall.sh must abort the moment any single preset-file
copy fails, never fall through to `ok "Preset applied"` against a mixed
preset (docs/Installer/spec.md §7.8).

Behavioral: extracts the real copy_if() function and the real six call sites
from autoinstall.sh and executes them in a sandbox where one destination
directory is missing (cp fails), asserting the block aborts before the
"Preset applied" line. Running the whole script requires root (the EUID
check gates step 6), so the guarded-call pattern is extracted and exercised
directly, per this plan's documented fallback.
"""

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "autoinstall.sh"
SRC = SCRIPT.read_text()


def _extract_copy_block() -> str:
    fn = re.search(r"^copy_if\(\) \{.*?^\}", SRC, re.M | re.S)
    calls = re.search(
        r'^copy_if "\$preset_path/network\.yml".*?^ok "Preset applied"',
        SRC,
        re.M | re.S,
    )
    assert fn and calls, "copy_if function or call block not found in autoinstall.sh"
    return fn.group(0) + "\n" + calls.group(0)


def _stub_prelude() -> str:
    return (
        "info() { :; }\n"
        'fail() { echo "FAIL: $1" >&2; }\n'
        'die() { fail "$1"; exit 1; }\n'
        'ok() { echo "OK: $1"; }\n'
    )


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_failed_copy_aborts_before_preset_applied(tmp_path):
    preset_dir = tmp_path / "presets" / "default"
    preset_dir.mkdir(parents=True)
    (preset_dir / "network.yml").write_text("net: 1\n")
    # collection/roles/net_controllers/defaults/ deliberately does NOT exist,
    # so `cp` fails for network.yml; the other five preset files are absent,
    # so copy_if short-circuits (return 0) for them.

    snippet = (
        "set -uo pipefail\n"
        'preset_dir_name="default"\n'
        f'preset_path="{preset_dir}"\n'
        + _stub_prelude()
        + _extract_copy_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode != 0, proc.stdout
    assert "REACHED_END" not in proc.stdout
    assert "Preset applied" not in proc.stdout


def test_all_copies_succeed_reaches_preset_applied(tmp_path):
    preset_dir = tmp_path / "presets" / "default"
    preset_dir.mkdir(parents=True)
    (preset_dir / "network.yml").write_text("net: 1\n")
    dest_dir = tmp_path / "collection/roles/net_controllers/defaults"
    dest_dir.mkdir(parents=True)

    snippet = (
        "set -uo pipefail\n"
        'preset_dir_name="default"\n'
        f'preset_path="{preset_dir}"\n'
        + _stub_prelude()
        + _extract_copy_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "REACHED_END" in proc.stdout
    assert "Preset applied" in proc.stdout
