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


def test_get_returns_a_present_false_value(repo: Path):
    """`.key // "ABSENT"` treats a legitimate `false` the same as unset -
    not theoretical: several shipped role defaults are `false`, and a
    later task writes `false` through xinas_config_set the same way this
    test does.
    """
    r = _run("xinas_config_set local flag_key false; xinas_config_get flag_key", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "false"


def test_effective_merges_keys_from_every_layer(repo: Path):
    """A per-key cascade (check local, else preset, else the role default)
    can answer every test above correctly without ever merging anything -
    each of those asks about one key at a time. Ask for the whole document
    instead and check that a key unique to each layer is present at once,
    which a cascade with no real multi-document merge cannot produce.
    """
    r = _run(
        "xinas_config_set preset preset_only from_preset;"
        "xinas_config_set local local_only from_local;"
        "xinas_config_effective",
        repo,
    )
    assert r.returncode == 0, r.stderr
    doc = yaml.safe_load(r.stdout)
    assert doc["demo_key"] == "from_defaults"
    assert doc["preset_only"] == "from_preset"
    assert doc["local_only"] == "from_local"


def _preset_repo(tmp_path: Path) -> Path:
    role = tmp_path / "collection/roles/demo/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("demo_key: from_defaults\nsurvivor: true\n")
    preset = tmp_path / "presets/vm"
    preset.mkdir(parents=True)
    (preset / "raid_fs.yml").write_text("demo_key: from_preset\n")
    (preset / "nvme_namespace.yml").write_text("nvme_key: 5\n")
    (preset / "playbook.yml").write_text(
        "---\n- hosts: storage_nodes\n  vars:\n    perf_nr_requests: 0\n  roles: [demo]\n"
    )
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    return tmp_path


def test_apply_preset_merges_every_var_file(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run("xinas_apply_preset vm", repo)
    assert r.returncode == 0, r.stderr
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert layer == {"demo_key": "from_preset", "nvme_key": 5, "perf_nr_requests": 0}


def test_apply_preset_does_not_delete_keys_it_omits(tmp_path: Path):
    """The whole point: `survivor` is in the defaults and in no preset file.

    Checking only the merged view is not enough: a no-op stub never touches
    the overlay at all, and `survivor` would still read back correctly from
    role defaults alone with nothing having actually been applied - passing
    this test having done no work. Assert the preset layer was genuinely
    written with the preset's own content first, so a no-op cannot pass.
    """
    repo = _preset_repo(tmp_path)
    r = _run("xinas_apply_preset vm", repo)
    assert r.returncode == 0, r.stderr
    layer_path = repo / "playbooks/group_vars/all/10-preset.yml"
    assert layer_path.exists(), "a no-op stub would never create the preset layer"
    layer = yaml.safe_load(layer_path.read_text())
    assert layer.get("demo_key") == "from_preset"  # proof the preset really landed
    assert "survivor" not in layer  # proof it came from defaults, not the preset

    r = _run("xinas_config_get survivor", repo)
    assert r.stdout.strip() == "true"


def test_apply_preset_replaces_rather_than_accumulates(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    _run("xinas_config_set preset stale_key 1; xinas_apply_preset vm", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert "stale_key" not in layer


def test_apply_preset_keeps_operator_edits(tmp_path: Path):
    """Checking only the merged view is not enough: a no-op stub leaves the
    preset layer absent, so the local layer's demo_key would win by default
    with nothing to actually override - passing this test without the
    preset ever having landed. Assert the preset layer was genuinely
    written with its own, conflicting value for demo_key first, so this
    exercises a real conflict between the two layers, not an absent one.
    """
    repo = _preset_repo(tmp_path)
    _run("xinas_config_set local demo_key from_operator; xinas_apply_preset vm", repo)
    layer_path = repo / "playbooks/group_vars/all/10-preset.yml"
    layer = yaml.safe_load(layer_path.read_text())
    assert layer.get("demo_key") == "from_preset"  # proof the preset really landed and conflicts

    r = _run("xinas_config_get demo_key", repo)
    assert r.stdout.strip() == "from_operator"


def test_apply_preset_rejects_a_preset_netplan_template(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    (repo / "presets/vm/netplan.yaml.j2").write_text("network: {}\n")
    r = _run("xinas_apply_preset vm || echo RC=$?", repo)
    assert "RC=3" in r.stdout


def test_apply_preset_unknown_name(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run("xinas_apply_preset nope || echo RC=$?", repo)
    assert "RC=2" in r.stdout


def test_apply_preset_fails_closed_on_a_malformed_var_file(tmp_path: Path):
    """Regression: xinas_apply_preset's last statement is an unconditional
    marker write (`... || true`), which previously made the function return 0
    even when the yq merge upstream of it failed - so a preset shipping one
    good file (raid_fs.yml) and one malformed file (nvme_namespace.yml) was
    reported as fully applied. This is the "mixed preset" scenario
    tests/test_autoinstall_preset_fail_closed.py names in its module
    docstring, exercised here directly at the helper level.
    """
    repo = _preset_repo(tmp_path)
    (repo / "presets/vm/nvme_namespace.yml").write_text("this: [is, not, valid: yaml\n")
    r = _run("xinas_apply_preset vm || echo RC=$?", repo)
    assert "RC=0" not in r.stdout
    assert "RC=" in r.stdout


def test_apply_preset_failure_leaves_the_previous_overlay_untouched(tmp_path: Path):
    """A failed re-apply must not destroy the last good overlay. This checks
    content equality, not just the return code, so a shallow fix that returns
    non-zero but still truncates the layer file first would not pass.
    """
    repo = _preset_repo(tmp_path)
    _run("xinas_apply_preset vm", repo)
    layer_path = repo / "playbooks/group_vars/all/10-preset.yml"
    good = layer_path.read_text()
    assert "from_preset" in good  # sanity: the first, valid apply really landed

    (repo / "presets/vm/nvme_namespace.yml").write_text("this: [is, not, valid: yaml\n")
    r = _run("xinas_apply_preset vm || echo RC=$?", repo)
    assert "RC=0" not in r.stdout
    assert layer_path.read_text() == good


def test_apply_preset_fails_closed_on_a_malformed_playbook(tmp_path: Path):
    """Regression: the playbook-vars read (`playvars=$(yq eval ...)`) had no
    exit-status check of its own, unlike the var-file merge a few lines
    below it. yq prints its parse error to stderr and nothing to stdout, so
    a malformed playbook.yml silently read back as `playvars=""` - which
    fails the `[ -n "$playvars" ]` guard exactly like "this playbook has no
    vars" does, so the broken file was dropped without a trace. Here the
    preset also ships a good raid_fs.yml, so the failure is partial-corruption
    (raid_fs.yml's key would land, the playbook's would silently not) rather
    than a full wipe - the more dangerous of the two shapes, since the run
    would have looked completely successful.
    """
    repo = _preset_repo(tmp_path)
    (repo / "presets/vm/playbook.yml").write_text(
        "---\n- hosts: storage_nodes\n  vars: [this is not, a map: broken\n  roles: [demo]\n"
    )
    r = _run("xinas_apply_preset vm || echo RC=$?", repo)
    assert "RC=0" not in r.stdout
    assert "RC=" in r.stdout
    # Not just the return code: nothing should have been written at all.
    assert not (repo / "playbooks/group_vars/all/10-preset.yml").exists()
