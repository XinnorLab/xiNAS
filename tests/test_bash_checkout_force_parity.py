"""WS3.3 (T5, F5): every bash update/install path that checks out a release
tag must use `git checkout --force` — the installed tree is git-dirty by
design (docs/Installer/update-spec.md "Reset-to-release" / "Bash-path
parity"). install_client.sh is intentionally excluded here; it is fixed in
Task 7 alongside the failure-propagation fix (same two lines, F8).

prepare_system.sh's `-u` (update-only) mode is fully behavioral and
hermetic: it skips the package-install block entirely and exits right after
xinas_update_to_latest_release(), so it can be driven end-to-end with
stubbed git/curl. install.sh and the two interactive TUI menus require root
or full menu navigation to reach their checkout call, so those three are
checked structurally (the call site text), per this plan's documented
fallback.
"""

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PREPARE_SYSTEM = REPO / "prepare_system.sh"


def test_prepare_system_update_only_forces_checkout(tmp_path):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    (sandbox / "ansible.cfg").write_text("")
    (sandbox / "playbooks").mkdir()
    # prepare_system.sh (WS3 T5c) now sources lib/menu_lib.sh right after
    # resolving the repo directory so xinas_update_to_latest_release() can
    # call the shared _is_release_tag() validator before it ever checks out
    # -- stub just that one function rather than the whole real file, to
    # keep this sandbox (a bare "repo root" with no real lib/) hermetic.
    lib_dir = sandbox / "lib"
    lib_dir.mkdir()
    (lib_dir / "menu_lib.sh").write_text(
        '_is_release_tag() { [[ "$1" =~ ^v?[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }\n'
    )

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    git_log = tmp_path / "git-calls.log"
    (stub_bin / "git").write_text(f'#!/bin/bash\necho "$@" >> "{git_log}"\nexit 0\n')
    (stub_bin / "git").chmod(0o755)
    (stub_bin / "curl").write_text('#!/bin/bash\necho \'{"tag_name": "v9.9.9"}\'\n')
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
    assert proc.returncode == 0, proc.stderr
    calls = git_log.read_text().splitlines()
    checkout_calls = [c for c in calls if "checkout" in c]
    assert checkout_calls, f"no git checkout call recorded: {calls}"
    assert all("--force" in c for c in checkout_calls), checkout_calls


def test_install_sh_forces_checkout():
    body = (REPO / "install.sh").read_text()
    # Exact-substring, not a pattern: WS3 T5c dropped the nested `bash -c
    # "... '${RELEASE_TAG}' ..."` string (a command-injection vector — a
    # single quote in the tag broke out of the quoting) in favor of passing
    # the tag straight through to `git` as an argv element, so this pins the
    # real post-fix call-site text rather than any string shaped like it.
    assert 'git checkout --force -q "$RELEASE_TAG"' in body, (
        "install.sh must checkout --force via argv, not a shell string (F5, T5c)"
    )
    assert "git checkout -q '${RELEASE_TAG}'" not in body
    assert 'bash -c "git fetch origin --tags -q && git checkout' not in body, (
        "install.sh must not rebuild the tag into a second shell's command "
        "string (T5c command-injection fix)"
    )


def test_startup_and_simple_menu_do_update_forces_checkout():
    for f in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / f).read_text()
        assert 'git -C "$REPO_DIR" checkout --force "$_tag"' in body, (
            f"{f} do_update() must use git checkout --force (F5)"
        )


def test_install_client_sh_not_yet_forced():
    """Documents the deliberate T7 deferral: install_client.sh's checkout is
    fixed together with its failure-propagation fix (F8) in Task 7, since
    both changes land on the same two lines. This test should be deleted (or
    flipped) when Task 7 lands — it exists so a future reader doesn't
    mistake the gap for an oversight in this change.
    """
    body = (REPO / "install_client.sh").read_text()
    checkout_line = 'git checkout --quiet "$RELEASE_TAG"'
    assert checkout_line in body, "install_client.sh checkout site moved — re-check Task 7 scope"
    assert "--force" not in checkout_line, (
        "install_client.sh appears already forced — update Task 7 scope note"
    )
