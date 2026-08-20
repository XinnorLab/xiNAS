"""WS3.4 (T8, F9): autoinstall.sh must abort before reaching `ok "Preset
applied"` when preset application fails (docs/Installer/spec.md §7.8).

Preset application (docs/superpowers/plans/2026-08-18-preset-overlay.md
Task 2) replaced six `copy_if` calls — one per preset file, each copied onto
a git-tracked role `defaults/main.yml` — with a single `xinas_apply_preset`
call that merges the preset into the `playbooks/group_vars/all/10-preset.yml`
overlay instead. Fail-closed now rests on the `|| die` after that one call,
not six per-file checks.

Behavioral: extracts the real preset-apply block from autoinstall.sh and
executes it in a sandbox, asserting the block aborts before the "Preset
applied" line when `xinas_apply_preset` fails, and reaches it when the
preset applies cleanly. Running the whole script requires root (the EUID
check gates step 6), so the guarded-call pattern is extracted and exercised
directly, per this plan's documented fallback.
"""

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "autoinstall.sh"
SRC = SCRIPT.read_text()


def _extract_apply_block() -> str:
    block = re.search(
        r'^step "Applying preset: \$preset".*?^ok "Preset applied"',
        SRC,
        re.M | re.S,
    )
    assert block, "preset-apply block not found in autoinstall.sh"
    return block.group(0)


def _stub_prelude() -> str:
    return (
        "info() { :; }\n"
        'fail() { echo "FAIL: $1" >&2; }\n'
        'die() { fail "$1"; exit 1; }\n'
        'ok() { echo "OK: $1"; }\n'
    )


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_apply_failure_aborts_before_preset_applied(tmp_path):
    """No `presets/nope` directory, so xinas_apply_preset returns 2 and the
    `|| die` after it must fire before "Preset applied" is ever printed.

    REPO_DIR is pre-set to tmp_path (as autoinstall.sh's own self-derivation
    would resolve it there too, see lib/xinas_config.sh), so xinas_apply_preset
    looks for presets under an isolated sandbox rather than this real repo.
    """
    snippet = (
        "set -uo pipefail\n"
        f'SCRIPT_DIR="{REPO}"\n'
        f'REPO_DIR="{tmp_path}"\n'
        'preset="nope"\n'
        'preset_dir_name="nope"\n'
        + _stub_prelude()
        + _extract_apply_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=REPO, capture_output=True, text=True)
    assert proc.returncode != 0, proc.stdout
    assert "REACHED_END" not in proc.stdout
    assert "Preset applied" not in proc.stdout


def test_apply_success_reaches_preset_applied(tmp_path):
    """`preset` and `preset_dir_name` deliberately differ, the way autoinstall.sh
    itself sets them for --preset existing-raid (preset_dir_name="default").
    Only a presets/default directory exists, so the block must apply through
    $preset_dir_name — applying $preset instead would look up a directory
    that does not exist and fail closed instead of succeeding here.
    """
    preset_dir = tmp_path / "presets" / "default"
    preset_dir.mkdir(parents=True)
    (preset_dir / "raid_fs.yml").write_text("demo_key: 1\n")

    snippet = (
        "set -uo pipefail\n"
        f'SCRIPT_DIR="{REPO}"\n'
        f'REPO_DIR="{tmp_path}"\n'
        'preset="existing-raid"\n'
        'preset_dir_name="default"\n'
        + _stub_prelude()
        + _extract_apply_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=REPO, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "REACHED_END" in proc.stdout
    assert "Preset applied" in proc.stdout
    # Not just "did it exit 0" (a stub xinas_apply_preset would too) — the
    # preset's own content must have actually landed in the overlay.
    layer = (tmp_path / "playbooks/group_vars/all/10-preset.yml").read_text()
    assert "demo_key" in layer
