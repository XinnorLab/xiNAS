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
        _extract_fn(CONFIGURE_NETWORK, n)
        for n in ("enable_pool_mode", "get_pool_settings", "save_pool_settings")
    )
    script = (
        "set -e\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        f'LIVE_TEMPLATE="{tmp_path}/live-netplan.yaml.j2"\n'
        f"{fns}\n"
        "get_pool_settings\n"
        'echo "before:$pool_start:$pool_prefix"\n'
        'save_pool_settings "10.20.1.1" "10.20.255.1" "26"\n'
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert "before:10.10.1.1:24" in r.stdout  # the read came from the effective document

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    # Targeted write: the four pool keys, plus enable_pool_mode()'s own
    # net_netplan_template reset (Critical 3, final review) - nothing else.
    assert set(layer) == {
        "net_ip_pool_enabled",
        "net_ip_pool_start",
        "net_ip_pool_end",
        "net_ip_pool_prefix",
        "net_netplan_template",
    }
    assert layer["net_ip_pool_start"] == "10.20.1.1"
    assert layer["net_ip_pool_prefix"] == 26
    assert layer["net_netplan_template"] == "netplan.yaml.j2"

    r2 = _run_script(f'REPO_DIR="{tmp_path}"\n. "{HELPER}"\nxinas_config_effective\n', tmp_path)
    effective = yaml.safe_load(r2.stdout)
    assert effective["net_mtu"] == 9000  # preset-layer sibling, untouched
    assert effective["net_manual_ips"] == {"special": True}  # role-default sibling, untouched


def test_editor_save_pool_settings_clears_a_stale_manual_override(tmp_path: Path):
    """Regression (Critical, fix round 1): the normal way an operator returns
    to pool mode is menu -> "Configure IP Pool" -> save_pool_settings(), not
    configure_manual()'s "nothing configured" bail-out. net_controllers's
    "Deploy netplan configuration" task (tasks/main.yml, Step 4) renders
    whatever net_netplan_template points at whenever net_ip_pool_enabled is
    true and net_allocated_ips is non-empty - the normal case on real
    hardware - regardless of which path turned pool mode back on. Simulates
    "manual mode was configured earlier" directly (net_netplan_template set,
    $LIVE_TEMPLATE present) and runs the real save_pool_settings() - the
    literal function configure_ip_pool() calls on a successful save - then
    asserts the override now explicitly points back at the role's own
    template and the file is gone afterward, so the role falls back to its
    own template rather than silently keeping the stale manual one.
    """
    role = tmp_path / "collection/roles/net_controllers/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text(
        "net_ip_pool_enabled: true\n"
        'net_ip_pool_start: "10.10.1.1"\n'
        'net_ip_pool_end: "10.10.255.1"\n'
        "net_ip_pool_prefix: 24\n"
        "net_netplan_template: netplan.yaml.j2\n"
    )
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    live_template = tmp_path / "xinas-local/netplan.yaml.j2"
    live_template.parent.mkdir(parents=True)
    live_template.write_text("network: {}\n")
    (gv / "20-local.yml").write_text(
        f'net_ip_pool_enabled: false\nnet_netplan_template: "{live_template}"\n'
    )
    assert live_template.exists()  # sanity: manual mode really is active

    fns = "\n".join(
        _extract_fn(CONFIGURE_NETWORK, n) for n in ("enable_pool_mode", "save_pool_settings")
    )
    script = (
        "set -e\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        f'LIVE_TEMPLATE="{live_template}"\n'
        f"{fns}\n"
        'save_pool_settings "10.30.1.1" "10.30.255.1" "24"\n'
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    # Critical 3 (final review) changed this from a delete to an explicit
    # override: the key is still present, now pointing at the role's own
    # template rather than the stale manual path.
    assert layer["net_netplan_template"] == "netplan.yaml.j2"
    assert not live_template.exists()  # stale manual template file removed

    r2 = _run_script(f'REPO_DIR="{tmp_path}"\n. "{HELPER}"\nxinas_config_effective\n', tmp_path)
    effective = yaml.safe_load(r2.stdout)
    # With the override reset, the effective document falls back to the
    # role's own default template - proof the role would render its own
    # dynamic netplan again, not the stale manual one.
    assert effective["net_netplan_template"] == "netplan.yaml.j2"
    assert effective["net_ip_pool_enabled"] is True


def test_editor_enable_pool_mode_clears_a_preset_layer_manual_override(tmp_path: Path):
    """Regression (Critical 3, final review): the round-1 fix above only ever
    proved enable_pool_mode() against a net_netplan_template override living
    in 20-local.yml, because at the time nothing could put the key in
    10-preset.yml. xinas_save_preset now refuses to save the key at all
    (Critical 2), but that does nothing for a preset saved before that fix,
    or a hand-authored one - xinas_apply_preset has never rejected the
    net_netplan_template *key*, only a literal netplan.yaml.j2 *file*.
    Simulates that: the override lives in 10-preset.yml, and 20-local.yml
    never defines the key at all (it only turns pool mode off, which is what
    a real manual-mode save does - see save_pool_settings above). The old
    `yq -i 'del(.net_netplan_template)' "$XINAS_LOCAL_LAYER"` touched
    20-local.yml only, so this preset-layer value kept winning after
    "returning to pool mode" - the TUI would report pool mode enabled while
    net_controllers rendered (or, once $LIVE_TEMPLATE is removed below,
    failed to find) the stale manual template.
    """
    role = tmp_path / "collection/roles/net_controllers/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("net_netplan_template: netplan.yaml.j2\n")
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    live_template = tmp_path / "xinas-local/netplan.yaml.j2"
    live_template.parent.mkdir(parents=True)
    live_template.write_text("network: {}\n")
    (gv / "10-preset.yml").write_text(f'net_netplan_template: "{live_template}"\n')
    (gv / "20-local.yml").write_text("net_ip_pool_enabled: false\n")
    assert live_template.exists()  # sanity: manual mode really is active

    fn = _extract_fn(CONFIGURE_NETWORK, "enable_pool_mode")
    script = (
        "set -e\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        f'LIVE_TEMPLATE="{live_template}"\n'
        f"{fn}\n"
        "enable_pool_mode\n"
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    assert not live_template.exists()  # stale manual template file removed

    preset_layer = yaml.safe_load((gv / "10-preset.yml").read_text())
    # Untouched - proof this is a real conflict between the two layers, not
    # an absent one silently agreeing with the fix.
    assert preset_layer["net_netplan_template"] == str(live_template)

    local_layer = yaml.safe_load((gv / "20-local.yml").read_text())
    assert local_layer["net_netplan_template"] == "netplan.yaml.j2"

    r2 = _run_script(f'REPO_DIR="{tmp_path}"\n. "{HELPER}"\nxinas_config_effective\n', tmp_path)
    effective = yaml.safe_load(r2.stdout)
    # The property that matters: despite the preset layer still pointing at
    # the removed file, the local layer's explicit override wins (20- beats
    # 10-), so the EFFECTIVE value falls back to the role's own template.
    assert effective["net_netplan_template"] == "netplan.yaml.j2"


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


def test_editor_manual_mode_save_survives_a_fresh_live_template(tmp_path: Path):
    """Regression (Critical, fix round 2): backup_if_changed's old
    `[ -f "$file" ] || return` returned the failed test's own exit status
    (1, not 0) when the file did not exist. configure_network.sh runs under
    `set -e` and calls backup_if_changed as a plain simple command, so the
    *first* manual-mode save on a fresh install - where $LIVE_TEMPLATE
    (.xinas-local/netplan.yaml.j2) has never been written - aborted the
    whole script before `mv` wrote the template (line ~268) or
    xinas_config_set recorded the override (line ~269). Drives the real
    write section of configure_manual() (extracted by line anchor, same
    technique as simple_menu.sh's reuse_existing_arrays() test above) plus
    the real backup_if_changed, with $LIVE_TEMPLATE computed exactly as the
    real script computes it and never written to beforehand.
    """
    role = tmp_path / "collection/roles/net_controllers/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("net_netplan_template: netplan.yaml.j2\n")
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    assert not (tmp_path / ".xinas-local").exists()  # sanity: fresh-install case

    fns = _extract_fn(CONFIGURE_NETWORK, "backup_if_changed")
    write_section = _extract_lines(
        CONFIGURE_NETWORK,
        "    tmp_file=$(mktemp)",
        '    msg_box "Manual Config Saved"',
    )
    script = (
        "set -e\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        # Computed the same way line 12 of the real script computes it, not
        # hand-picked by the test, so this exercises the real fresh-install path.
        'LIVE_TEMPLATE="$XINAS_LOCAL_ARTEFACTS/netplan.yaml.j2"\n'
        f"{fns}\n"
        "run_save() {\n"
        '    local configs=("eth0:192.168.1.1/24")\n'
        f"{write_section}\n"
        "}\n"
        "run_save\n"
        'echo "LIVE_TEMPLATE_PATH=$LIVE_TEMPLATE"\n'
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"

    live_template_line = next(
        line for line in r.stdout.splitlines() if line.startswith("LIVE_TEMPLATE_PATH=")
    )
    live_template = Path(live_template_line.split("=", 1)[1])

    assert live_template.exists()  # the template was actually written
    assert "eth0" in live_template.read_text()

    layer = yaml.safe_load((gv / "20-local.yml").read_text())
    assert layer["net_netplan_template"] == str(live_template)  # the override was recorded


# ─────────────────────────────────────────────────────────────────────────
# Task 11: configure_hostname.sh writes the overlay, not the tracked role
# default it used to `mv` straight onto. Same extraction technique as the
# Task 5 tests above. Unlike configure_raid.sh/configure_nfs_exports.sh, the
# read/seed/write sequence here is top-level script flow, not its own
# function - the same shape configure_network.sh's configure_manual() write
# section and simple_menu.sh's reuse_existing_arrays() writes are in above -
# so this uses _extract_lines by anchor text rather than _extract_fn.
# ─────────────────────────────────────────────────────────────────────────

CONFIGURE_HOSTNAME = (REPO / "configure_hostname.sh").read_text()


def test_hostname_backup_if_changed_returns_success_when_file_absent(tmp_path: Path):
    """Regression: the same `[ -f "$file" ] || return` shape Task 5 fixed in
    the other three copies of this function (configure_raid.sh,
    configure_nfs_exports.sh, configure_network.sh). A bare `return` yields
    the failed `[ -f "$file" ]` test's own exit status (1); both call sites
    in this script invoke the function as a plain simple command under
    `set -euo pipefail`, so hitting this branch would silently abort the
    whole script instead of being treated as "nothing to back up yet" - the
    state $XINAS_LOCAL_LAYER is in until xinas_config_seed_local creates it.
    Calls the real, extracted function directly against a file that does not
    exist, independent of the rest of the script, so this fails regardless
    of whether some other caller happens to mask the bug (as seeding does
    for the $vars_file call site exercised by the test below).
    """
    fn = _extract_fn(CONFIGURE_HOSTNAME, "backup_if_changed")
    newfile = tmp_path / "new"
    newfile.write_text("content\n")
    script = (
        "set -euo pipefail\n"
        f"{fn}\n"
        f'backup_if_changed "{tmp_path}/does-not-exist" "{newfile}"\n'
        'echo "RC=$?"\n'
    )
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert "RC=0" in r.stdout
    assert not list(tmp_path.glob("*.bak"))  # nothing existed, so nothing was backed up


def test_hostname_backup_if_changed_actually_backs_up_a_changed_file(tmp_path: Path):
    """Companion to the test above, and the reason that one names a specific
    file rather than checking the return code alone: a
    `backup_if_changed() { return 0; }` stub - fully inert, never inspecting
    either argument - reports success and creates no backup file, exactly
    like the correct behavior for "nothing existed yet". Checking only
    "returns 0 and no .bak file" (the previous test) cannot tell the two
    apart. This drives the real function against a file that DOES exist and
    DOES differ, and checks a `.bak` copy actually landed with the pre-edit
    content - the one outcome a no-op stub cannot fake.
    """
    fn = _extract_fn(CONFIGURE_HOSTNAME, "backup_if_changed")
    existing = tmp_path / "existing"
    existing.write_text("old-content\n")
    newfile = tmp_path / "new"
    newfile.write_text("new-content\n")
    script = f'set -euo pipefail\n{fn}\nbackup_if_changed "{existing}" "{newfile}"\n'
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    backups = list(tmp_path.glob("existing.*.bak"))
    assert len(backups) == 1, f"expected exactly one backup file, found {backups}"
    assert backups[0].read_text() == "old-content\n"  # the pre-edit content was preserved
    assert existing.read_text() == "old-content\n"  # backup_if_changed itself never mutates $file


def test_editor_hostname_write_lands_in_local_layer_not_role_defaults(tmp_path: Path):
    """configure_hostname.sh's real read/seed/write sequence, extracted and
    run for real.

    Before this task, `vars_file` was collection/roles/common/defaults/main.yml
    and the script `mv`'d straight onto it - a runtime write to a tracked
    role default, exactly what `git checkout --force` (the update path)
    silently discards on every update. Both halves of the fix are proved
    here: the new hostname lands in the overlay, AND the tracked role
    default file comes out byte-identical to what it was before the edit -
    asserting only the former would still pass a script that wrote the new
    value to the overlay *in addition to* the old role-default path.

    The preset layer starts with an existing xinas_hostname value (not the
    role default's own empty-string default, and no 20-local.yml exists yet
    - the fresh-checkout case), and the stubbed input_box captures the
    "current" value it was prompted with, proving that value came from
    xinas_config_effective (the preset layer), not from the role default.
    """
    role = tmp_path / "collection/roles/common/defaults"
    role.mkdir(parents=True)
    role_defaults_before = 'common_timezone: "Europe/Amsterdam"\nxinas_hostname: ""\n'
    (role / "main.yml").write_text(role_defaults_before)
    gv = tmp_path / "playbooks/group_vars/all"
    gv.mkdir(parents=True)
    (gv / "10-preset.yml").write_text('xinas_hostname: "preset-host"\n')
    assert not (gv / "20-local.yml").exists()  # sanity: fresh checkout, no prior edit

    fns = "\n".join(
        _extract_fn(CONFIGURE_HOSTNAME, n) for n in ("backup_if_changed", "valid_hostname")
    )
    write_section = _extract_lines(
        CONFIGURE_HOSTNAME,
        "current=$(xinas_config_effective",
        'update_hosts_file "$name"',
    )
    script = (
        "set -euo pipefail\n"
        f'REPO_DIR="{tmp_path}"\n'
        f'. "{HELPER}"\n'
        'vars_file="$XINAS_LOCAL_LAYER"\n'
        f"{fns}\n"
        "msg_box() { :; }\n"
        'input_box() { echo "SEEN_CURRENT=$3" >&2; echo "new-hostname"; }\n'
        f"{write_section}\n"
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert "SEEN_CURRENT=preset-host" in r.stderr  # prompt default came from the effective doc

    local_layer = yaml.safe_load((gv / "20-local.yml").read_text())
    assert local_layer == {"xinas_hostname": "new-hostname"}  # the edit landed in the overlay

    preset_layer = yaml.safe_load((gv / "10-preset.yml").read_text())
    assert preset_layer == {"xinas_hostname": "preset-host"}  # preset layer untouched

    # The property that matters most: the tracked role default is
    # byte-identical to what it was before the edit.
    assert (role / "main.yml").read_text() == role_defaults_before


# ─────────────────────────────────────────────────────────────────────────
# Task 6: xinas_save_preset decomposes the live overlay (preset + local
# layers, never role defaults) back into presets/<name>/*.yml, routed by
# which role's defaults/main.yml owns each key. This is the inverse of
# xinas_apply_preset, and the two are proved consistent by the round-trip
# test near the end of this section: save, wipe the live overlay entirely,
# re-apply, and compare the effective document key by key.
# ─────────────────────────────────────────────────────────────────────────


def _save_repo(tmp_path: Path) -> Path:
    for role, body in (
        ("net_controllers", "net_mtu: 0\n"),
        ("nvme_namespace", "nvme_raid_data_level: 5\n"),
        ("perf_tuning", "perf_nr_requests: 128\n"),
    ):
        d = tmp_path / f"collection/roles/{role}/defaults"
        d.mkdir(parents=True)
        (d / "main.yml").write_text(body)
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    (tmp_path / "playbooks/site.yml").write_text("---\n- hosts: storage_nodes\n  roles: []\n")
    return tmp_path


def test_save_preset_routes_keys_by_owning_role(tmp_path: Path):
    repo = _save_repo(tmp_path)
    _run(
        "xinas_config_set local net_mtu 9000;"
        "xinas_config_set preset nvme_raid_data_level 6;"
        "xinas_save_preset saved",
        repo,
    )
    p = repo / "presets/saved"
    assert yaml.safe_load((p / "network.yml").read_text()) == {"net_mtu": 9000}
    assert yaml.safe_load((p / "nvme_namespace.yml").read_text()) == {"nvme_raid_data_level": 6}


def test_save_preset_reports_a_key_no_preset_file_owns(tmp_path: Path):
    """perf_tuning has no preset file; the key cannot round-trip, so it is
    named rather than silently dropped into an unrelated file.
    """
    repo = _save_repo(tmp_path)
    r = _run("xinas_config_set local perf_nr_requests 0; xinas_save_preset saved", repo)
    assert "perf_nr_requests" in (r.stdout + r.stderr)


def test_save_preset_copies_site_yml_as_the_playbook(tmp_path: Path):
    repo = _save_repo(tmp_path)
    _run("xinas_save_preset saved", repo)
    assert (repo / "presets/saved/playbook.yml").read_text() == (
        repo / "playbooks/site.yml"
    ).read_text()


def test_save_preset_writes_only_the_playbook_when_the_overlay_is_empty(tmp_path: Path):
    """A fresh checkout: no preset ever applied, no operator edits, neither
    overlay file exists. xinas_save_preset must not error out just because
    there is nothing to decompose - it saves an (empty) preset carrying just
    the playbook.
    """
    repo = _save_repo(tmp_path)
    gv = repo / "playbooks/group_vars/all"
    assert not (gv / "10-preset.yml").exists()
    assert not (gv / "20-local.yml").exists()

    r = _run("xinas_save_preset saved", repo)
    assert r.returncode == 0, r.stderr
    saved = [p.name for p in (repo / "presets/saved").glob("*")]
    assert saved == ["playbook.yml"]


def test_save_preset_preserves_the_preset_layer_when_no_local_layer_exists(tmp_path: Path):
    """Regression: an early draft of xinas_save_preset merged the two
    overlay layers with `yq eval-all ... "$XINAS_PRESET_LAYER"
    "$XINAS_LOCAL_LAYER"` unconditionally, passing a path to a file that may
    not exist. yq exits nonzero when a listed file is missing (confirmed by
    hand against the real binary), and that draft's fallback on failure was
    `echo '{}' > overlay` - silently discarding the ENTIRE preset layer's
    content whenever the operator has made no local edits yet, which is the
    common state right after xinas_apply_preset. Only the preset layer is
    populated here; the local layer is never created, matching that case
    exactly.
    """
    repo = _save_repo(tmp_path)
    gv = repo / "playbooks/group_vars/all"
    assert not (gv / "20-local.yml").exists()  # sanity: the missing-file case

    r = _run("xinas_config_set preset net_mtu 9000; xinas_save_preset saved", repo)
    assert r.returncode == 0, r.stderr
    network_file = repo / "presets/saved/network.yml"
    assert network_file.exists(), "a stub with the missing-file bug never writes this"
    assert yaml.safe_load(network_file.read_text()) == {"net_mtu": 9000}


def test_save_preset_preserves_the_local_layer_when_no_preset_layer_exists(tmp_path: Path):
    """Symmetric case: an operator who hand-edits settings without ever
    applying a preset has a local layer but no preset layer.
    """
    repo = _save_repo(tmp_path)
    gv = repo / "playbooks/group_vars/all"
    assert not (gv / "10-preset.yml").exists()  # sanity: the missing-file case

    r = _run("xinas_config_set local nvme_raid_data_level 6; xinas_save_preset saved", repo)
    assert r.returncode == 0, r.stderr
    nvme_file = repo / "presets/saved/nvme_namespace.yml"
    assert nvme_file.exists(), "a stub with the missing-file bug never writes this"
    assert yaml.safe_load(nvme_file.read_text()) == {"nvme_raid_data_level": 6}


def test_save_preset_replaces_rather_than_accumulates(tmp_path: Path):
    """Mirrors test_apply_preset_replaces_rather_than_accumulates: a re-save
    under a name that already has preset files must not leave a key behind
    that the live overlay no longer sets.
    """
    repo = _save_repo(tmp_path)
    _run("xinas_config_set local net_mtu 9000; xinas_save_preset saved", repo)
    network_file = repo / "presets/saved/network.yml"
    assert yaml.safe_load(network_file.read_text()) == {"net_mtu": 9000}  # sanity: it landed

    gv = repo / "playbooks/group_vars/all"
    (gv / "20-local.yml").unlink()
    _run("xinas_config_set local nvme_raid_data_level 6; xinas_save_preset saved", repo)
    assert not network_file.exists()  # stale file removed, not left holding net_mtu
    nvme_file = repo / "presets/saved/nvme_namespace.yml"
    assert yaml.safe_load(nvme_file.read_text()) == {"nvme_raid_data_level": 6}


def test_save_preset_fails_closed_on_a_malformed_overlay(tmp_path: Path):
    """Mirrors test_apply_preset_fails_closed_on_a_malformed_var_file: a
    corrupt overlay must abort the save with a nonzero exit rather than
    silently writing an empty or partial preset that looks complete.
    """
    repo = _save_repo(tmp_path)
    gv = repo / "playbooks/group_vars/all"
    (gv / "10-preset.yml").write_text("this: [is, not, valid: yaml\n")

    r = _run("xinas_save_preset saved || echo RC=$?", repo)
    assert "RC=0" not in r.stdout
    assert "RC=" in r.stdout
    assert list((repo / "presets/saved").glob("*")) == []  # nothing written at all


def test_save_preset_reports_failure_under_the_guarded_calling_convention(tmp_path: Path):
    """xinas_save_preset's real caller (startup_menu.sh's save_preset,
    mirroring the already-landed apply_preset wrapper) invokes it as
    `out=$(xinas_save_preset ...) || rc=$?` - never as a bare top-level
    statement. Per documented bash behavior, a function executing inside
    such a guard has `errexit` suspended for its ENTIRE body, not just the
    outer call: confirmed by hand with a throwaway probe function containing
    a bare `false` partway through a loop - called this way, the loop ran to
    completion and the function reported rc=0, while an identical bare
    top-level call correctly aborted at the failure. A bare, unguarded
    statement inside xinas_save_preset would therefore silently continue
    past a real write failure and still report success under the exact
    convention production uses - invisible to a test that only calls the
    function bare, which every other test in this file does. This one drives
    it through the guarded form instead, and forces a genuine failure (the
    playbook it must copy is missing) partway through the function.
    """
    repo = _save_repo(tmp_path)
    (repo / "playbooks/site.yml").unlink()

    r = _run(
        "rc=0; out=$(xinas_save_preset saved 2>&1 >/dev/null) || rc=$?; echo RC=$rc",
        repo,
    )
    assert "RC=0" not in r.stdout, r.stdout


def test_key_owner_prints_the_owning_preset_file(tmp_path: Path):
    repo = _save_repo(tmp_path)
    r = _run("xinas_key_owner net_mtu", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "network.yml"


def test_key_owner_fails_for_a_key_no_mapped_role_defines(tmp_path: Path):
    """perf_tuning defines perf_nr_requests, but perf_tuning has no preset
    file - the scan must not guess raid_fs.yml as a catch-all.
    """
    repo = _save_repo(tmp_path)
    r = _run("xinas_key_owner perf_nr_requests || echo RC=$?", repo)
    assert r.stdout.strip() == "RC=1"  # nothing printed before the failure marker


def test_key_owner_fails_for_a_key_no_role_defines_at_all(tmp_path: Path):
    repo = _save_repo(tmp_path)
    r = _run("xinas_key_owner totally_unknown_key || echo RC=$?", repo)
    assert r.stdout.strip() == "RC=1"


def test_key_owner_continues_past_an_unmapped_role_to_a_later_mapped_one(tmp_path: Path):
    """The scan does not stop at the first role that defines the key - it
    keeps looking until it finds one actually mapped to a preset file. Not
    just theoretical: xinas_storage_reset is defined by both nvme_namespace
    and raid_fs in the real role defaults today, and both happen to be
    mapped, so this only bites once an unmapped role sorts ahead of a mapped
    one - exercised directly here so a future role addition or rename can't
    silently break it unnoticed. perf_tuning (unmapped) sorts before the
    raid_fs added below (mapped); both define perf_nr_requests.
    """
    repo = _save_repo(tmp_path)
    d = repo / "collection/roles/raid_fs/defaults"
    d.mkdir(parents=True)
    (d / "main.yml").write_text("perf_nr_requests: 999\n")

    r = _run("xinas_key_owner perf_nr_requests", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "raid_fs.yml"


def _roundtrip_repo(tmp_path: Path) -> Path:
    """One role per mapped preset file, each contributing one key, spanning
    every value shape xinas_save_preset must round-trip: net_controllers
    (int), raid_fs (bool + a structural list of maps), nvme_namespace
    (string), exports (a second, independent structural list of maps).
    """
    d = tmp_path / "collection/roles/net_controllers/defaults"
    d.mkdir(parents=True)
    (d / "main.yml").write_text("net_mtu: 1500\n")

    d = tmp_path / "collection/roles/raid_fs/defaults"
    d.mkdir(parents=True)
    (d / "main.yml").write_text("xiraid_force_metadata: true\nxiraid_arrays: []\n")

    d = tmp_path / "collection/roles/nvme_namespace/defaults"
    d.mkdir(parents=True)
    (d / "main.yml").write_text('nvme_label: "default"\n')

    d = tmp_path / "collection/roles/exports/defaults"
    d.mkdir(parents=True)
    (d / "main.yml").write_text("exports: []\n")

    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    (tmp_path / "playbooks/site.yml").write_text("---\n- hosts: storage_nodes\n  roles: []\n")
    return tmp_path


def test_save_then_apply_round_trips_every_value_shape(tmp_path: Path):
    """The property this task exists for: a preset saved from a configured
    system, then applied to a fresh one, must reproduce the same effective
    configuration - across every value shape the overlay can hold, not just
    the strings a shell variable happens to pass through unchanged. Sets one
    value of each shape - bool false, int, string, and two independent
    structural lists of maps (the shape that broke outright in this task's
    own first draft; see the load() comment on xinas_save_preset) - saves,
    clears the live overlay completely, re-applies the saved preset, and
    compares the effective document against the original values key by key.
    A save that silently drops a key or restringifies a bool/list would pass
    a shallower test that only checked "some preset file got written"; this
    would not.
    """
    repo = _roundtrip_repo(tmp_path)
    gv = repo / "playbooks/group_vars/all"

    r = _run(
        "xinas_config_set preset net_mtu 9000;"
        "xinas_config_set preset xiraid_force_metadata false;"
        "xinas_config_set local nvme_label custom-label",
        repo,
    )
    assert r.returncode == 0, r.stderr

    xiraid_arrays = [
        {"name": "data1", "level": 6, "devices": ["/dev/nvme1n1", "/dev/nvme2n1"]},
        {"name": "log1", "level": 1, "devices": ["/dev/nvme3n1"]},
    ]
    exports = [{"path": "/mnt/data", "clients": "10.0.0.0/24", "options": "rw,sync"}]
    # Structural values are written directly, the same way a real preset
    # apply or a structural editor write puts them there - never through
    # xinas_config_set's scalar setter, which has a documented literal-string
    # fallback for any value spanning multiple lines.
    preset_layer = gv / "10-preset.yml"
    layer = yaml.safe_load(preset_layer.read_text())
    layer["xiraid_arrays"] = xiraid_arrays
    preset_layer.write_text(yaml.dump(layer, sort_keys=False))

    local_layer = gv / "20-local.yml"
    layer = yaml.safe_load(local_layer.read_text())
    layer["exports"] = exports
    local_layer.write_text(yaml.dump(layer, sort_keys=False))

    original = {
        "net_mtu": 9000,
        "xiraid_force_metadata": False,
        "nvme_label": "custom-label",
        "xiraid_arrays": xiraid_arrays,
        "exports": exports,
    }

    r = _run("xinas_save_preset roundtrip", repo)
    assert r.returncode == 0, r.stderr

    # Clear the live overlay completely before reapplying - nothing may
    # survive by accident from the pre-save state.
    preset_layer.unlink()
    local_layer.unlink()

    r = _run("xinas_apply_preset roundtrip", repo)
    assert r.returncode == 0, r.stderr

    r = _run("xinas_config_effective", repo)
    assert r.returncode == 0, r.stderr
    effective = yaml.safe_load(r.stdout)
    for key, value in original.items():
        assert effective[key] == value, f"{key}: expected {value!r}, got {effective.get(key)!r}"


# ─────────────────────────────────────────────────────────────────────────
# Task 7: migration bridge for hosts installed before this overlay design
# existed, when apply_preset overwrote git-tracked role defaults directly.
# The update flow force-checks-out the tree before any new code runs, so
# those mutated defaults are gone by the time xinas_migrate_overlay ever
# executes - the only thing that survives is the untracked marker file every
# xinas_apply_preset call writes. These tests drive the three states the
# bridge can find a host in: marker present and not yet migrated, already
# migrated, and no marker at all (a normal fresh install, never touched by
# the old mechanism).
# ─────────────────────────────────────────────────────────────────────────


def test_migration_reapplies_the_marked_preset(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    marker = tmp_path / "marker"
    marker.write_text("vm\n")
    r = _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    assert r.returncode == 0, r.stderr
    # Interface contract: one line describing what it did, so the menus can
    # surface it (`migrated=$(xinas_migrate_overlay); [ -n "$migrated" ] && ...`).
    # A stub that writes the overlay but stays silent would leave the
    # operator with no idea their configuration just changed.
    out_lines = r.stdout.strip().splitlines()
    assert len(out_lines) == 1, r.stdout
    assert "vm" in out_lines[0]
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert layer["demo_key"] == "from_preset"


def test_migration_is_a_noop_once_migrated(tmp_path: Path):
    """The property this bridge exists to get right: once migrated, a later
    run must never re-read the marker and stomp an overlay edit made since.

    Checking only the post-edit value is not enough - a fully-stubbed
    xinas_migrate_overlay that writes nothing, ever, would still pass a test
    that only asserts the manually-written value survives a second no-op
    call, because nothing in that shape of test requires the FIRST call to
    have done anything real. Assert the first call's own effect (the marked
    preset's value, genuinely landed) before overwriting it, so a stub that
    skips the real migration is caught right there instead of accidentally
    passing.
    """
    repo = _preset_repo(tmp_path)
    marker = tmp_path / "marker"
    marker.write_text("vm\n")
    layer_path = repo / "playbooks/group_vars/all/10-preset.yml"

    r1 = _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    assert r1.returncode == 0, r1.stderr
    layer = yaml.safe_load(layer_path.read_text())
    assert layer["demo_key"] == "from_preset"  # proof the first call really migrated

    _run("xinas_config_set preset demo_key edited_after_migration", repo)

    r2 = _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    assert r2.returncode == 0, r2.stderr
    assert r2.stdout.strip() == ""  # already migrated: nothing to report
    layer = yaml.safe_load(layer_path.read_text())
    assert layer["demo_key"] == "edited_after_migration"


def test_migration_without_a_marker_leaves_the_overlay_absent(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run(f'XINAS_PRESET_MARKER="{tmp_path}/absent" xinas_migrate_overlay', repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == ""  # nothing to do: nothing to report
    assert not (repo / "playbooks/group_vars/all/10-preset.yml").exists()


def test_migration_with_an_unknown_preset_in_the_marker_leaves_the_overlay_absent(
    tmp_path: Path,
):
    """A legacy marker can name a preset that no longer ships (renamed or
    removed from presets/ since the host was first installed). Migration
    must degrade gracefully - report on stderr and leave the overlay absent
    for a normal preset pick later - rather than blocking menu startup.
    """
    repo = _preset_repo(tmp_path)
    marker = tmp_path / "marker"
    marker.write_text("no-longer-shipped\n")
    r = _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    assert r.returncode == 0, r.stderr
    assert "no-longer-shipped" in r.stderr
    assert r.stdout.strip() == ""
    assert not (repo / "playbooks/group_vars/all/10-preset.yml").exists()
