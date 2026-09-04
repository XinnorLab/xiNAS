"""The wizard's existing-filesystem step (raid-spec.md §11).

`simple_menu.sh`'s reuse path keeps the arrays and only creates the filesystem,
so whatever a reused array already carries decides what happens next. Two bugs
this module pins, both reported from a bench run:

1. **`xfs_external_log` on the LOG device is not a foreign signature.** It is
   the external journal of the XFS on the data device — the normal state of a
   pair a previous xiNAS install left behind. The first version of this step
   listed it as foreign and offered only "reformat or go away", i.e. it told the
   operator their own previous install was junk. The DATA device decides; an XFS
   there is offered back before it is offered up for destruction.

2. **Backing out of the filesystem question is not declining the arrays.**
   `reuse_existing_arrays` returned 1 for both, and the caller turns 1 into
   `clean_install`, which offers to purge the xiRAID packages — right after the
   operator said to keep the arrays that need them. The two answers now have
   distinct exit codes: 1 = rebuild from scratch, 2 = go back to the menu.

`reuse_existing_arrays()` and `verify_existing_fs()` drive dialogs through
menu_lib.sh's TUI primitives, which read and write /dev/tty directly and cannot
be run headlessly (same constraint as
tests/test_existing_raid_install_no_purge.py). Both functions are extracted by
regex and executed verbatim with only those primitives, `blkid`, `mount` and
`xinas_config_set` stubbed, so the assertions cover the shipped code path rather
than a re-implementation of it.
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
VERIFY_FN = _extract_fn(SIMPLE_MENU, "verify_existing_fs")

# Two arrays, the shape detect_xiraid_arrays writes:
#   name|level|dev_count|strip|state|dev_list
ARRAYS_FILE = (
    "data|5|10|128|online,initialized|/dev/sdd /dev/sde\n"
    "log|1|2|16|online,initialized|/dev/sdb /dev/sdc\n"
)

# Everything the two functions call other than the code under test. Answers are
# supplied per test: MENU_ANSWERS feeds menu_select in call order (DATA array,
# LOG array, then the filesystem choice), YESNO_ANSWERS feeds yes_no.
STUBS = r"""
# The same options simple_menu.sh itself runs under: `set -e` turns a stray
# non-zero probe into an aborted wizard, so the harness must reproduce it.
set -euo pipefail
TMP_DIR="$PWD/tmp"; mkdir -p "$TMP_DIR"
XINAS_LOCAL_LAYER="$PWD/overlay.yml"
printf -- '---\n' > "$XINAS_LOCAL_LAYER"
printf '%s' "$ARRAYS_TXT" > "$TMP_DIR/arrays.txt"

# menu_select/input_box are called inside $(...), i.e. in a subshell, so a
# shell-variable cursor would never advance in the parent. Keep it on disk.
_bump() {
    local f="$PWD/.cursor.$1" i
    i=$(cat "$f" 2>/dev/null || echo 0)
    echo $((i + 1)) > "$f"
    printf '%s' "$i"
}
_nth() {
    local i="$1"; shift
    local n=0 a
    for a in "$@"; do
        if [ "$n" = "$i" ]; then printf '%s' "$a"; return 0; fi
        n=$((n + 1))
    done
    return 1   # out of scripted answers == the operator pressed Esc
}

yes_no() {
    echo "YESNO|$1|${3:-y}" >> "$PWD/calls.log"
    [ "$(_nth "$(_bump yn)" $YESNO_ANSWERS)" = "y" ]
}
menu_select() {
    echo "MENU|$1" >> "$PWD/calls.log"
    _nth "$(_bump sel)" $MENU_ANSWERS
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

# MOUNT_RC decides whether the existing pair mounts.
mount() {
    echo "MOUNT|$*" >> "$PWD/calls.log"
    if [ "${MOUNT_RC:-0}" != "0" ]; then
        echo "mount: wrong fs type, bad superblock on /dev/xi_data"
        return 32
    fi
    return 0
}
umount() { echo "UMOUNT|$*" >> "$PWD/calls.log"; return 0; }
"""


def _run(
    tmp_path: Path,
    *,
    blkid_type: str = "",
    blkid_label: str = "",
    menu: str = "data log reuse",
    answers: str = "y y y",
    label: str = "nfsdata",
    mount_rc: str = "0",
):
    # `rc=0; f || rc=$?` and not a bare call: under `set -e` a non-zero return
    # from a bare call aborts the shell before the echo. This is also exactly how
    # the caller in simple_menu.sh reads the code.
    script = (
        STUBS
        + VERIFY_FN
        + "\n"
        + REUSE_FN
        + '\nrc=0; reuse_existing_arrays || rc=$?; echo "RC=$rc"\n'
    )
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
            "MENU_ANSWERS": menu,
            "YESNO_ANSWERS": answers,
            "WANTED_LABEL": label,
            "MOUNT_RC": mount_rc,
        },
    )


def _calls(tmp_path: Path) -> list[str]:
    log = tmp_path / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def _rc(proc) -> int:
    m = re.search(r"RC=(\d+)", proc.stdout)
    assert m, f"no RC in output: {proc.stdout!r} / {proc.stderr!r}"
    return int(m.group(1))


def _fs_menus(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("MENU|") and "Filesystem" in c]


# --- the reported bug ------------------------------------------------------


def test_previous_install_pair_is_offered_back_not_condemned(tmp_path):
    """data=XFS + log=xfs_external_log is a healthy pair, not a foreign signature."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log reuse",
    )
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    # The offer, not the warning: the operator can keep their data.
    assert _fs_menus(calls) == ["MENU|💾 Existing Filesystem Found"], calls
    # Reuse must not force a reformat.
    assert "CONFIG|xinas_fs_force_format|false" in calls, calls


