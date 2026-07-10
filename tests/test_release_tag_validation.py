"""WS3 Task 5c (code review hardening from T5): every bash site that checks
out a GitHub Release tag must validate it first, the way the privileged
`xinas-update-git` wrapper already does
(collection/roles/xinas_menu/files/xinas-update-git:32). T5 copied that
wrapper's `--force` flag to install.sh, prepare_system.sh, and both menus'
do_update() without the validation that makes `--force` safe: none of them
checked that the tag resolved from GitHub's API (via an unanchored
`grep -o '"tag_name":...' | sed` over the release JSON) was actually a
semver release tag before handing it to `git checkout`.

_is_release_tag() (lib/menu_lib.sh) is the single shared copy of the
wrapper's regex, sourced by prepare_system.sh/startup_menu.sh/simple_menu.sh.
install.sh cannot source the lib (it runs standalone, before/independently
of the clone), so it carries an inline, character-identical copy of the same
regex instead — not exercised here directly since it isn't a shell function,
but proven behaviorally via test_install_sh_refuses_injection_payload below.

Two defects motivated this, both reproduced manually before the fix (see the
task report for the transcripts, not reproduced as pytest assertions since
they exercise pre-fix code that no longer exists on disk):

1. install.sh's update path built a `bash -c "... '${RELEASE_TAG}' ..."`
   string in the OUTER shell, then handed it to an INNER `bash -c` to parse
   again — a single quote inside the tag broke out of the literal quoting
   and ran arbitrary commands. test_install_sh_refuses_injection_payload
   pins the fixed behavior (no nested shell at all, so there is nothing to
   break out of).

2. No bash checkout site validated the tag's shape, so an unanchored feed
   response (or a compromised/typo'd release name) could steer `git
   checkout --force` at `main`, `HEAD`, or an arbitrary ref. A trailing `--`
   separator is NOT a fix: `git checkout --force -- <tag>` treats <tag> as a
   PATHSPEC ("pathspec 'v1.0.0' did not match any file(s)"), and `git
   checkout --force <tag> --` still lets a `-`-prefixed tag be consumed as a
   flag (e.g. `--quiet` silently no-ops with exit 0, performing no
   checkout at all). test_prepare_system_update_only_refuses_non_release_tag
   pins the actual fix: refuse before ever calling git.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"
INSTALL_SH = REPO / "install.sh"
PREPARE_SYSTEM = REPO / "prepare_system.sh"

VALID_TAGS = ["v1.2.3", "1.2.3", "v1.2.3-rc.1", "v10.20.30"]
INVALID_TAGS = [
    "main",
    "HEAD",
    "origin/main",
    "--quiet",
    "v1.2",
    "v1.2.3.4",
    "",
    "v1.0.0'; echo pwned; echo '",
    "-v1.0.0",
]


def _is_release_tag(tag: str) -> subprocess.CompletedProcess:
    # Pass the tag as an argv element (`"$1"`), never interpolated into the
    # script string itself -- the same discipline the fix under test applies
    # to install.sh/prepare_system.sh/both menus.
    script = f'source "{MENU_LIB}" >/dev/null 2>&1; _is_release_tag "$1"'
    return subprocess.run(["bash", "-c", script, "_", tag], capture_output=True, text=True)


@pytest.mark.parametrize("tag", VALID_TAGS)
def test_is_release_tag_accepts_valid_release_tags(tag):
    proc = _is_release_tag(tag)
    assert proc.returncode == 0, f"{tag!r} should be accepted: {proc.stderr}"


@pytest.mark.parametrize("tag", INVALID_TAGS)
def test_is_release_tag_rejects_non_release_refs(tag):
    proc = _is_release_tag(tag)
    assert proc.returncode == 1, f"{tag!r} should be rejected"


def test_is_release_tag_injection_payload_leaves_no_trace():
    # Even the rejection check itself must never let the payload reach a
    # second shell -- assert on stdout/stderr, not just the exit code.
    proc = _is_release_tag("v1.0.0'; echo pwned; echo '")
    assert proc.returncode == 1
    assert "pwned" not in proc.stdout
    assert "pwned" not in proc.stderr


# ── Behavioral: install.sh's update path must not build a second shell's
# command string out of the tag ─────────────────────────────────────────────


def _extract_install_sh_checkout_block() -> str:
    # Bounded to exactly the tag-validation guard plus the update-vs-clone
    # conditional it protects -- the smallest extractable region around the
    # checkout call site (mirrors test_installer_exit_code_contract.py's
    # _extract_install_sh_prepare_block, which anchors on the surrounding
    # `if`/`fi` rather than the whole file). The validation `if` closes with
    # its own `fi` before the update-vs-clone `if` even starts, so the end
    # anchor is the update-vs-clone block's own distinctive closing lines,
    # not just the next bare "\nfi\n" (which would stop at the validation
    # guard's own close).
    src = INSTALL_SH.read_text()
    m = re.search(
        r'if \[\[ ! "\$RELEASE_TAG" =~.*?\n    cd "\$INSTALL_DIR"\nfi\n',
        src,
        re.S,
    )
    assert m, "install.sh's tag-validation + checkout block not found"
    return m.group(0)


def _run_install_sh_checkout_block(tmp_path: Path, release_tag: str) -> subprocess.CompletedProcess:
    install_dir = tmp_path / "opt-xinas"
    (install_dir / ".git").mkdir(parents=True)

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    # No-op git: the injection payload runs regardless of git's own exit
    # status (it rides in on the outer `;`, not `&&`), so git only needs to
    # exist and return quickly.
    (stub_bin / "git").write_text("#!/bin/bash\nexit 0\n")
    (stub_bin / "git").chmod(0o755)

    marker = tmp_path / f"xinas-pwned-{os.getpid()}"
    # Simulates a GitHub Release API response whose tag_name a single-quote
    # payload rides in on -- exactly the shape a compromised or malformed
    # feed response could produce.
    malicious_tag = release_tag.replace("MARKER", str(marker))

    snippet = (
        "set -e\n"
        f'INSTALL_DIR="{install_dir}"\n'
        f'RELEASE_TAG="{malicious_tag}"\n'
        'REPO_URL="https://example.invalid/xiNAS.git"\n'
        'LOG_FILE="' + str(tmp_path / "install.log") + '"\n'
        ': > "$LOG_FILE"\n'
        'RED=""; GREEN=""; CYAN=""; BOLD=""; NC=""\n'
        "_SPIN=('|')\n"
        'fail() { echo "FAIL: $*" >&2; }\n'
        # Real run_quiet, verbatim from install.sh, so the test exercises
        # the actual argv-passing contract rather than a simplified stand-in.
        + _extract_install_sh_run_quiet()
        + "\n"
        + _extract_install_sh_checkout_block()
        + '\necho "REACHED_END"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        env=dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}"),
        capture_output=True,
        text=True,
        timeout=30,
    ), marker


def _extract_install_sh_run_quiet() -> str:
    src = INSTALL_SH.read_text()
    m = re.search(r"^run_quiet\(\) \{.*?\n\}\n", src, re.M | re.S)
    assert m, "install.sh's run_quiet() definition not found"
    return m.group(0)


def test_install_sh_refuses_injection_payload(tmp_path):
    """The historical defect: a single quote inside RELEASE_TAG broke out of
    install.sh's nested `bash -c "... '${RELEASE_TAG}' ..."` string and ran
    arbitrary commands. Reproduced manually pre-fix (see task report) by
    running exactly this extracted block against the pre-fix source, which
    creates the marker file -- proving this assertion is genuinely red
    before the fix. Post-fix, install.sh no longer builds a second shell's
    command string out of the tag at all (argv only), and it validates the
    tag before ever reaching git, so the payload is refused outright and the
    marker is never created.
    """
    proc, marker = _run_install_sh_checkout_block(tmp_path, "v1.0.0'; touch MARKER; echo '")
    assert not marker.exists(), (
        "injection payload executed -- RELEASE_TAG reached a second shell "
        f"parse. stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    assert proc.returncode != 0, (
        "install.sh's checkout block must refuse a non-release tag, not "
        f"silently succeed. stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    assert "REACHED_END" not in proc.stdout


# ── Behavioral: prepare_system.sh -u must refuse a non-release tag before
# ever calling git ───────────────────────────────────────────────────────────


def _extract_is_release_tag_function() -> str:
    # Pulled live from the real lib/menu_lib.sh rather than hand-copied, so
    # this test exercises the ACTUAL regex under test -- a hand-copied
    # stand-in could silently drift from the real function and let this
    # test keep passing after a regression to the real one.
    src = MENU_LIB.read_text()
    m = re.search(r"^_is_release_tag\(\) \{\n.*?\n\}\n", src, re.M | re.S)
    assert m, "_is_release_tag() definition not found in lib/menu_lib.sh"
    return m.group(0)


def test_prepare_system_update_only_refuses_non_release_tag(tmp_path):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    (sandbox / "ansible.cfg").write_text("")
    (sandbox / "playbooks").mkdir()
    # prepare_system.sh sources "lib/menu_lib.sh" (relative, guarded by
    # `[ -f ... ]`) right after resolving the repo directory, before
    # xinas_update_to_latest_release() is ever called -- without this stub
    # the guard silently no-ops, _is_release_tag is undefined, and
    # `if ! _is_release_tag "$tag"` "refuses" only because bash reports
    # command-not-found (exit 127) as a truthy `!`, not because the real
    # regex rejected the tag. That would make this test pass for the wrong
    # reason even if the real regex became fully permissive. Stubbing in the
    # function extracted live from the real file (rather than a
    # hand-maintained copy) closes that gap.
    lib_dir = sandbox / "lib"
    lib_dir.mkdir()
    (lib_dir / "menu_lib.sh").write_text(_extract_is_release_tag_function())

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    git_log = tmp_path / "git-calls.log"
    (stub_bin / "git").write_text(f'#!/bin/bash\necho "$@" >> "{git_log}"\nexit 0\n')
    (stub_bin / "git").chmod(0o755)
    # The feed serves "main" -- the unanchored grep/sed in
    # xinas_latest_release_tag() would happily extract it as a "tag".
    (stub_bin / "curl").write_text('#!/bin/bash\necho \'{"tag_name": "main"}\'\n')
    (stub_bin / "curl").chmod(0o755)

    env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}")
    proc = subprocess.run(
        ["bash", str(PREPARE_SYSTEM), "-u"],
        cwd=sandbox,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode != 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    calls = git_log.read_text().splitlines() if git_log.exists() else []
    checkout_calls = [c for c in calls if "checkout" in c]
    assert not checkout_calls, f"a non-release tag must never reach git checkout: {calls}"
    # If the lib failed to source (or _is_release_tag were undefined for any
    # other reason), bash reports command-not-found and the refusal above
    # would be a coincidence of exit-code inversion, not the regex actually
    # rejecting "main" -- assert that did NOT happen.
    assert "command not found" not in proc.stderr, (
        f"_is_release_tag was never called (lib/menu_lib.sh stub did not source) -- "
        f"the refusal below is a command-not-found accident, not a real regex "
        f"rejection: {proc.stderr!r}"
    )
    assert "Refusing to check out non-release ref: 'main'" in proc.stderr, (
        f"expected the real refusal message on stderr, got: {proc.stderr!r}"
    )


# ── Behavioral: prepare_system.sh's initial BOOTSTRAP clone (before the repo
# exists on disk at all) must also refuse a non-release tag before ever
# calling git ─────────────────────────────────────────────────────────────


def _extract_prepare_system_bootstrap_clone_block() -> str:
    # The bootstrap-clone site: the ELSE branch of prepare_system.sh's
    # `ansible.cfg`/`playbooks` check, taken when the repo isn't present in
    # the cwd yet. lib/menu_lib.sh (and its _is_release_tag) is sourced only
    # AFTER this block -- it can't be sourced earlier, because the lib file
    # doesn't exist on disk until this very clone creates the repo. So this
    # site cannot call the shared _is_release_tag and instead needs its own
    # inline copy of the regex, like install.sh's pre-clone path.
    # Anchored with re.M so the non-greedy body match stops at the outer
    # `fi` (4-space indent) rather than the inner `if [ -z "$_tag" ]; then`
    # block's own `fi` (8-space indent, which is also a *substring* match
    # for "    fi\n" without the ^ anchor).
    src = PREPARE_SYSTEM.read_text()
    m = re.search(
        r'^    if \[ ! -d "\$REPO_DIR" \]; then\n.*?^    fi\n',
        src,
        re.M | re.S,
    )
    assert m, "prepare_system.sh's bootstrap-clone block not found"
    return m.group(0)


def _run_prepare_system_bootstrap_clone(
    tmp_path: Path, latest_tag: str
) -> tuple[subprocess.CompletedProcess, Path]:
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    git_log = tmp_path / "git-calls.log"
    (stub_bin / "git").write_text(f'#!/bin/bash\necho "$@" >> "{git_log}"\nexit 0\n')
    (stub_bin / "git").chmod(0o755)

    snippet = (
        "set -e\n"
        'RED="\\033[0;31m"; YELLOW="\\033[1;33m"; NC="\\033[0m"\n'
        'REPO_URL="https://example.invalid/xiNAS.git"\n'
        f'REPO_DIR="{tmp_path / "xiNAS"}"\n'
        # Simulates a compromised/malformed GitHub Release API response --
        # the unanchored `grep -o | sed` in the real xinas_latest_release_tag
        # would happily extract a branch name like "main" too.
        f'xinas_latest_release_tag() {{ echo "{latest_tag}"; }}\n'
        + _extract_prepare_system_bootstrap_clone_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        env=dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}"),
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc, git_log


def test_prepare_system_bootstrap_clone_refuses_non_release_tag(tmp_path):
    """The initial bootstrap clone -- run before the repo (and lib/menu_lib.sh
    inside it) exists on disk at all -- must refuse a non-release tag the
    same way install.sh's pre-clone path and the update-only path do."""
    proc, git_log = _run_prepare_system_bootstrap_clone(tmp_path, "main")
    calls = git_log.read_text().splitlines() if git_log.exists() else []
    clone_calls = [c for c in calls if "clone" in c]
    assert not clone_calls, f"a non-release tag must never reach git clone: {calls}"
    assert proc.returncode != 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert "Refusing to clone non-release ref: 'main'" in proc.stderr, (
        f"expected the refusal message on stderr, got: {proc.stderr!r}"
    )
    assert "REACHED_END" not in proc.stdout
