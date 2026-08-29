"""The Create Array wizard always shows the spare step.

Silently skipping it when no pool existed left the operator with an array and
no idea why it had no spares (design 2026-08-29 §6).
"""

from __future__ import annotations

from xinas_menu.screens.raid import _NONE_POOL, _spare_prompt, _spare_spec_fragment


def test_prompt_points_at_spare_pools_when_none_exist() -> None:
    assert "Spare Pools" in _spare_prompt({})


def test_prompt_is_plain_when_pools_exist() -> None:
    assert "Spare Pools" not in _spare_prompt({"sp01": {}})


def test_spec_fragment_carries_the_pool_name() -> None:
    assert _spare_spec_fragment("sp01") == {"spare_pool": "sp01"}
    assert _spare_spec_fragment(_NONE_POOL) == {}
