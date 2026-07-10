"""WS3.3 (T3, F4): check_for_updates must run synchronously so its
UPDATE_AVAILABLE / UPDATE_TARGET_TAG assignments are visible to the parent
shell that prints the "Update available!" banner — bash never propagates a
background subshell's variables back to its parent.

Behavioral: runs the real, unmodified menu under a pty (pty.fork() so
/dev/tty resolves to the child's controlling terminal — menu_select/msg_box
explicitly open /dev/tty). Stubs git/curl/timeout on PATH so
check_for_updates deterministically finds (or doesn't find) an update,
drives the main menu to Exit, and asserts on the captured transcript.

A cheap structural guard (no pty) complements this, following the existing
"static guard survives a constrained CI" precedent in
test_playbook_ticker_callback.py.

PRIMARY RISK guard: making the call synchronous means the menu now blocks
on a network call at startup. `_latest_release_tag`'s curl had no
--connect-timeout/--max-time, so on an air-gapped/blackholed network it
could hang for the OS TCP timeout (commonly ~2 minutes) or longer on a
stalled response. test_check_for_updates_bounded_when_curl_hangs proves the
bound is actually in place by stubbing curl to simulate a server that never
responds within the requested --max-time.

Harness notes (adapted from the initial draft after running it for real):
  * The pty child needs TERM set (menu_lib.sh / show_header call the real
    `clear` binary, which errors out "TERM environment variable not set"
    under `set -euo pipefail` and kills the whole script before it ever
    renders anything).
  * startup_menu.sh prints its own "Expert Mode" welcome screen gated
    behind a *blocking* `read -p "Press Enter to continue..."` before the
    main loop; simple_menu.sh's welcome screen does not block. `_drive`
    handles both by waiting for either prompt.
  * `suggest_vm_preset` (called by both scripts right before the main loop)
    shells out to `systemd-detect-virt` and, if it reports anything other
    than "none", opens an extra yes/no dialog the harness does not expect.
    Real CI runners are themselves virtualized (Azure-hosted GitHub Actions
    images), so leaving this unstubbed is flaky-by-construction: it may
    pass on a bare-metal dev box and hang in CI. All stub bin dirs pin
    `systemd-detect-virt` to bare-metal ("none") output.
"""

