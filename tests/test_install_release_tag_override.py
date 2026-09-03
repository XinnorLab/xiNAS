"""install.sh: explicit release selection with XINAS_RELEASE_TAG.

A release candidate is published with ``--prerelease``, which GitHub
excludes from ``/releases/latest`` — the only endpoint ``install.sh`` used to
consult — so a fresh install of an RC was impossible without the TUI's
prerelease update channel. ``XINAS_RELEASE_TAG=vX.Y.Z[-rc.N]`` names one
published GitHub Release to install instead. The Release and Update Policy
still holds: the value must look like a release tag *before* GitHub is asked,
GitHub must confirm it as a published, non-draft release, and there is no
fallback of any kind. See docs/Installer/update-spec.md
"Fresh installs select a release only by explicit tag".

These tests run the real release-selection block extracted live from
install.sh against a stubbed ``curl`` that plays GitHub's Releases API.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO / "install.sh"

_BLOCK_RE = re.compile(
    r"^# ── Release selection ─+\n.*?^# ── end release selection ─+\n",
    re.M | re.S,
)


def _release_selection_block() -> str:
    m = _BLOCK_RE.search(INSTALL_SH.read_text())
    assert m, "install.sh: no release-selection block"
    return m.group(0)


def _stub_curl(tmp_path: Path, releases: dict[str, dict]) -> tuple[Path, Path]:
    """A curl that answers GitHub's Releases API from `releases`.

    Keys are URL suffixes after /repos/<slug>/ (``releases/latest``,
    ``releases/tags/<tag>``); anything else is a 404 (curl -f exit 22).
    Every call's argv is appended to a log so a test can prove GitHub was
    (or was not) asked.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "curl-calls.log"
    table = tmp_path / "releases.json"
    table.write_text(json.dumps(releases))
    (bin_dir / "curl").write_text(
        "#!/bin/bash\n"
        f'printf \'%s\\n\' "$*" >> "{log}"\n'
        'url="${@: -1}"\n'
        f'python3 - "$url" "{table}" <<\'PY\'\n'
        "import json, sys\n"
        "url, table = sys.argv[1], sys.argv[2]\n"
        "key = url.split('/repos/', 1)[1].split('/', 2)[2]\n"
        "rel = json.load(open(table)).get(key)\n"
        "if rel is None:\n"
        "    sys.exit(22)\n"
        "print(json.dumps(rel))\n"
        "PY\n"
    )
    (bin_dir / "curl").chmod(0o755)
    return bin_dir, log


_PRELUDE = """
set -e
REPO_SLUG="XinnorLab/xiNAS"
XINAS_GH_TOKEN_FILE="/nonexistent/github-token"
RED=""; GREEN=""; YELLOW=""; CYAN=""; WHITE=""; DIM=""; BOLD=""; NC=""
ok()   { echo "OK: $*"; }
info() { echo "INFO: $*"; }
warn() { echo "WARN: $*"; }
fail() { echo "FAIL: $*" >&2; }
xinas_gh_curl() { curl "$@"; }
xinas_github_token_source() { :; }
xinas_gh_explain_release_lookup_failure() { echo "explained"; }
token_howto_hint() { :; }
"""


def _run(
    tmp_path: Path, releases: dict[str, dict], **env: str
) -> tuple[subprocess.CompletedProcess, Path]:
    bin_dir, log = _stub_curl(tmp_path, releases)
    script = _PRELUDE + _release_selection_block() + '\necho "SELECTED=${RELEASE_TAG}"\n'
    full_env = {k: v for k, v in os.environ.items() if not k.startswith("XINAS_")}
    full_env["PATH"] = f"{bin_dir}:{full_env['PATH']}"
    full_env.update(env)
    proc = subprocess.run(
        ["bash", "-c", script],
        env=full_env,
        cwd=tmp_path,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc, log


def _selected(proc: subprocess.CompletedProcess) -> str | None:
    for line in proc.stdout.splitlines():
        if line.startswith("SELECTED="):
            return line.split("=", 1)[1]
    return None


RELEASES = {
    "releases/latest": {"tag_name": "v3.13.1", "draft": False, "prerelease": False},
    "releases/tags/v3.13.2-rc.1": {"tag_name": "v3.13.2-rc.1", "draft": False, "prerelease": True},
    "releases/tags/v3.13.1": {"tag_name": "v3.13.1", "draft": False, "prerelease": False},
    "releases/tags/v3.14.0": {"tag_name": "v3.14.0", "draft": True, "prerelease": False},
}


def test_block_exists():
    assert _release_selection_block()


def test_default_path_still_resolves_releases_latest(tmp_path):
    proc, log = _run(tmp_path, RELEASES)
    assert proc.returncode == 0, proc.stderr
    assert _selected(proc) == "v3.13.1"
    calls = log.read_text()
    assert "releases/latest" in calls
    assert "releases/tags/" not in calls, "without the override, only /releases/latest is consulted"


def test_explicit_tag_selects_a_published_prerelease(tmp_path):
    proc, log = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG="v3.13.2-rc.1")
    assert proc.returncode == 0, proc.stderr
    assert _selected(proc) == "v3.13.2-rc.1"
    calls = log.read_text()
    assert "releases/tags/v3.13.2-rc.1" in calls
    assert "releases/latest" not in calls, (
        "an explicit tag must not be overridden by /releases/latest"
    )
    assert "XINAS_RELEASE_TAG" in proc.stdout, (
        "the deviation from the latest release must be announced"
    )


def test_explicit_tag_may_name_a_stable_release(tmp_path):
    proc, _ = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG="v3.13.1")
    assert proc.returncode == 0, proc.stderr
    assert _selected(proc) == "v3.13.1"


def test_unknown_tag_fails_closed(tmp_path):
    proc, log = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG="v9.9.9")
    assert proc.returncode != 0
    assert _selected(proc) is None
    assert "v9.9.9" in proc.stderr and "published" in proc.stderr.lower()
    assert "releases/latest" not in log.read_text(), "no fallback to the latest release"


def test_draft_release_fails_closed(tmp_path):
    proc, _ = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG="v3.14.0")
    assert proc.returncode != 0
    assert _selected(proc) is None
    assert "v3.14.0" in proc.stderr


@pytest.mark.parametrize(
    "bad", ["main", "HEAD", "origin/main", "--quiet", "v1.2", "v1.2.3.4", "release/3.14"]
)
def test_non_release_shaped_values_are_refused_before_asking_github(tmp_path, bad):
    proc, log = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG=bad)
    assert proc.returncode != 0, bad
    assert _selected(proc) is None
    assert not log.exists() or log.read_text() == "", f"{bad!r} reached GitHub"


def test_empty_override_means_default(tmp_path):
    proc, log = _run(tmp_path, RELEASES, XINAS_RELEASE_TAG="")
    assert proc.returncode == 0, proc.stderr
    assert _selected(proc) == "v3.13.1"
    assert "releases/latest" in log.read_text()


def test_header_documents_the_override():
    head = "\n".join(INSTALL_SH.read_text().splitlines()[:12])
    assert "XINAS_RELEASE_TAG" in head, "install.sh's usage header must mention XINAS_RELEASE_TAG"
