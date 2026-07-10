"""WS3 (T12, F11b): refresh_nfs_helper() implements the four documented
outcomes (docs/Installer/update-spec.md "NFS-helper refresh") instead of the
old _sync_nfs_helper(), which discarded the systemctl restart's result and
could not distinguish "not installed" from "actually broken." Calls the
xinas-update-helper-sync wrapper via `sudo -n`, checking its exit status —
never discarding a subprocess.run result — with a direct-copy fallback when
the wrapper isn't deployed, mirroring _privileged_git's existing shape.
"""

import subprocess as _subprocess

from xinas_menu.utils import update_check as uc


def test_skip_when_all_tag_covers_it(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "irrelevant")
    r = uc.refresh_nfs_helper(tmp_path, ("all",))
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_REBUILD_COVERED
    assert r.ok is True


def test_skip_when_xinas_nfs_helper_tag_covers_it(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "irrelevant")
    r = uc.refresh_nfs_helper(tmp_path, ("nfs_server", "xinas_nfs_helper"))
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_REBUILD_COVERED
    assert r.ok is True


def test_skip_when_dest_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "not-installed")
    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_NOT_INSTALLED
    assert r.ok is True


def test_success_via_wrapper(monkeypatch, tmp_path):
    # subprocess.run is faked here rather than letting `sudo -n` actually run
    # (as the _privileged_git tests in test_update_check.py already do for the
    # same reason): dev machines and CI differ on passwordless-sudo config, so
    # asserting real sudo behavior would make this test host-dependent/flaky.
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\nexit 0\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    calls = []

    def _fake_run(argv, **kw):
        calls.append(argv)

        class _R:
            returncode = 0
            stdout = ""
            stderr = ""

        return _R()

    monkeypatch.setattr(uc.subprocess, "run", _fake_run)

    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.SUCCESS
    assert r.ok is True
    assert calls[0][:3] == ["sudo", "-n", str(wrapper)]


def test_fails_with_wrapper_present_nonzero(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\necho boom >&2\nexit 1\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    def _fake_run(argv, **kw):
        class _R:
            returncode = 1
            stdout = ""
            stderr = "boom\n"

        return _R()

    monkeypatch.setattr(uc.subprocess, "run", _fake_run)

    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_WRAPPER
    assert r.ok is False
    assert r.remediation == "sudo /usr/local/sbin/xinas-update-helper-sync"


def test_fails_without_wrapper_names_role_redeploy_not_wrapper(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", tmp_path / "no-such-wrapper")
    src = tmp_path / "xiNAS-MCP" / "nfs-helper"
    src.mkdir(parents=True)
    (src / "nfs_helper.py").write_text("# stub\n")
    dest.chmod(0o500)  # read-only: shutil.copy2 into it raises PermissionError
    try:
        r = uc.refresh_nfs_helper(tmp_path, ())
    finally:
        dest.chmod(0o700)  # restore so tmp_path cleanup can remove it

    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_NO_WRAPPER
    assert r.ok is False
    assert r.remediation == "sudo ansible-playbook playbooks/site.yml --tags xinas_menu"
    assert "xinas-update-helper-sync" not in r.remediation


def test_wrapper_timeout_is_failed_wrapper_not_raised(monkeypatch, tmp_path):
    # subprocess.run raising (systemctl restart hangs past timeout) must map to
    # FAILED_WRAPPER, never propagate — apply_update_flow relies on
    # refresh_nfs_helper never raising so the restart still happens.
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\nexit 0\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    def _boom(*a, **k):
        raise _subprocess.TimeoutExpired(cmd="wrapper", timeout=30)

    monkeypatch.setattr(uc.subprocess, "run", _boom)

    r = uc.refresh_nfs_helper(tmp_path, ())  # must NOT raise
    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_WRAPPER
    assert r.ok is False
    assert "timed out" in r.detail.lower() or "timeout" in r.detail.lower()


def test_wrapper_oserror_is_failed_wrapper_not_raised(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\nexit 0\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    def _boom(*a, **k):
        raise OSError("sudo: command not found")

    monkeypatch.setattr(uc.subprocess, "run", _boom)

    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_WRAPPER
    assert r.ok is False


def test_apply_update_no_longer_calls_sync(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    c = uc.UpdateChecker(repo_path=tmp_path, current_version="3.1.0", releases_fetcher=lambda: [])
    monkeypatch.setattr(uc, "_privileged_git", lambda repo, *a: "")
    assert not hasattr(c, "_sync_nfs_helper")
    ok, _msg = c.apply_update("v3.1.1")
    assert ok is True
