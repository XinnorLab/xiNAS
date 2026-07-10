from __future__ import annotations

from xinas_menu.utils.xfs_helpers import is_path_under


def test_exact_match():
    assert is_path_under("/mnt/data", "/mnt/data") is True


def test_subfolder():
    assert is_path_under("/mnt/data/share1", "/mnt/data") is True


def test_root_with_trailing_slash():
    assert is_path_under("/mnt/data/share1", "/mnt/data/") is True


def test_sibling_is_not_under():
    assert is_path_under("/mnt/data2", "/mnt/data") is False


def test_prefix_but_not_segment_boundary():
    # "/mnt/database" must NOT count as under "/mnt/data".
    assert is_path_under("/mnt/database", "/mnt/data") is False


def test_unrelated_path():
    assert is_path_under("/srv/foo", "/mnt/data") is False
