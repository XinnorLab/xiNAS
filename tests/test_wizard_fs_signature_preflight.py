"""Wizard-side preflight for foreign filesystem signatures (raid-spec.md §11).

`simple_menu.sh`'s reuse path leaves the arrays alone and only creates the
filesystem, so it lands on §11's FOREIGN case whenever the reused array already
carries something that is not XFS with the configured label. Before this branch
the wizard wrote its configuration regardless and `site.yml` discovered the
signature ~20 minutes later, inside `create_fs.yml`:

    Existing filesystem '' (xfs_external_log) on /dev/xi_data does not match the
    expected label 'nfsdata' (state=FOREIGN) ... Refusing to reformat.

That failure is correct but arrives at the wrong time: the data device, the
label and the operator are all present while the wizard is still on screen.
This module pins the probe the wizard now runs after the DATA/LOG/mountpoint/
label questions and before `Confirm Configuration`.

`reuse_existing_arrays()` drives dialogs through menu_lib.sh's TUI primitives,
which read and write /dev/tty directly and cannot be run headlessly (same
constraint as tests/test_existing_raid_install_no_purge.py). The real function
is extracted by regex and executed verbatim with only those primitives, `blkid`
and `xinas_config_set` stubbed, so the assertions cover the shipped code path
rather than a re-implementation of it.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIMPLE_MENU = (REPO / "simple_menu.sh").read_text()


def _extract_fn(src: str, name: str) -> str:
    m = re.search(rf"^{re.escape(name)}\(\) \{{.*?^\}}", src, re.M | re.S)
    assert m, f"{name}() not found in source"
    return m.group(0)


REUSE_FN = _extract_fn(SIMPLE_MENU, "reuse_existing_arrays")

# Two arrays, the shape detect_xiraid_arrays writes:
#   name|level|dev_count|strip|state|dev_list
ARRAYS_FILE = "data|5|10|128|online,initialized|/dev/sdd /dev/sde\nlog|1|2|16|online,initialized|/dev/sdb /dev/sdc\n"

# Everything reuse_existing_arrays() calls other than the probe under test.
# yes_no records each (title, default) pair it is asked and answers from
# YESNO_ANSWERS, one per call, so a test can accept the reuse question and
# decline the force question. menu_select/input_box return the DATA array, the
# LOG array, the mountpoint and the label in call order.
STUBS = r"""
# The same options simple_menu.sh itself runs under: `set -e` turns a stray
# non-zero probe into an aborted wizard, so the harness must reproduce it.
set -euo pipefail
TMP_DIR="$PWD/tmp"; mkdir -p "$TMP_DIR"
XINAS_LOCAL_LAYER="$PWD/overlay.yml"
printf -- '---\n' > "$XINAS_LOCAL_LAYER"
printf '%s' "$ARRAYS_TXT" > "$TMP_DIR/arrays.txt"

: "${YESNO_ANSWERS:=}"
_yn_i=0
yes_no() {
    echo "YESNO|$1|${3:-y}" >> "$PWD/calls.log"
    local -a answers=($YESNO_ANSWERS)
    local ans="${answers[$_yn_i]:-y}"
    _yn_i=$((_yn_i + 1))
    [ "$ans" = "y" ]
}
# menu_select/input_box are called inside $(...), i.e. in a subshell, so a
# shell-variable cursor would never advance in the parent. Keep it on disk.
_bump() {
    local f="$PWD/.cursor.$1" i
    i=$(cat "$f" 2>/dev/null || echo 0)
    echo $((i + 1)) > "$f"
    printf '%s' "$i"
}
menu_select() {
    case "$(_bump sel)" in 0) printf 'data' ;; *) printf 'log' ;; esac
}
input_box() {
    case "$(_bump inp)" in 0) printf '/mnt/data' ;; *) printf '%s' "$WANTED_LABEL" ;; esac
}
text_box() { echo "TEXTBOX|$1" >> "$PWD/calls.log"; }
msg_box()  { echo "MSGBOX|$1|$2" >> "$PWD/calls.log"; }
xinas_config_set() { echo "CONFIG|$2|$3" >> "$PWD/calls.log"; }
yq() { :; }

