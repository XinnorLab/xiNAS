"""Regression guard for finding #14 (InstallationFeedback-2026-05-28).

The `xinas_nfs_helper` role (helper daemon + `xinas-nfs-helper.service`) shipped
in the tree but no preset playbook invoked it, so a preset install left
`systemctl status xinas-nfs-helper` reporting "unit not found". `autoinstall.sh`
copies `presets/<name>/playbook.yml` over `playbooks/site.yml` before running,
so the *preset* playbook is the source of truth for what gets deployed.

These tests pin that both shipping presets run `xinas_nfs_helper`, and that it
runs before the `xinas_mcp` daemon that depends on it (ADR-0010 §deployment).
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
PRESETS = ["default", "xinnorVM"]


def _role_order(preset: str) -> list[str]:
    doc = yaml.safe_load((REPO_ROOT / "presets" / preset / "playbook.yml").read_text())
    roles = doc[0]["roles"]
    return [r["role"] if isinstance(r, dict) else r for r in roles]


def test_presets_deploy_nfs_helper():
    for preset in PRESETS:
        assert "xinas_nfs_helper" in _role_order(preset), (
            f"{preset} preset does not deploy xinas_nfs_helper (finding #14)"
        )


def test_nfs_helper_runs_before_legacy_mcp():
    for preset in PRESETS:
        order = _role_order(preset)
        if "xinas_mcp" in order:
            assert order.index("xinas_nfs_helper") < order.index("xinas_mcp"), (
                f"{preset}: helper must precede the xinas_mcp daemon that uses it"
            )
