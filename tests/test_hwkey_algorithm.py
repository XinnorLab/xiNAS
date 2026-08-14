"""Golden-vector + behavior tests for the xiRAID hwkey library and executable.

The expected values were produced by an independent C transcription of the
xiRAID 4.4.1 kernel functions (rdx_license_init_hwkey / rdx_license_hash_buf64
/ rdx_hash_64) and matched byte-for-byte by the Python port. See
docs/Installer/hwkey-spec.md.
"""

from xinas_menu.utils.hwkey import GOLDEN_VECTORS, compute_hwkey, format_hwkey


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