# The probe's only view of the devices. BLKID_TYPE/BLKID_LABEL are
# "<dev>=<value>" pairs; anything not listed reads as no signature.
blkid() {
    local want_label=0 dev=""
    for a in "$@"; do
        case "$a" in
            LABEL) want_label=1 ;;
            /dev/*) dev="$a" ;;
        esac
    done
    local pairs="$BLKID_TYPE"; [ "$want_label" = 1 ] && pairs="$BLKID_LABEL"
    for p in $pairs; do
        case "$p" in
            "${dev}="*) printf '%s\n' "${p#*=}"; return 0 ;;
        esac
    done
    return 2
}
"""


def _run(
    tmp_path: Path, *, blkid_type: str, blkid_label: str, answers: str, label: str = "nfsdata"
):
    script = STUBS + REUSE_FN + '\nreuse_existing_arrays; echo "RC=$?"\n'
    return subprocess.run(
        ["bash", "-c", script],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        env={
            "PATH": "/usr/bin:/bin",
            "ARRAYS_TXT": ARRAYS_FILE,
            "BLKID_TYPE": blkid_type,
            "BLKID_LABEL": blkid_label,
            "YESNO_ANSWERS": answers,
            "WANTED_LABEL": label,
        },
    )


def _calls(tmp_path: Path) -> list[str]:
    log = tmp_path / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def _force_prompts(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("YESNO|") and "force" in c.lower()]


def test_clean_devices_never_ask_to_force(tmp_path):
    """Nothing on either device: the wizard proceeds without a force question."""
    proc = _run(tmp_path, blkid_type="", blkid_label="", answers="y y")
    calls = _calls(tmp_path)
    assert "RC=0" in proc.stdout, proc.stderr
    assert _force_prompts(calls) == []
    # The key is still written, pinned to false: the overlay states the answer
    # rather than leaning on the role default, as the reuse path already does
    # for nvme_auto_namespace / xiraid_skip_install.
    assert "CONFIG|xinas_fs_force_format|false" in calls, calls


def test_matching_xfs_is_reused_without_forcing(tmp_path):
    """An XFS whose label matches converges; §11 says mkfs must not run."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs",
        blkid_label="/dev/xi_data=nfsdata",
        answers="y y",
    )
    calls = _calls(tmp_path)
    assert "RC=0" in proc.stdout, proc.stderr
    assert _force_prompts(calls) == []
    assert "CONFIG|xinas_fs_force_format|false" in calls, calls


def test_foreign_signature_asks_to_force_and_defaults_to_no(tmp_path):
    """The exact signature from the 2026-09-03 bench run must raise the gate."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs_external_log",
        blkid_label="",
        answers="y n",
    )
    calls = _calls(tmp_path)
    prompts = _force_prompts(calls)
    assert len(prompts) == 1, calls
    # Default-No: a stray Enter must not authorise a reformat.
    assert prompts[0].endswith("|n"), prompts[0]
    # Declined -> the wizard returns non-zero (caller falls back to a clean
    # install) and writes no force flag.
    assert "RC=0" not in proc.stdout, proc.stdout
    assert not [c for c in calls if c.startswith("CONFIG|xinas_fs_force_format")]


def test_confirmed_force_writes_the_overlay_flag(tmp_path):
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs_external_log",
        blkid_label="",
        answers="y y y",
    )
    calls = _calls(tmp_path)
    assert "RC=0" in proc.stdout, proc.stderr
    assert "CONFIG|xinas_fs_force_format|true" in calls, calls


def test_wrong_label_on_xfs_is_foreign_too(tmp_path):
    """An XFS carrying someone else's label is data, not a converge target."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs",
        blkid_label="/dev/xi_data=otherfs",
        answers="y n",
    )
    assert "RC=0" not in proc.stdout
    assert len(_force_prompts(_calls(tmp_path))) == 1


def test_signature_on_the_log_device_alone_still_gates(tmp_path):
    """mkfs writes the external log too; a stale log signature must be shown."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_log=xfs_external_log",
        blkid_label="",
        answers="y n",
    )
    assert "RC=0" not in proc.stdout
    assert len(_force_prompts(_calls(tmp_path))) == 1
