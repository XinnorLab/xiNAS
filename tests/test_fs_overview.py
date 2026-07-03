from xinas_menu.screens.filesystem import _format_filesystems


def test_banner_replaces_empty_state():
    out = _format_filesystems([], banner="fs backend down")
    assert "fs backend down" in out
    assert "No XFS filesystems found." not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_filesystems([])
    assert "No XFS filesystems found." in out


def test_rows_render_with_banner():
    rows = [
        {
            "mountpoint": "/mnt/data",
            "id": "data",
            "mounted": True,
            "backing_device": "/dev/xi_data",
            "options": ["rw"],
            "size_bytes": None,
        }
    ]
    out = _format_filesystems(rows, banner="degraded")
    assert "/mnt/data" in out
    assert "degraded" in out
