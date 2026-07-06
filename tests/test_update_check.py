"""Tests for the GitHub-Releases-only update checker.

Contract under test lives in docs/Installer/update-spec.md:
  * updates are sourced ONLY from published GitHub Releases;
  * drafts are always ignored, prereleases ignored unless the
    prerelease channel is explicitly enabled;
  * versions compared with semver (`v1.2.3` == `1.2.3`);
  * on API failure / missing required asset the checker returns a
    clear error and NEVER falls back to main/master/branch archives.
"""

from __future__ import annotations

import asyncio

from xinas_menu.utils import update_check as uc


def _run(coro):
    return asyncio.run(coro)


def _rel(tag, *, draft=False, prerelease=False, body="", assets=None):
    """Build a release dict shaped like the GitHub Releases API payload."""
    return {
        "tag_name": tag,
        "name": tag,
        "draft": draft,
        "prerelease": prerelease,
        "body": body,
        "html_url": f"https://github.com/XinnorLab/xiNAS/releases/tag/{tag}",
        "assets": assets or [],
    }


def _asset(name, tag="v3.1.1"):
    return {
        "name": name,
        "browser_download_url": (
            f"https://github.com/XinnorLab/xiNAS/releases/download/{tag}/{name}"
        ),
    }


def _checker(releases, **kw):
    kw.setdefault("current_version", "3.1.0")
    return uc.UpdateChecker(releases_fetcher=lambda: list(releases), **kw)


# ── semver parsing / ordering ────────────────────────────────────────────


def test_v_prefix_equals_plain():
    assert uc._parse_semver("v3.1.0") is not None
    assert uc._semver_key(uc._parse_semver("v3.1.0")) == uc._semver_key(uc._parse_semver("3.1.0"))


def test_semver_orders_patch():
    assert uc._semver_key(uc._parse_semver("v3.1.1")) > uc._semver_key(uc._parse_semver("3.1.0"))


def test_final_release_outranks_prerelease():
    assert uc._semver_key(uc._parse_semver("v3.2.0")) > uc._semver_key(
        uc._parse_semver("v3.2.0-rc.1")
    )


def test_parse_semver_rejects_junk():
    assert uc._parse_semver("main") is None
    assert uc._parse_semver("") is None
    assert uc._parse_semver("3.1") is None


# ── detection ────────────────────────────────────────────────────────────


def test_detects_new_published_release():
    c = _checker([_rel("v3.1.1", body="shiny new notes")])
    r = _run(c.check())
    assert r.error is None
    assert r.available is True
    assert r.current_version == "3.1.0"
    assert r.latest_version == "v3.1.1"
    assert "shiny new notes" in r.release_notes
    assert r.download_url.startswith("https://github.com/XinnorLab/xiNAS/releases/")


def test_equal_version_reports_no_update():
    c = _checker([_rel("v3.1.0")], current_version="3.1.0")
    r = _run(c.check())
    assert r.available is False
    assert r.error is None


def test_older_release_reports_no_update():
    c = _checker([_rel("v3.0.9")], current_version="3.1.0")
    r = _run(c.check())
    assert r.available is False
    assert r.error is None


# ── draft / prerelease filtering ─────────────────────────────────────────


def test_ignores_draft_release():
    # The draft has the newest tag but must be ignored, leaving 3.1.0 == current.
    c = _checker([_rel("v3.9.9", draft=True), _rel("3.1.0")])
    r = _run(c.check())
    assert r.available is False
    assert r.latest_version == "3.1.0"


def test_ignores_prerelease_by_default():
    c = _checker([_rel("v3.2.0-rc.1", prerelease=True), _rel("3.1.0")])
    r = _run(c.check())
    assert r.available is False
    assert r.latest_version == "3.1.0"


def test_prerelease_channel_opts_in():
    c = _checker(
        [_rel("v3.2.0-rc.1", prerelease=True), _rel("3.1.0")],
        channel="prerelease",
    )
    r = _run(c.check())
    assert r.available is True
    assert r.latest_version == "v3.2.0-rc.1"


def test_prerelease_channel_from_env(monkeypatch):
    monkeypatch.setenv("XINAS_UPDATE_CHANNEL", "prerelease")
    c = uc.UpdateChecker(
        current_version="3.1.0",
        releases_fetcher=lambda: [_rel("v3.2.0-rc.1", prerelease=True)],
    )
    r = _run(c.check())
    assert r.available is True
    assert r.latest_version == "v3.2.0-rc.1"


# ── no branch fallback ───────────────────────────────────────────────────


def test_api_failure_errors_without_git_fallback(monkeypatch):
    # git must never run during a check — assert it by exploding if called.
    def _no_git(*a, **k):
        raise AssertionError("subprocess/git must not run during check()")

    monkeypatch.setattr(uc.subprocess, "run", _no_git)

    def _boom():
        raise RuntimeError("GitHub API unreachable")

    c = uc.UpdateChecker(current_version="3.1.0", releases_fetcher=_boom)
    r = _run(c.check())
    assert r.available is False
    assert r.error is not None
    assert r.current_version == "3.1.0"
    assert "main" not in r.error.lower()
    assert "master" not in r.error.lower()


def test_download_url_is_release_not_branch_archive():
    c = _checker([_rel("v3.1.1")])
    r = _run(c.check())
    assert r.available is True
    for bad in ("archive/refs/heads", "raw.githubusercontent.com", "/heads/", "/main", "/master"):
        assert bad not in r.download_url


# ── required asset ───────────────────────────────────────────────────────


def test_required_asset_missing_errors_no_fallback():
    c = _checker([_rel("v3.1.1", assets=[])], required_asset="install.sh")
    r = _run(c.check())
    assert r.available is False
    assert r.error is not None
    assert "install.sh" in r.error
    assert "main" not in r.error.lower()