def test_reuse_test_mounts_the_pair_and_leaves_it_unmounted(tmp_path):
    """The playbook must start from the same state it would have without the check."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log reuse",
    )
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    mounts = [c for c in calls if c.startswith("MOUNT|")]
    assert len(mounts) == 1, calls
    assert "logdev=/dev/xi_log" in mounts[0]
    assert "/dev/xi_data" in mounts[0]
    assert [c for c in calls if c.startswith("UMOUNT|")], calls


def test_reuse_adopts_the_label_that_is_on_disk(tmp_path):
    """raid_fs converges on the configured label; retyping it is a trap."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=olddata",
        menu="data log reuse",
        label="nfsdata",  # what the operator would have typed
    )
    assert _rc(proc) == 0, proc.stderr
    written = (tmp_path / "tmp" / "raid_config.yml").read_text()
    assert 'label: "olddata"' in written, written
    assert "nfsdata" not in written


def test_reformat_of_an_existing_pair_sets_the_force_flag(tmp_path):
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log reformat",
    )
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    assert "CONFIG|xinas_fs_force_format|true" in calls, calls
    assert not [c for c in calls if c.startswith("MOUNT|")], "must not mount what it will destroy"


# --- genuinely foreign, and the empty cases --------------------------------


def test_non_xfs_on_the_data_device_is_the_warning_variant(tmp_path):
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=ext4",
        menu="data log cancel",
    )
    calls = _calls(tmp_path)
    assert _rc(proc) == 2, proc.stdout
    assert _fs_menus(calls) == ["MENU|⚠️  Existing Filesystem Found"], calls


def test_clean_devices_ask_nothing(tmp_path):
    proc = _run(tmp_path, blkid_type="", blkid_label="")
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    assert _fs_menus(calls) == []
    assert "CONFIG|xinas_fs_force_format|false" in calls, calls


def test_stale_log_signature_alone_is_not_a_question(tmp_path):
    """Nothing to reuse: mkfs runs on a fresh data device and rewrites the log."""
    proc = _run(tmp_path, blkid_type="/dev/xi_log=xfs_external_log")
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    assert _fs_menus(calls) == []
    assert "CONFIG|xinas_fs_force_format|false" in calls, calls


# --- exit codes: 1 rebuilds, 2 goes back -----------------------------------


def test_declining_the_arrays_still_returns_1(tmp_path):
    """The one answer that should reach clean_install (and its purge offer)."""
    proc = _run(tmp_path, answers="n")
    assert _rc(proc) == 1, proc.stdout


def test_backing_out_of_the_filesystem_question_returns_2(tmp_path):
    """Not a request to rebuild: the operator already chose to keep the arrays."""
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log",  # Esc at the filesystem menu
    )
    assert _rc(proc) == 2, proc.stdout


def test_backing_out_of_the_array_pickers_returns_2(tmp_path):
    proc = _run(tmp_path, menu="")  # Esc at the DATA array picker
    assert _rc(proc) == 2, proc.stdout


def test_declining_the_final_confirmation_returns_2(tmp_path):
    proc = _run(tmp_path, answers="y n")
    assert _rc(proc) == 2, proc.stdout


# --- the mount test actually gates -----------------------------------------


def test_a_pair_that_does_not_mount_offers_a_reformat(tmp_path):
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log reuse",
        mount_rc="32",
        answers="y y y",  # reuse arrays, reformat instead, confirm
    )
    calls = _calls(tmp_path)
    assert _rc(proc) == 0, proc.stderr
    assert [c for c in calls if c.startswith("MSGBOX|❌ Filesystem Does Not Mount")], calls
    assert "CONFIG|xinas_fs_force_format|true" in calls, calls


def test_declining_the_reformat_after_a_failed_mount_returns_2(tmp_path):
    proc = _run(
        tmp_path,
        blkid_type="/dev/xi_data=xfs /dev/xi_log=xfs_external_log",
        blkid_label="/dev/xi_data=nfsdata",
        menu="data log reuse",
        mount_rc="32",
        answers="y n",
    )
    assert _rc(proc) == 2, proc.stdout


# --- the caller must honour the distinction --------------------------------


def test_only_exit_code_1_reaches_clean_install():
    """Structural: the caller's case arm, where the purge offer actually lives."""
    m = re.search(r"reuse_existing_arrays \|\| reuse_rc=\$\?(.*?)esac", SIMPLE_MENU, re.S)
    assert m, "the reuse caller no longer reads an exit code"
    arms = m.group(1)
    assert re.search(r"^\s*1\)\s*clean_install", arms, re.M), arms
    # Any other non-zero code must not.
    assert not re.search(r"^\s*\*\)\s*clean_install", arms, re.M), arms
