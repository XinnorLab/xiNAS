"""The overlay helper is the only writer of preset and operator configuration.

`lib/xinas_config.sh` replaces three copies of an `apply_preset` that overwrote
git-tracked role defaults. These tests drive the shell functions directly.
"""

from __future__ import annotations

import re
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


def test_seed_local_copies_the_effective_value(repo: Path):
    _run("xinas_config_set preset demo_key from_preset; xinas_config_seed_local demo_key", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert layer == {"demo_key": "from_preset"}


def test_seed_local_leaves_an_existing_local_value_alone(repo: Path):
    _run(
        "xinas_config_set local demo_key mine;"
        "xinas_config_set preset demo_key theirs;"
        "xinas_config_seed_local demo_key",
        repo,
    )
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert layer == {"demo_key": "mine"}


def test_seed_local_seeds_only_the_named_key(repo: Path):
    """Seeding the whole document would turn the overlay into a second frozen
    snapshot of the defaults — the failure mode this design exists to remove."""
    _run("xinas_config_seed_local demo_key", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert set(layer) == {"demo_key"}


def test_seed_local_seeds_a_present_false_value(repo: Path):
    """Regression: `.key // "ABSENT"` treats a legitimate `false` the same as
    unset (the same trap documented on xinas_config_get above). A naive port
    of xinas_config_seed_local built on that operator silently skips seeding
    any boolean key whose effective value is false — exactly the shape of
    nvme_auto_namespace, which this task seeds from configure_raid.sh's
    toggle_auto_mode(). Assert the seed actually lands, not just that a
    later read resolves to false (role defaults already default some keys to
    false, so a no-op stub would pass a read-only assertion here too).
    """
    _run("xinas_config_set preset demo_key false; xinas_config_seed_local demo_key", repo)
    layer_path = repo / "playbooks/group_vars/all/20-local.yml"
    assert layer_path.exists(), "a stub that treats false as absent never writes the layer"
    layer = yaml.safe_load(layer_path.read_text())
    assert layer == {"demo_key": False}


def test_seed_local_preserves_a_multiline_structural_value(repo: Path):
    """Regression: xiraid_arrays/xiraid_spare_pools/exports are lists of maps,
    so their effective value is multi-line YAML. Routing that value through
    xinas_config_set's env(VAR) round trip hits its documented fallback for
    any value containing a newline and stores it as a literal block-scalar
    *string* rather than a sequence — confirmed by hand: a subsequent
    `.list[] | select(...)` against a layer seeded that way silently matches
    nothing and the write becomes a no-op. Assert the seeded key is still a
    real sequence (a scalar string would fail this too, since yq's `.[0]` on
    a string is not the same as indexing a sequence) and that indexing into
    it recovers the original first element untouched.
    """
    role = repo / "collection/roles/demo/defaults"
    (role / "main.yml").write_text(
        "demo_list:\n  - name: a\n    devices: [/dev/x]\n  - name: b\n    devices: [/dev/y]\n"
    )
    _run("xinas_config_seed_local demo_list", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert layer == {
        "demo_list": [
            {"name": "a", "devices": ["/dev/x"]},
            {"name": "b", "devices": ["/dev/y"]},
        ]
    }


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


# ─────────────────────────────────────────────────────────────────────────
# Task 5: configure_raid.sh / configure_nfs_exports.sh / configure_network.sh
# read the effective document and write $XINAS_LOCAL_LAYER. The dialog loops
# in these scripts need a real terminal (menu_lib.sh's input_box/msg_box/etc.
# read and write /dev/tty directly) and cannot be driven headlessly, so the
# tests below extract the real, unmodified functions that do the read and
# the write from each script by regex - the same technique already used by
# tests/test_configure_git_repo_gated.py - stub only the TUI primitives, and
# run the extracted code verbatim against a synthetic repo. This exercises
# the editor's own code path rather than a re-implementation of it.
#
# Each test builds an overlay that already overrides part of a multi-element
# structure (a second xiraid_arrays entry, a second export, a sibling scalar
# key) before running one targeted edit, and asserts the untouched part
# keeps its overlay value rather than reverting to the role default - the
# exact failure mode a read-from-defaults/write-to-overlay bug produces.
# ─────────────────────────────────────────────────────────────────────────

CONFIGURE_RAID = (REPO / "configure_raid.sh").read_text()
CONFIGURE_NFS_EXPORTS = (REPO / "configure_nfs_exports.sh").read_text()
CONFIGURE_NETWORK = (REPO / "configure_network.sh").read_text()


def _extract_fn(src: str, name: str) -> str:
    m = re.search(rf"^{re.escape(name)}\(\) \{{.*?^\}}", src, re.M | re.S)
    assert m, f"{name}() not found in source"
    return m.group(0)


def _run_script(script: str, repo_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", script], cwd=repo_dir, capture_output=True, text=True, timeout=20
    )


def test_editor_edit_devices_preserves_untouched_preset_overlay_array(tmp_path: Path):
    """configure_raid.sh's edit_devices(), extracted and run for real. The
    preset layer already overrides both arrays; only the DATA (level 6)
    array is edited. LOG (level 1) must come out of 20-local.yml carrying
    the preset's values, including a field the role default never defines -
    proof the seed came from the effective document, not the role default.
    """
    role = tmp_path / "collection/roles/raid_fs/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text(
        "xiraid_arrays:\n"
        "  - name: data1\n"
        "    level: 6\n"
        "    devices: [/dev/roledefault1]\n"
        "  - name: log1\n"
        "    level: 1\n"
        "    devices: [/dev/roledefault2]\n"
    )
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    (gv / "10-preset.yml").write_text(
        "xiraid_arrays:\n"
        "  - name: data1\n"
        "    level: 6\n"
        "    devices: [/dev/presetdata]\n"
        "  - name: log1\n"
        "    level: 1\n"
        "    devices: [/dev/presetlog]\n"
        "    preset_only_field: keep_me\n"
    )

    fns = "\n".join(
        _extract_fn(CONFIGURE_RAID, n) for n in ("backup_if_changed", "get_devices", "edit_devices")
    )
    script = (
        "set -euo pipefail\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        'vars_file="$XINAS_LOCAL_LAYER"\n'
        f"{fns}\n"
        "msg_box() { :; }\n"
        'input_box() { echo "/dev/editeddata"; }\n'
        "edit_devices 6\n"
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    arrays = {a["name"]: a for a in layer["xiraid_arrays"]}
    assert arrays["data1"]["devices"] == ["/dev/editeddata"]  # the edit landed
    assert arrays["log1"]["devices"] == ["/dev/presetlog"]  # preset value, not role default
    assert arrays["log1"]["preset_only_field"] == "keep_me"  # field only the preset defines


def test_editor_edit_export_preserves_untouched_preset_overlay_export(tmp_path: Path):
    """configure_nfs_exports.sh's edit_export(), extracted and run for real.
    /mnt/archive exists only in the preset layer (the role default never
    defines it); only /mnt/data is edited.
    """
    role = tmp_path / "collection/roles/exports/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text(
        'exports:\n  - path: /mnt/data\n    clients: "*"\n    options: "rw,sync"\n'
    )
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    (gv / "10-preset.yml").write_text(
        "exports:\n"
        "  - path: /mnt/data\n"
        '    clients: "10.0.0.0/24"\n'
        '    options: "rw,sync,preset_opt"\n'
        "  - path: /mnt/archive\n"
        '    clients: "10.0.0.0/8"\n'
        '    options: "ro,sync"\n'
    )

    fns = "\n".join(
        _extract_fn(CONFIGURE_NFS_EXPORTS, n) for n in ("backup_if_changed", "edit_export")
    )
    script = (
        "set -euo pipefail\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        'vars_file="$XINAS_LOCAL_LAYER"\n'
        f"{fns}\n"
        # Branch on the prompt text (arg $2), not call order: input_box runs
        # inside a `$(...)` command substitution, i.e. a subshell, so a
        # counter variable set inside it never persists back to the caller
        # between the two calls edit_export makes.
        "input_box() {\n"
        '  case "$2" in\n'
        '    Clients*) echo "192.168.5.0/24" ;;\n'
        '    Options*) echo "rw,sync,edited" ;;\n'
        '    *) echo "UNEXPECTED PROMPT: $2" >&2; exit 9 ;;\n'
        "  esac\n"
        "}\n"
        "msg_box() { :; }\n"
        'edit_export "/mnt/data"\n'
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    exports = {e["path"]: e for e in layer["exports"]}
    assert exports["/mnt/data"]["clients"] == "192.168.5.0/24"
    assert exports["/mnt/data"]["options"] == "rw,sync,edited"
    # untouched, preset-layer-only export must survive unchanged
    assert exports["/mnt/archive"] == {
        "path": "/mnt/archive",
        "clients": "10.0.0.0/8",
        "options": "ro,sync",
    }


def test_editor_pool_settings_write_preserves_sibling_keys(tmp_path: Path):
    """configure_network.sh's get_pool_settings()/save_pool_settings(),
    extracted and run for real. Regression coverage for the bug documented
    on save_pool_settings itself: the function it replaced was a `cat >`
    that emitted a fixed eight-key file, silently dropping every other key
    the role defaults (or a preset) had set. net_mtu here comes from the
    preset layer and net_manual_ips from the role default; save_pool_settings
    touches neither.
    """
    role = tmp_path / "collection/roles/net_controllers/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text(
        "net_ip_pool_enabled: true\n"
        'net_ip_pool_start: "10.10.1.1"\n'
        'net_ip_pool_end: "10.10.255.1"\n'
        "net_ip_pool_prefix: 24\n"
        "net_manual_ips: {special: true}\n"
        "net_mtu: 0\n"
    )
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    (gv / "10-preset.yml").write_text("net_mtu: 9000\n")

    fns = "\n".join(
        _extract_fn(CONFIGURE_NETWORK, n) for n in ("get_pool_settings", "save_pool_settings")
    )
    script = (
        "set -e\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        f"{fns}\n"
        "get_pool_settings\n"
        'echo "before:$pool_start:$pool_prefix"\n'
        'save_pool_settings "10.20.1.1" "10.20.255.1" "26"\n'
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert "before:10.10.1.1:24" in r.stdout  # the read came from the effective document

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    # Targeted write: only the four pool keys land in the local layer.
    assert set(layer) == {
        "net_ip_pool_enabled",
        "net_ip_pool_start",
        "net_ip_pool_end",
        "net_ip_pool_prefix",
    }
    assert layer["net_ip_pool_start"] == "10.20.1.1"
    assert layer["net_ip_pool_prefix"] == 26

    r2 = _run_script(f'REPO_DIR="{tmp_path}"\n. "{HELPER}"\nxinas_config_effective\n', tmp_path)
    effective = yaml.safe_load(r2.stdout)
    assert effective["net_mtu"] == 9000  # preset-layer sibling, untouched
    assert effective["net_manual_ips"] == {"special": True}  # role-default sibling, untouched


def _extract_lines(src: str, start_marker: str, end_marker: str) -> str:
    """Pull the literal text between two lines (exclusive of end_marker),
    for a code region that is not its own function.
    """
    start = src.index(start_marker)
    end = src.index(end_marker, start)
    return src[start:end]


SIMPLE_MENU = (REPO / "simple_menu.sh").read_text()


def test_editor_reuse_existing_arrays_writes_survive_a_fresh_checkout(tmp_path: Path):
    """simple_menu.sh's reuse_existing_arrays() (the existing-RAID import
    wizard) runs six writes against the overlay: four scalar xinas_config_set
    calls, then two structural `yq -i "..." "$raid_vars"` calls that rebuild
    xiraid_arrays/xfs_filesystems wholesale from a live hardware scan. This
    extracts the real six lines (by anchor, since they live inline in a much
    larger function rather than in one of their own) and runs them against a
    repo with NO 20-local.yml yet - the actual state of a fresh checkout.
    `yq -i` on a file that does not exist errors ("no such file or
    directory") rather than creating it (confirmed by hand against the real
    yq binary), so if the four scalar writes were left as the raw
    `yq -i "..." "$auto_vars"` the brief's Step 9 describes instead of
    xinas_config_set, this whole wizard would fail on every operator's first
    use of it.
    """
    role = tmp_path / "collection/roles/raid_fs/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("xiraid_force_metadata: true\nxfs_force_mkfs: true\n")
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    assert not (gv / "20-local.yml").exists()  # sanity: this is the fresh-checkout case

    scalar_writes = _extract_lines(
        SIMPLE_MENU,
        "    # All configuration writes land in the overlay",
        "    # Build xiraid_arrays YAML",
    )
    structural_writes = _extract_lines(
        SIMPLE_MENU,
        "    yq -i 'del(.xiraid_arrays)",
        '    msg_box "',
    )
    # `local` (used by the extracted lines) only works inside a function, so
    # the extracted block is wrapped in one here the same way it lives inside
    # reuse_existing_arrays() in the real script.
    script = (
        "set -euo pipefail\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        f'TMP_DIR="{tmp_path}"\n'
        "run_writes() {\n"
        f"{scalar_writes}\n"
        f'echo "xiraid_arrays: [{{name: fromscan, level: 6, devices: [/dev/scanned]}}]" '
        f'> "{tmp_path}/raid_config.yml"\n'
        f"{structural_writes}\n"
        "}\n"
        "run_writes\n"
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    assert layer["nvme_auto_namespace"] is False
    assert layer["xiraid_skip_install"] is True
    assert layer["xiraid_force_metadata"] is False
    assert layer["xfs_force_mkfs"] is False
    assert layer["xiraid_arrays"] == [{"name": "fromscan", "level": 6, "devices": ["/dev/scanned"]}]
