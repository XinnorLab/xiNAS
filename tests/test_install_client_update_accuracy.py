"""WS3.4 (T7, F8 + deferred F5 + tag validation): install_client.sh must
propagate git fetch/checkout failures, never print "Client updated" when
either failed, force-checkout, and refuse non-release refs
(docs/Installer/spec.md §8.4, update-spec.md "Bash-path parity").

install_client.sh gates on EUID==0 at its very top and mutates the real
filesystem (/opt/xinas-client, /usr/local/bin, apt/dnf/yum), so it cannot be
driven end-to-end unprivileged the way prepare_system.sh's -u path can.
Structural assertions pin the call-site text directly; the extracted-region
behavioral tests below drive the actual update block (tag validation +
fetch/checkout guard) hermetically, the same technique
test_installer_exit_code_contract.py and test_release_tag_validation.py use
for install.sh's guarded blocks.
"""

import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INSTALL_CLIENT = REPO / "install_client.sh"
SRC = INSTALL_CLIENT.read_text()


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(INSTALL_CLIENT)], check=True)


def test_no_swallowed_git_failures():
    assert "git fetch --quiet origin --tags 2>/dev/null || true" not in SRC
    assert 'git checkout --quiet "$RELEASE_TAG" 2>/dev/null || true' not in SRC


def test_checkout_forces():
    assert 'git checkout --force --quiet "$RELEASE_TAG"' in SRC


def test_update_block_is_if_guarded_with_failure_exit():
    m = re.search(r"if git fetch.*?git checkout --force[^\n]*; then", SRC, re.S)
    assert m, "fetch/checkout must be inside an if-guard"
    window = SRC[m.start() : m.end() + 400]
    assert 'ok "Client updated to ${RELEASE_TAG}"' in window
    assert re.search(r"\belse\b", window) and re.search(r"exit\s+1", window)


def test_release_tag_validated_before_checkout():
    assert r"^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$" in SRC, (
        "install_client.sh must validate RELEASE_TAG against the shared semver regex"
    )


# ── Behavioral: extract the real update block (tag-validation guard +
# fetch/checkout if-guard) and drive it hermetically ─────────────────────────


def _extract_update_block() -> str:
    # Bounded to just the "if [[ -d "$INSTALL_DIR" ]]" TRUE branch (the
    # update path) -- the clone branch (else) is irrelevant here and would
    # try to actually run `git clone` against a fake REPO_URL. The lookahead
    # pins the literal clone-branch opener ("info \"Cloning repository") so
    # this isn't fooled by the fetch/checkout guard's OWN nested `else`
    # (post-fix, "else\n    fail \"Failed to update client...") when
    # searching non-greedily for the first "\nelse\n".
    m = re.search(
        r'if \[\[ -d "\$INSTALL_DIR" \]\]; then\n(.*?)\nelse\n(?=    info "Cloning repository)',
        SRC,
        re.S,
    )
    assert m, "install_client.sh's update-branch body not found"
    return f'if [[ -d "$INSTALL_DIR" ]]; then\n{m.group(1)}\nfi\n'


def _run_update_block(tmp_path: Path, *, release_tag: str, git_script: str):
    install_dir = tmp_path / "opt-xinas-client"
    (install_dir / ".git").mkdir(parents=True)

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    (stub_bin / "git").write_text(git_script)
    (stub_bin / "git").chmod(0o755)

    snippet = (
        "set -euo pipefail\n"
        f'INSTALL_DIR="{install_dir}"\n'
        f'RELEASE_TAG="{release_tag}"\n'
        'RED=""; GREEN=""; DIM=""; NC=""\n'
        'info() { echo "INFO: $*"; }\n'
        'ok() { echo "OK: $*"; }\n'
        'fail() { echo "FAIL: $*" >&2; }\n' + _extract_update_block() + '\necho "REACHED_END"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        env=dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}"),
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_update_block_refuses_non_release_tag_before_git(tmp_path):
    # A stray "main" (or any non-semver ref) reaching RELEASE_TAG must never
    # be handed to git at all -- record every git invocation to prove none
    # of them fired.
    git_log = tmp_path / "git-calls.log"
    git_script = f'#!/bin/bash\necho "$@" >> "{git_log}"\nexit 0\n'
    proc = _run_update_block(tmp_path, release_tag="main", git_script=git_script)
    assert proc.returncode != 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    assert not git_log.exists() or git_log.read_text() == "", (
        f"non-release tag must never reach git: {git_log.read_text() if git_log.exists() else ''}"
    )
    assert "REACHED_END" not in proc.stdout
    assert "Client updated" not in proc.stdout


def test_update_block_reports_failure_when_checkout_fails(tmp_path):
    # Valid tag, but the checkout call itself fails (e.g. dirty tree /
    # network blip) -- must not print "Client updated" and must exit non-zero.
    git_script = '#!/bin/bash\nif [[ "$1" == "checkout" ]]; then exit 1; fi\nexit 0\n'
    proc = _run_update_block(tmp_path, release_tag="v9.9.9", git_script=git_script)
    assert proc.returncode != 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    assert "Client updated" not in proc.stdout
    assert "REACHED_END" not in proc.stdout


def test_update_block_reports_success_on_real_success(tmp_path):
    git_script = "#!/bin/bash\nexit 0\n"
    proc = _run_update_block(tmp_path, release_tag="v9.9.9", git_script=git_script)
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    assert "Client updated to v9.9.9" in proc.stdout
    assert "REACHED_END" in proc.stdout
