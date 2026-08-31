"""Edit Array -> Spare Pool sends a pool NAME, and says where to make one.

The executor used to build its own pool from the chosen pool's drives, which
the daemon refused with "Drive '/dev/nvme5n2' is already a part of the 'sp01'
spare pool" (design 2026-08-29). The screen now sends spec.spare_pool.
"""

from __future__ import annotations

from xinas_menu.screens.raid import _NONE_POOL, _pools_by_name


def test_none_pool_is_module_level() -> None:
    assert _NONE_POOL == "(none)"


def test_pools_by_name_accepts_api_rows() -> None:
    rows = [{"name": "sp01", "drives": ["/dev/nvme5n2"], "active": True}]
    assert _pools_by_name(rows)["sp01"]["drives"] == ["/dev/nvme5n2"]


def test_patch_spec_maps_the_pool_name() -> None:
    from xinas_menu.screens.raid import _spare_pool_patch

    assert _spare_pool_patch("sp01") == {"spare_pool": "sp01"}
    assert _spare_pool_patch(_NONE_POOL) == {"spare_pool": None}
