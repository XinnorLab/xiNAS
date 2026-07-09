"""WS2.2: uninstall.sh safety — dry-run must not delete, flags are per-question.

Structural asserts on the script text (the repo's pattern for bash surfaces;
see tests/test_storage_role_structure.py, tests/test_agent_unit.py).

Two verified defects pinned here:
(a) DRY_RUN only added --check --diff to the ansible-playbook invocation; the
    final `rm -rf "$INSTALL_DIR"` ran unconditionally, so `--dry-run` still
    deleted /opt/xiNAS.
(b) Any single --remove-* flag set the GLOBAL INTERACTIVE="false", silencing
    the other two "remove this shared component too?" questions — only
    --yes/-y (SKIP_GATE) should do that.
"""

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "uninstall.sh"
SRC = SCRIPT.read_text()


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_rm_rf_is_dry_run_guarded():
    assert re.search(
        r'if\s+\[\[\s+"\$DRY_RUN"\s+==\s+"true"\s+\]\]\s*;?\s*then'
        r'.*?else.*?rm -rf "\$INSTALL_DIR".*?fi',
        SRC,
        re.S,
    ), "rm -rf $INSTALL_DIR must be guarded by the dry-run check (WS2.2)"


def test_remove_flags_do_not_disable_all_prompting():
    # The bug: the INTERACTIVE="false" assignment guarded by an `if` whose
    # condition mentions any FLAG_*_GIVEN var (not just SKIP_GATE).
    interactive_false_guard = re.search(
        r'if\s+\[\[([^\]]*?)\]\];\s*then\s*\n\s*INTERACTIVE="false"',
        SRC,
    )
    assert interactive_false_guard is not None, 'expected an INTERACTIVE="false" guard'
    condition = interactive_false_guard.group(1)
    assert "FLAG_XIRAID_GIVEN" not in condition
    assert "FLAG_OFED_GIVEN" not in condition
    assert "FLAG_PERF_GIVEN" not in condition
    assert "SKIP_GATE" in condition
    assert 'SKIP_GATE" == "true"' in SRC


def test_only_skip_gate_sets_interactive_false():
    # There must be exactly one place that ASSIGNS INTERACTIVE="false", and
    # it must be reachable only via SKIP_GATE. All other INTERACTIVE mentions
    # are reads.
    assignments = re.findall(r'INTERACTIVE="false"', SRC)
    assert len(assignments) == 1


def test_summary_caveat_is_dry_run_gated():
    # The "(dry-run ... no changes applied)" summary line must sit inside a
    # DRY_RUN == true guard, not print unconditionally.
    m = re.search(r"\(dry-run[^\)]*no changes applied[^\)]*\)", SRC)
    assert m, "dry-run summary caveat line must be present"
    window = SRC[max(0, m.start() - 300) : m.start()]
    assert re.search(r'if\s+\[\[\s+"\$DRY_RUN"\s+==\s+"true"\s+\]\]', window), (
        "dry-run summary caveat must be gated by DRY_RUN == true, not printed always"
    )
