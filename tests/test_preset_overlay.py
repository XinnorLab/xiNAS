"""The overlay helper is the only writer of preset and operator configuration.

`lib/xinas_config.sh` replaces three copies of an `apply_preset` that overwrote
git-tracked role defaults. These tests drive the shell functions directly.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "lib/xinas_config.sh"


def _run(script: str, repo_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", f'set -eu; REPO_DIR="{repo_dir}"; . "{HELPER}"\n{script}'],
        capture_output=True,
        text=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A minimal tree with one role default and an empty overlay."""
    role = tmp_path / "collection/roles/demo/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("demo_key: from_defaults\nonly_default: yes\n")
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    return tmp_path


def test_get_falls_back_to_role_defaults(repo: Path):
    r = _run("xinas_config_get demo_key", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_defaults"


def test_preset_layer_overrides_role_defaults(repo: Path):
    r = _run("xinas_config_set preset demo_key from_preset; xinas_config_get demo_key", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_preset"


def test_local_layer_beats_preset_layer(repo: Path):
    r = _run(
        "xinas_config_set preset demo_key from_preset;"
        "xinas_config_set local demo_key from_local;"
        "xinas_config_get demo_key",
        repo,
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_local"


def test_writes_land_in_the_expected_layer_files(repo: Path):
    _run("xinas_config_set preset a 1; xinas_config_set local b 2", repo)
    gv = repo / "playbooks/group_vars/all"
    assert yaml.safe_load((gv / "10-preset.yml").read_text()) == {"a": 1}
    assert yaml.safe_load((gv / "20-local.yml").read_text()) == {"b": 2}


def test_no_layer_defines_the_key(repo: Path):
    r = _run("xinas_config_get absent_key || echo MISSING", repo)
    assert "MISSING" in r.stdout


def test_role_defaults_are_never_written(repo: Path):
    before = (repo / "collection/roles/demo/defaults/main.yml").read_text()
    _run("xinas_config_set preset demo_key changed; xinas_config_set local x 1", repo)
    assert (repo / "collection/roles/demo/defaults/main.yml").read_text() == before
