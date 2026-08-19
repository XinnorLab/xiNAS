"""Preset playbooks document intent; `playbooks/site.yml` is what runs.

Finding #14 (InstallationFeedback-2026-05-28): the `xinas_nfs_helper` role
shipped without any preset playbook invoking it. At that time `autoinstall.sh`
copied `presets/<name>/playbook.yml` over `playbooks/site.yml`, so the preset
playbook *was* the source of truth. That copy is gone — presets now contribute
variables only — so these tests pin two things: the historical helper ordering,
and that no preset's role list drifts away from the playbook that actually runs.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
PRESETS = ["default", "xinnorVM"]
SITE = REPO_ROOT / "playbooks/site.yml"


def _roles(doc_path: Path) -> list[str]:
    doc = yaml.safe_load(doc_path.read_text())
    return [r["role"] if isinstance(r, dict) else r for r in doc[0]["roles"]]


def _preset_playbook(preset: str) -> Path:
    return REPO_ROOT / "presets" / preset / "playbook.yml"


def test_presets_deploy_nfs_helper():
    for preset in PRESETS:
        assert "xinas_nfs_helper" in _roles(_preset_playbook(preset)), (
            f"{preset} preset does not deploy xinas_nfs_helper (finding #14)"
        )


def test_nfs_helper_runs_before_legacy_mcp():
    for preset in PRESETS:
        order = _roles(_preset_playbook(preset))
        if "xinas_mcp" in order:
            assert order.index("xinas_nfs_helper") < order.index("xinas_mcp"), (
                f"{preset}: helper must precede the xinas_mcp daemon that uses it"
            )


def test_preset_role_lists_match_site_yml():
    """Presets contribute variables, not play structure.

    The installer no longer copies a preset playbook over `playbooks/site.yml`,
    so `site.yml` is what runs. A preset whose role list drifts from it would
    silently document a deployment that never happens.
    """
    expected = _roles(SITE)
    for preset in PRESETS:
        assert _roles(_preset_playbook(preset)) == expected, (
            f"{preset}: role list differs from playbooks/site.yml"
        )


def test_site_yml_keeps_the_xiraid_skip_guard():
    """`-e xiraid_skip_install=true` was inert while a preset playbook — which
    carries no guard — was copied over site.yml. Both existing-RAID paths
    (autoinstall --preset existing-raid, startup_menu.sh) depend on it."""
    doc = yaml.safe_load(SITE.read_text())
    entry = next(
        r for r in doc[0]["roles"] if isinstance(r, dict) and r["role"] == "xiraid_classic"
    )
    assert "xiraid_skip_install" in str(entry.get("when", "")), (
        "playbooks/site.yml no longer guards xiraid_classic with xiraid_skip_install"
    )
