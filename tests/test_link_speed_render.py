"""Link-speed rendering for interfaces with an unknown speed.

``/sys/class/net/<iface>/speed`` reports ``-1`` when the driver cannot tell
the link speed (and some drivers report ``0``). An interface can be
operationally up in that state, so the status screens must render the speed
as unknown instead of printing the sentinel back out as ``-1M``.
"""

from xinas_menu.utils.formatting import format_link_speed, read_link_speed


def _iface(tmp_path, name: str = "enp1s0", speed: str | None = None):
    iface = tmp_path / name
    iface.mkdir()
    if speed is not None:
        (iface / "speed").write_text(f"{speed}\n")
    return iface


# ── format_link_speed ───────────────────────────────────────────────


def test_unknown_sentinel_is_not_rendered_as_a_speed():
    assert format_link_speed("-1") == "—"


def test_zero_is_unknown():
    assert format_link_speed("0") == "—"


def test_negative_values_are_unknown():
    assert format_link_speed("-2") == "—"


def test_empty_and_missing_values_are_unknown():
    assert format_link_speed("") == "—"
    assert format_link_speed(None) == "—"


def test_non_numeric_value_is_unknown():
    assert format_link_speed("unknown") == "—"


def test_gigabit_speeds_use_the_compact_g_suffix():
    assert format_link_speed("1000") == "1G"
    assert format_link_speed("10000") == "10G"
    assert format_link_speed("400000") == "400G"


def test_sub_gigabit_speeds_use_the_m_suffix():
    assert format_link_speed("100") == "100M"
    assert format_link_speed("10") == "10M"


def test_integer_input_is_accepted():
    assert format_link_speed(-1) == "—"
    assert format_link_speed(25000) == "25G"


def test_placeholder_is_configurable():
    assert format_link_speed("-1", unknown="?") == "?"
    assert format_link_speed("10000", unknown="?") == "10G"


# ── read_link_speed (sysfs path used by the status screens) ─────────


def test_read_unknown_speed_from_sysfs(tmp_path):
    assert read_link_speed(_iface(tmp_path, speed="-1")) == "—"


def test_read_known_speed_from_sysfs(tmp_path):
    assert read_link_speed(_iface(tmp_path, speed="100000")) == "100G"


def test_missing_speed_attribute_is_unknown(tmp_path):
    assert read_link_speed(_iface(tmp_path)) == "—"


def test_unreadable_speed_attribute_is_unknown(tmp_path):
    assert read_link_speed(tmp_path / "does-not-exist") == "—"


def test_read_placeholder_is_configurable(tmp_path):
    assert read_link_speed(_iface(tmp_path, speed="-1"), unknown="?") == "?"
