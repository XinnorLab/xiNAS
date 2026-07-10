"""WS3 (T14, F12): XINAS_UPDATE_REPO is removed — release-detection source
is fixed at XinnorLab/xiNAS everywhere (docs/Installer/update-spec.md
"Release-detection source is fixed"). XINAS_UPDATE_CHANNEL is unaffected.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

_SURFACES = [
    "xinas_menu/utils/update_check.py",
    "startup_menu.sh",
    "simple_menu.sh",
    "post_install_menu.sh",
    "client_repo/client_setup.sh",
]


def test_env_var_removed_from_all_five_surfaces():
    for rel in _SURFACES:
        body = (REPO / rel).read_text()
        assert "XINAS_UPDATE_REPO" not in body, f"{rel} still reads XINAS_UPDATE_REPO (F12)"


def test_no_grep_hits_repo_wide_on_the_five_surfaces():
    proc = subprocess.run(
        ["grep", "-l", "XINAS_UPDATE_REPO", *_SURFACES],
        cwd=REPO, capture_output=True, text=True,
    )
    assert proc.returncode == 1, proc.stdout  # grep exits 1 when no matches


def test_update_checker_ignores_the_removed_env_var(monkeypatch):
    monkeypatch.setenv("XINAS_UPDATE_REPO", "some-fork/xiNAS")
    from xinas_menu.utils import update_check as uc

    c = uc.UpdateChecker(current_version="3.1.0", releases_fetcher=lambda: [])
    assert c._repo_slug == "XinnorLab/xiNAS"


def test_update_channel_env_var_still_works(monkeypatch):
    monkeypatch.setenv("XINAS_UPDATE_CHANNEL", "prerelease")
    from xinas_menu.utils import update_check as uc

    c = uc.UpdateChecker(current_version="3.1.0", releases_fetcher=lambda: [])
    assert c.allow_prerelease is True