import os
import pty
import re
import select
import textwrap
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _base_stub_bin(tmp_path: Path) -> Path:
    """bin/ with the pieces every scenario needs regardless of the
    git/curl fixture: a no-op `timeout` (the tcp reachability probe is not
    under test here) and a `systemd-detect-virt` pinned to bare metal so
    `suggest_vm_preset` never opens its own dialog (see module docstring)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "timeout").write_text("#!/bin/bash\nexit 0\n")
    (bin_dir / "timeout").chmod(0o755)
    (bin_dir / "systemd-detect-virt").write_text("#!/bin/bash\necho none\nexit 1\n")
    (bin_dir / "systemd-detect-virt").chmod(0o755)
    return bin_dir


def _stub_bin(tmp_path: Path, *, latest_tag: str, current_tag: str) -> Path:
    bin_dir = _base_stub_bin(tmp_path)
    (bin_dir / "curl").write_text(f'#!/bin/bash\necho \'{{"tag_name": "{latest_tag}"}}\'\n')
    (bin_dir / "curl").chmod(0o755)
    (bin_dir / "git").write_text(
        textwrap.dedent(f"""\
        #!/bin/bash
        for a in "$@"; do
            if [[ "$a" == "describe" ]]; then
                echo "{current_tag}"
                exit 0
            fi
        done
        exit 0
        """)
    )
    (bin_dir / "git").chmod(0o755)
    return bin_dir


def _read_until(master: int, needles: list[str], timeout: float, output: bytearray) -> str | None:
    """Read from `master`, appending to `output`, until one of `needles`
    appears in the bytes read *during this call* (a stale needle already
    sitting in `output` from an earlier stage does not count — otherwise a
    screen that repeats the same footer text, e.g. "Press Enter to
    continue", would match instantly on the second wait instead of
    blocking for the real, later occurrence). Returns the matched needle,
    or None on timeout/EOF.
    """
    start = len(output)
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.5)
        if not r:
            continue
        try:
            chunk = os.read(master, 4096)
        except OSError:
            return None
        if not chunk:
            return None
        output.extend(chunk)
        text = output[start:].decode("utf-8", "replace")
        for needle in needles:
            if needle in text:
                return needle
    return None


def _drive(script_path: Path, sandbox: Path, bin_dir: Path) -> tuple[str, int]:
    driver = textwrap.dedent(f"""\
        cd "{sandbox}"
        export PATH="{bin_dir}:$PATH"
        export TERM=xterm
        exec bash "{script_path}"
        """)
    pid, master = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "-c", driver])
        os._exit(1)  # pragma: no cover — only reached on exec failure

    output = bytearray()

    # startup_menu.sh gates its welcome screen behind a blocking
    # `read -p "Press Enter to continue..."`; simple_menu.sh's welcome
    # screen does not block and goes straight to the main menu. Wait for
    # whichever appears.
    first = _read_until(master, ["Press Enter to continue", "Select an option:"], 10, output)
    if first == "Press Enter to continue":
        os.write(master, b"\n")
        _read_until(master, ["Select an option:"], 10, output)

    # Main menu is up. menu_select's numeric-key branch fires on a single
    # keypress (no Enter needed) — "0" selects Exit directly.
    os.write(master, b"0")

    # Exit renders its own msg_box ("See you soon!"), which blocks on a
    # plain `read -r </dev/tty` footer. Dismiss it so the script reaches
    # `exit 2`.
    _read_until(master, ["Press Enter to continue"], 10, output)
    os.write(master, b"\n")

    deadline = time.time() + 15
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.5)
        if not r:
            continue
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
    os.close(master)
    _, status = os.waitpid(pid, 0)
    return output.decode("utf-8", "replace"), os.WEXITSTATUS(status)


def _sandbox(tmp_path: Path) -> Path:
    sandbox = tmp_path / "repo"
    sandbox.mkdir()
    (sandbox / ".git").mkdir()
    return sandbox


def test_startup_menu_shows_banner_when_update_available(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v9.9.9", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "startup_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" in plain, (
        "banner did not appear -> check_for_updates' variables were not "
        f"visible to the parent shell.\n--- transcript ---\n{plain}"
    )


def test_startup_menu_no_banner_when_up_to_date(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v1.0.0", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "startup_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" not in plain


def test_simple_menu_shows_banner_when_update_available(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v9.9.9", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "simple_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" in plain


def test_no_backgrounded_call_site_remains():
    for f in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / f).read_text()
        assert not re.search(r"^check_for_updates\s*&\s*$", body, re.M), (
            f"{f} still backgrounds check_for_updates (F4)"
        )
        assert re.search(r"^check_for_updates\s*$", body, re.M), (
            f"{f} must call check_for_updates synchronously"
        )


# ── PRIMARY RISK: curl in _latest_release_tag must be bounded ──────────────
# Without --connect-timeout/--max-time, a synchronous check_for_updates can
# hang the menu at startup on an air-gapped/blackholed network. This stub
# curl interprets a --max-time argument the way real curl would: it aborts
# (empty stdout, exit 28) once that many seconds pass, standing in for a
# remote server that never responds. If the shipped curl call omits the
# flag, the stub falls through to a 10s sleep and the whole drive blows past
# the assertion below.
_STUB_CURL_HANGS = textwrap.dedent("""\
    #!/bin/bash
    max_time=999999
    prev=""
    for a in "$@"; do
        if [[ "$prev" == "--max-time" ]]; then
            max_time="$a"
        fi
        prev="$a"
    done
    sleep_for=10
    if (( max_time < sleep_for )); then
        sleep "$max_time"
        exit 28
    fi
    sleep "$sleep_for"
    echo '{"tag_name": "v9.9.9"}'
    """)


def test_check_for_updates_bounded_when_curl_hangs(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _base_stub_bin(tmp_path)
    (bin_dir / "curl").write_text(_STUB_CURL_HANGS)
    (bin_dir / "curl").chmod(0o755)
    (bin_dir / "git").write_text(
        textwrap.dedent("""\
        #!/bin/bash
        for a in "$@"; do
            if [[ "$a" == "describe" ]]; then
                echo "v1.0.0"
                exit 0
            fi
        done
        exit 0
        """)
    )
    (bin_dir / "git").chmod(0o755)

    for script in ("startup_menu.sh", "simple_menu.sh"):
        start = time.time()
        _, exit_code = _drive(REPO / script, sandbox, bin_dir)
        elapsed = time.time() - start
        assert exit_code == 2
        assert elapsed < 8.0, (
            f"{script} took {elapsed:.1f}s to reach Exit -> check_for_updates' "
            "curl call is not bounded by --connect-timeout/--max-time; a "
            "synchronous call would hang the menu on an unreachable GitHub "
            "(PRIMARY RISK)."
        )