def test_required_asset_present_sets_download_url():
    c = _checker(
        [_rel("v3.1.1", assets=[_asset("install.sh")])],
        required_asset="install.sh",
    )
    r = _run(c.check())
    assert r.available is True
    assert r.download_url.endswith("/download/v3.1.1/install.sh")


# ── rebuild trailers sourced from release notes ──────────────────────────


def test_required_rebuilds_parsed_from_release_body():
    c = _checker([_rel("v3.1.1", body="Changes\n\nRequires-Rebuild: nfs_server, perf_tuning\n")])
    r = _run(c.check())
    assert r.available is True
    assert r.required_rebuilds == ("nfs_server", "perf_tuning")


def test_no_trailer_means_no_rebuild():
    c = _checker([_rel("v3.1.1", body="just a code update")])
    r = _run(c.check())
    assert r.available is True
    assert r.required_rebuilds == ()


# ── apply: checkout tag, never main ──────────────────────────────────────


def test_apply_update_checks_out_tag_not_main(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    c = uc.UpdateChecker(repo_path=tmp_path, current_version="3.1.0", releases_fetcher=lambda: [])
    seen = []
    monkeypatch.setattr(uc, "_privileged_git", lambda repo, *a: seen.append(a) or "")
    monkeypatch.setattr(c, "_sync_nfs_helper", lambda: None)

    ok, _msg = c.apply_update("v3.1.1")
    assert ok is True
    assert ("fetch",) in seen
    assert ("checkout", "v3.1.1") in seen
    assert all("main" not in " ".join(a) for a in seen)
    assert all("master" not in " ".join(a) for a in seen)


def test_apply_update_rejects_non_release_ref(tmp_path):
    (tmp_path / ".git").mkdir()
    c = uc.UpdateChecker(repo_path=tmp_path, current_version="3.1.0", releases_fetcher=lambda: [])
    for ref in ("main", "master", "origin/main", "HEAD", ""):
        ok, msg = c.apply_update(ref)
        assert ok is False, f"must refuse to check out {ref!r}"


# ── apply: reset-to-release — force checkout over local changes ───────────
# The installed /opt/xiNAS tree is git-dirty by design: the installer copies
# preset files over tracked role defaults + playbooks/site.yml. A plain
# `git checkout <tag>` then fails with "Your local changes ... would be
# overwritten by checkout". Policy (docs/Installer/update-spec.md): the apply
# force-checks-out the release tag, discarding local modifications to tracked
# files. Untracked files (.xinas_applied_preset, keys/, logs) are preserved —
# so we must never use `git clean`, only `checkout --force`.


def test_fallback_checkout_forces_over_local_changes(monkeypatch, tmp_path):
    """Helper-absent path must pass --force so a dirty tree checks out."""
    # Point the privileged-helper path at a file that does not exist so the
    # direct-git fallback runs.
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", tmp_path / "no-such-helper")
    calls = []

    def _fake_run(argv, **kw):
        calls.append(argv)

        class _R:
            stdout = ""

        return _R()

    monkeypatch.setattr(uc.subprocess, "run", _fake_run)

    uc._privileged_git(tmp_path, "checkout", "v3.1.1")

    checkout = next(a for a in calls if "checkout" in a)
    assert "--force" in checkout, f"fallback checkout must force: {checkout}"
    assert "v3.1.1" in checkout
    # Never wipe untracked files.
    assert all("clean" not in a for a in calls)


def test_helper_present_checkout_delegates_forcing_to_helper(monkeypatch, tmp_path):
    """When the sudo helper is present, apply calls it; the helper itself forces."""
    helper = tmp_path / "xinas-update-git"
    helper.write_text("#!/bin/bash\n")
    helper.chmod(0o755)
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", helper)
    calls = []

    def _fake_run(argv, **kw):
        calls.append(argv)

        class _R:
            stdout = ""

        return _R()

    monkeypatch.setattr(uc.subprocess, "run", _fake_run)

    uc._privileged_git(tmp_path, "checkout", "v3.1.1")

    argv = next(a for a in calls if str(helper) in a)
    assert argv[:3] == ["sudo", "-n", str(helper)]
    assert argv[-2:] == ["checkout", "v3.1.1"]


def test_deployed_helper_script_force_checks_out():
    """The Ansible-deployed helper must force the checkout (reset-to-release)."""
    from pathlib import Path

    helper = (
        Path(__file__).resolve().parent.parent
        / "collection/roles/xinas_menu/files/xinas-update-git"
    )
    text = helper.read_text()
    assert "git checkout --force" in text, "helper must force-checkout to discard local changes"
    # Must not delete untracked files: no *executable* `git clean` (ignore
    # comment lines, which mention it to explain why it is avoided).
    code = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    assert all("git clean" not in ln for ln in code)


# ── prompt formatting ────────────────────────────────────────────────────


def test_format_update_prompt_shows_versions_and_source():
    c = _checker([_rel("v3.1.1", body="notes")])
    r = _run(c.check())
    msg = uc.format_update_prompt(r)
    assert "3.1.0" in msg and "v3.1.1" in msg
    assert "releases" in msg


# ── existing trailer helpers still behave ────────────────────────────────


def test_parse_rebuild_trailers_all_short_circuits():
    assert uc.parse_rebuild_trailers("Requires-Rebuild: all, nfs_server") == ("all",)


def test_build_rebuild_cmd():
    assert uc.build_rebuild_cmd(()) == []
    assert uc.build_rebuild_cmd(("all",)) == ["ansible-playbook", "playbooks/site.yml"]
    assert uc.build_rebuild_cmd(("nfs_server",)) == [
        "ansible-playbook",
        "playbooks/site.yml",
        "--tags",
        "nfs_server",
    ]
