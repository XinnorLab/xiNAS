"""Golden-vector + behavior tests for the xiRAID hwkey library and executable.

The expected values were produced by an independent C transcription of the
xiRAID 4.4.1 kernel functions (rdx_license_init_hwkey / rdx_license_hash_buf64
/ rdx_hash_64) and matched byte-for-byte by the Python port. See
docs/Installer/hwkey-spec.md.
"""

import os
import stat

import pytest

from xinas_menu.utils.hwkey import (
    GOLDEN_VECTORS,
    HwkeyError,
    best_effort_v2_hwkey,
    compute_hwkey,
    compute_result,
    format_hwkey,
    read_dmi_field,
)


def test_golden_vectors_v2_and_legacy():
    assert GOLDEN_VECTORS, "vectors must be present"
    for ps, uu, bs, v2, legacy in GOLDEN_VECTORS:
        assert format_hwkey(compute_hwkey(ps, uu, bs)) == v2
        assert format_hwkey(compute_hwkey(ps, uu, bs, legacy=True)) == legacy


def test_format_min_width_8_uppercase():
    # 0x1234 -> zero-padded to 8 uppercase hex digits
    assert format_hwkey(0x1234) == "00001234"
    # a full-width value is not truncated
    assert format_hwkey(0xD5E37EE32F065F31) == "D5E37EE32F065F31"


def test_v2_ignores_uuid_but_legacy_does_not():
    ps, bs = b"SN", b"BD"
    a = compute_hwkey(ps, b"aaaaaaaa-0000-0000-0000-000000000000", bs)
    b = compute_hwkey(ps, b"bbbbbbbb-1111-1111-1111-111111111111", bs)
    assert a == b  # v2 does not read the UUID
    la = compute_hwkey(ps, b"aaaaaaaa-0000-0000-0000-000000000000", bs, legacy=True)
    lb = compute_hwkey(ps, b"bbbbbbbb-1111-1111-1111-111111111111", bs, legacy=True)
    assert la != lb  # legacy does


def _fake_dmi(
    root,
    *,
    serial="SN12345",
    uuid="550e8400-e29b-41d4-a716-446655440000",
    board="BOARDXYZ",
    module_key=None,
):
    d = os.path.join(root, "sys/class/dmi/id")
    os.makedirs(d, exist_ok=True)
    if serial is not None:
        with open(os.path.join(d, "product_serial"), "w") as fh:
            fh.write(serial + "\n")
    if uuid is not None:
        with open(os.path.join(d, "product_uuid"), "w") as fh:
            fh.write(uuid + "\n")
    if board is not None:
        with open(os.path.join(d, "board_serial"), "w") as fh:
            fh.write(board + "\n")
    if module_key is not None:
        m = os.path.join(root, "sys/module/xiraid/parameters")
        os.makedirs(m, exist_ok=True)
        with open(os.path.join(m, "hwkey"), "w") as fh:
            fh.write(module_key)


def test_dmi_strips_single_newline(tmp_path):
    _fake_dmi(tmp_path)
    f = read_dmi_field("product_serial", sysfs_root=str(tmp_path))
    assert f.present and f.value == b"SN12345"


def test_dmi_absent_maps_to_null(tmp_path):
    _fake_dmi(tmp_path, board=None)  # no board_serial file
    f = read_dmi_field("board_serial", sysfs_root=str(tmp_path))
    assert not f.present and f.value == b"(null)"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root bypasses file permissions, so chmod(0) would not raise",
)
def test_dmi_permission_denied_is_fatal(tmp_path):
    _fake_dmi(tmp_path)
    p = tmp_path / "sys/class/dmi/id/product_serial"
    p.chmod(0)  # remove all perms
    try:
        with pytest.raises(HwkeyError):
            read_dmi_field("product_serial", sysfs_root=str(tmp_path))
    finally:
        p.chmod(stat.S_IRUSR | stat.S_IWUSR)  # let tmp cleanup remove it


def test_compute_result_matches_vector_and_module(tmp_path):
    _fake_dmi(tmp_path, module_key="D5E37EE32F065F31")
    r = compute_result(sysfs_root=str(tmp_path))
    assert r.v2 == "D5E37EE32F065F31"
    assert r.legacy == "B0D44633EF11F8F2"
    assert r.module_hwkey == "D5E37EE32F065F31"
    assert r.module_matches is True


def test_best_effort_returns_none_on_missing_tree(tmp_path):
    # empty root: all fields absent -> still computes the "(null)" key,
    # so best_effort returns a value (fields absent is not an error).
    r = best_effort_v2_hwkey(sysfs_root=str(tmp_path))
    assert r == "32389975897296B8"
