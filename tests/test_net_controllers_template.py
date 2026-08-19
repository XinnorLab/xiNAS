"""Regression guard for netplan IP assignment on the data interfaces.

`net_controllers` detects high-speed NICs and allocates each one an address from
`net_ip_pool_*`, rendering them through `templates/netplan.yaml.j2`. Two bugs
used to defeat that end to end:

1. `presets/{default,xinnorVM}/netplan.yaml.j2` were static snapshots taken back
   when the template had no Jinja in it. `autoinstall.sh` copies preset files
   over role files, so the dynamic template was replaced by a literal config for
   an interface named `ib0`. The pool was computed and then thrown away.

2. Those snapshots pinned `ib0`, which only exists if `doca_ofed` renames the
   ports via udev. Its `ib_netplan_template` default pointed at `/opt/provision`
   — a path this repo never installs to — so `configure_ib_udev.sh` bailed at its
   `[ ! -f ]` guard and no rename ever happened. netplan then emitted a
   `[Match] Name=ib0` stanza matching nothing, `netplan generate` returned 0, and
   every data NIC came up with no address and no error anywhere.

These are structural assertions over the repo, matching the approach in
tests/test_nvme_namespace_fallback.py.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
TEMPLATE = REPO / "collection/roles/net_controllers/templates/netplan.yaml.j2"
OFED_DEFAULTS = REPO / "collection/roles/doca_ofed/defaults/main.yml"
PRESETS = ("default", "xinnorVM")


def test_presets_do_not_ship_a_netplan_template():
    """A preset netplan.yaml.j2 clobbers the role's dynamic template."""
    for preset in PRESETS:
        assert not (REPO / f"presets/{preset}/netplan.yaml.j2").exists(), (
            f"presets/{preset}/netplan.yaml.j2 would overwrite the role template "
            "and strand every data NIC without an IP"
        )


def test_role_template_renders_the_allocated_pool():
    """The template must consume net_allocated_ips, not hardcode a name."""
    body = TEMPLATE.read_text()
    assert "net_allocated_ips" in body
    assert "{% for iface, ip in net_allocated_ips.items() %}" in body


def test_role_template_hardcodes_no_interface_or_address():
    """No literal ibN: stanza or address outside of comments."""
    for lineno, line in enumerate(TEMPLATE.read_text().splitlines(), 1):
        code = line.split("#", 1)[0]
        assert "100.100.100" not in code, f"hardcoded address at line {lineno}"
        stripped = code.strip()
        if stripped.startswith("ib") and stripped.endswith(":"):
            raise AssertionError(f"hardcoded interface {stripped!r} at line {lineno}")


def test_ib_netplan_template_points_at_this_repo():
    """/opt/provision never exists, so the udev rename silently no-ops."""
    defaults = yaml.safe_load(OFED_DEFAULTS.read_text())
    path = defaults["ib_netplan_template"]
    assert "/opt/provision" not in path
    assert "playbook_dir" in path, "path must resolve relative to the playbook"
    assert path.endswith("collection/roles/net_controllers/templates/netplan.yaml.j2")


def test_udev_rename_reports_whether_it_changed_anything():
    """changed_when must key off the script's marker, not its exit code.

    The script exits 0 on every no-op path, so `rc == 0` reported "changed" even
    when it wrote nothing.
    """
    tasks = yaml.safe_load((REPO / "collection/roles/doca_ofed/tasks/main.yml").read_text())
    task = next(
        t for t in tasks if t.get("name") == "Generate UDEV rules for InfiniBand interfaces"
    )
    assert "rc == 0" not in str(task["changed_when"])
    assert "changed:" in str(task["changed_when"])


def test_udev_script_emits_outcome_markers():
    script = (REPO / "collection/roles/doca_ofed/files/configure_ib_udev.sh").read_text()
    assert "/opt/provision" not in script
    for marker in ("noop:", "changed:", "unchanged:"):
        assert marker in script, f"missing {marker!r} outcome marker"


def test_manual_network_config_has_no_guessed_fallback():
    """configure_manual() must not invent an ib0 config when nothing was set."""
    body = (REPO / "configure_network.sh").read_text()
    for lineno, line in enumerate(body.splitlines(), 1):
        code = line.split("#", 1)[0]
        assert "ib0:100.100.100.1/24" not in code, (
            f"guessed fallback config at configure_network.sh:{lineno}"
        )


def test_template_src_is_a_variable():
    """Manual-mode netplan must be writable without touching the tracked role
    template. Both deploy tasks read the same variable so pool mode and manual
    mode cannot diverge."""
    tasks = yaml.safe_load((REPO / "collection/roles/net_controllers/tasks/main.yml").read_text())
    srcs = [
        t["ansible.builtin.template"]["src"]
        for t in tasks
        if isinstance(t, dict) and "ansible.builtin.template" in t
        and str(t["ansible.builtin.template"].get("dest", "")).endswith("99-xinas.yaml")
    ]
    assert srcs, "no netplan deploy task found"
    assert all(s == "{{ net_netplan_template }}" for s in srcs), srcs


def test_template_variable_defaults_to_the_role_template():
    defaults = yaml.safe_load(
        (REPO / "collection/roles/net_controllers/defaults/main.yml").read_text()
    )
    assert defaults["net_netplan_template"] == "netplan.yaml.j2"
