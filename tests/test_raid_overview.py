from xinas_menu.screens.raid import _format_raid_overview


def test_banner_prepended_and_replaces_empty_state():
    out = _format_raid_overview({}, banner="xiRAID down")
    assert "xiRAID down" in out
    assert "(no RAID arrays configured)" not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_raid_overview({})
    assert "(no RAID arrays configured)" in out
