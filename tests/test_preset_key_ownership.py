"""Every key a preset sets must be defined by some role's defaults.

Not "by the role the preset file is named after": `presets/default/raid_fs.yml`
legitimately sets five `nvme_*` keys that `nvme_namespace` defines and `raid_fs`
does not. Ansible merges all role defaults into one host scope, and after the
overlay change every preset var file lands in one merged document, so the
filename does not partition the keyspace. What the test does catch is a key no
role defines at all — a typo, or a rename that left the preset behind.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
PRESET_VAR_FILES = ("network.yml", "raid_fs.yml", "nvme_namespace.yml", "nfs_exports.yml")


def _all_role_default_keys() -> set[str]:
    keys: set[str] = set()
    for path in (REPO / "collection/roles").glob("*/defaults/main.yml"):
        doc = yaml.safe_load(path.read_text()) or {}
        keys |= set(doc)
    return keys


def test_every_preset_key_is_defined_by_some_role():
    known = _all_role_default_keys()
    for preset_dir in sorted((REPO / "presets").iterdir()):
        if not preset_dir.is_dir():
            continue
        for name in PRESET_VAR_FILES:
            path = preset_dir / name
            if not path.exists():
                continue
            doc = yaml.safe_load(path.read_text()) or {}
            unknown = sorted(set(doc) - known)
            assert not unknown, f"{path.relative_to(REPO)} sets keys no role defines: {unknown}"


def test_no_preset_ships_a_netplan_template():
    """Duplicated from test_net_controllers_template.py on purpose: apply_preset
    now rejects such a preset at runtime, and this states the same rule where a
    preset author will look for it."""
    for preset_dir in sorted((REPO / "presets").iterdir()):
        if preset_dir.is_dir():
            assert not (preset_dir / "netplan.yaml.j2").exists(), preset_dir.name
