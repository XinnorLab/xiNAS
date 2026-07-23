"""Loopback rendering in the network overview.

The kernel reports ``operstate=unknown`` for carrier-less devices such as
``lo``; rendering that verbatim showed ``[??] lo`` / ``State: unknown``,
which reads as a fault. Loopback is up whenever it is present.
"""

from xinas_menu.screens.network import _api_iface_rows, _collect_network_info


def _lo_row(state: str = "unknown") -> dict:
    return {
        "id": "lo",
        "status": {
            "link_state": state,
            "ip4_addresses": ["127.0.0.1/8"],
            "ip6_addresses": ["::1/128"],
            "mac": "00:00:00:00:00:00",
            "mtu": 65536,
        },
    }


def test_loopback_unknown_state_renders_as_up():
    rows = _api_iface_rows([_lo_row()])
    assert rows[0]["state"] == "up"


def test_loopback_missing_state_renders_as_up():
    row = _lo_row()
    row["status"].pop("link_state")
    rows = _api_iface_rows([row])
    assert rows[0]["state"] == "up"


def test_loopback_down_state_is_preserved():
    rows = _api_iface_rows([_lo_row("down")])
    assert rows[0]["state"] == "down"


def test_non_loopback_unknown_state_is_preserved():
    row = _lo_row()
    row["id"] = "enp1s0"
    rows = _api_iface_rows([row])
    assert rows[0]["state"] == "unknown"


def test_loopback_block_has_no_unknown_marker():
    out = _collect_network_info([_lo_row()])
    lo_block = out.split("lo", 1)[1].split("MTU:", 1)[0]
    assert "[??]" not in out
    assert "unknown" not in lo_block
    assert "[UP]" in out
