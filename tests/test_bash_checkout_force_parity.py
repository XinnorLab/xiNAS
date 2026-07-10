"""WS3.3 (T5, F5): every bash update/install path that checks out a release
tag must use `git checkout --force` — the installed tree is git-dirty by
design (docs/Installer/update-spec.md "Reset-to-release" / "Bash-path
parity"). install_client.sh was deliberately excluded from this file when it
landed (fixed together with its failure-propagation fix, F8, in Task 7 —
same two lines); T7 landed and test_install_client_sh_forces_and_propagates
below now covers it, with full behavioral coverage in
tests/test_install_client_update_accuracy.py.

prepare_system.sh's `-u` (update-only) mode is fully behavioral and
hermetic: it skips the package-install block entirely and exits right after
xinas_update_to_latest_release(), so it can be driven end-to-end with
stubbed git/curl. install.sh and the two interactive TUI menus require root
or full menu navigation to reach their checkout call, so those three are
checked structurally (the call site text), per this plan's documented
fallback.
"""

import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PREPARE_SYSTEM = REPO / "prepare_system.sh"
MENU_LIB = REPO / "lib" / "menu_lib.sh"


def _extract_is_release_tag_function() -> str:
    # Pulled live from the real lib/menu_lib.sh (not hand-copied) so a
    # regression to the real regex can't leave this test passing for the
    # wrong reason -- mirrors test_release_tag_validation.py's helper of the
    # same name.
    src = MENU_LIB.read_text()
    m = re.search(r"^_is_release_tag\(\) \{\n.*?\n\}\n", src, re.M | re.S)
    assert m, "_is_release_tag() definition not found in lib/menu_lib.sh"
    return m.group(0)


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


def test_prepare_system_update_only_propagates_checkout_failure(tmp_path):
    """WS3.4 (T7, "No false success"): xinas_update_to_latest_release()
    previously ended with a bare `git checkout --force --quiet "$tag"`
    followed by `echo "$tag"` -- a FAILED checkout still reached the echo,
    so the function returned 0 and the `-u` path printed "Updated to
    <tag>" even though the tree never moved. Proven RED against 835370b's
    prepare_system.sh (returncode 0, "Updated to" printed) before this fix.

    Mirrors test_release_tag_validation.py's non-vacuous stubbing: the real
    _is_release_tag() is extracted live from lib/menu_lib.sh (not
    hand-copied), so a valid tag genuinely passes validation and only then
    hits the (stubbed) checkout failure -- proving this is a checkout-stage
    failure, not a validation-stage rejection in disguise.
    """
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    (sandbox / "ansible.cfg").write_text("")
    (sandbox / "playbooks").mkdir()
    lib_dir = sandbox / "lib"
    lib_dir.mkdir()
    (lib_dir / "menu_lib.sh").write_text(_extract_is_release_tag_function())

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    git_log = tmp_path / "git-calls.log"
    (stub_bin / "git").write_text(
        f'#!/bin/bash\necho "$@" >> "{git_log}"\n'
        'if [[ "$1" == "checkout" ]]; then exit 1; fi\n'
        "exit 0\n"
    )
    (stub_bin / "git").chmod(0o755)
    # A valid semver tag -- must pass _is_release_tag and reach git, unlike
    # test_prepare_system_update_only_refuses_non_release_tag's "main".
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
    calls = git_log.read_text().splitlines() if git_log.exists() else []
    checkout_calls = [c for c in calls if "checkout" in c]
    assert checkout_calls, f"expected a checkout attempt (valid tag must reach git): {calls}"
    assert proc.returncode != 0, (
        f"a failed git checkout must not return success: stdout={proc.stdout!r} "
        f"stderr={proc.stderr!r}"
    )
    assert "Updated to" not in proc.stdout, (
        f"must not report success when checkout failed: stdout={proc.stdout!r}"
    )


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


def test_install_client_sh_forces_and_propagates():
    """T7 closed the deferral documented here previously: install_client.sh's
    checkout now uses --force (F5) and no longer swallows git failures behind
    `|| true` (F8) — a failed fetch/checkout is refused with a non-zero exit
    instead of an unconditional "Client updated" message. See
    tests/test_install_client_update_accuracy.py for the full behavioral
    coverage of the fixed update block.
    """
    body = (REPO / "install_client.sh").read_text()
    assert 'git checkout --force --quiet "$RELEASE_TAG"' in body, (
        "install_client.sh must force-checkout the release tag (F5)"
    )
    assert "git fetch --quiet origin --tags 2>/dev/null || true" not in body, (
        "install_client.sh must not swallow git fetch failures (F8)"
    )
    assert 'git checkout --quiet "$RELEASE_TAG" 2>/dev/null || true' not in body, (
        "install_client.sh must not swallow git checkout failures (F8)"
    )
