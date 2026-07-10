"""Pure prefill helpers for the NFS share wizard."""

from __future__ import annotations

from xinas_menu.screens.nfs import _host_prefill, _path_prefill, _xiraid_mount_points

_HOST_CHOICES = [
    "Everyone (any host on the network)",
    "Specific network (e.g., 192.168.1.0/24)",
    "Single host (by IP address)",
]


def test_host_prefill_everyone():
    sel, hint = _host_prefill("*")
    assert sel == _HOST_CHOICES[0]
    assert hint == "Everyone"


def test_host_prefill_network():
    sel, hint = _host_prefill("192.168.1.0/24")
    assert sel == _HOST_CHOICES[1]
    assert hint == "Network 192.168.1.0/24"


def test_host_prefill_single():
    sel, hint = _host_prefill("10.0.0.5")
    assert sel == _HOST_CHOICES[2]
    assert hint == "Host 10.0.0.5"


def test_path_prefill_matches_mount():
    sel, default = _path_prefill("/mnt/data", ["/mnt/data", "/mnt/log"])
    assert sel == "/mnt/data"
    assert default == "/mnt/data/"  # custom default is unused when a mount matches


def test_path_prefill_custom_when_no_match():
    sel, default = _path_prefill("/mnt/data/share1", ["/mnt/data"])
    assert sel == "Custom path…"
    assert default == "/mnt/data/share1"


def test_path_prefill_empty():
    sel, default = _path_prefill("", ["/mnt/data"])
    assert sel is None
    assert default == "/mnt/data/"


def test_path_prefill_custom_default_uses_first_mount():
    sel, default = _path_prefill("", ["/srv/pool1", "/mnt/log"])
    assert sel is None
    assert default == "/srv/pool1/"


def test_xiraid_mount_points_keeps_only_xi_sources():
    out = "/mnt/data      /dev/xi_data\n/boot          /dev/sda1\n/              /dev/sda2\n"
    assert _xiraid_mount_points(out) == ["/mnt/data"]


def test_xiraid_mount_points_multiple():
    out = "/mnt/data   /dev/xi_data\n/mnt/logs   /dev/xi_logs\n"
    assert _xiraid_mount_points(out) == ["/mnt/data", "/mnt/logs"]


def test_xiraid_mount_points_none():
    out = "/           /dev/sda2\n/boot       /dev/sda1\n"
    assert _xiraid_mount_points(out) == []


def test_xiraid_mount_points_empty_string():
    assert _xiraid_mount_points("") == []
