"""xiRAID Classic 4.4 array / spare-pool name rules.

The engine rule (`xicli raid create -n`) is at most 28 characters of Latin
letters, digits and underscore — no hyphens — and the names ``power`` and
``uevent`` are prohibited. Names that differ from an existing array only by
trailing digits collide with partition identifiers (`/dev/xi_test1` is both a
partition of `/dev/xi_test` and a plausible array name) and are warned about,
not blocked. See docs/Storage/raid-management-spec.md §4 "Step — name".
"""

from __future__ import annotations

from pathlib import Path

import pytest

from xinas_menu.utils.xiraid_names import (
    ARRAY_NAME_MAX_LEN,
    ARRAY_NAME_RE,
    POOL_NAME_RE,
    RESERVED_ARRAY_NAMES,
    partition_collision,
    validate_array_name,
    validate_pool_name,
)


class TestArrayNameCharset:
    @pytest.mark.parametrize("name", ["data0", "DATA_0", "a", "_", "9", "xi_raid_5"])
    def test_accepts_latin_letters_digits_underscore(self, name: str) -> None:
        assert validate_array_name(name) is None

    def test_rejects_hyphen(self) -> None:
        err = validate_array_name("my-array")
        assert err is not None
        assert "hyphen" in err.lower()

    @pytest.mark.parametrize("name", ["данные", "data.0", "data 0", "data/0", "data+0"])
    def test_rejects_non_latin_and_punctuation(self, name: str) -> None:
        assert validate_array_name(name) is not None

    def test_rejects_empty(self) -> None:
        assert validate_array_name("") is not None


class TestArrayNameLength:
    def test_max_length_is_28(self) -> None:
        assert ARRAY_NAME_MAX_LEN == 28

    def test_accepts_exactly_28_characters(self) -> None:
        assert validate_array_name("a" * 28) is None

    def test_rejects_29_characters(self) -> None:
        err = validate_array_name("a" * 29)
        assert err is not None
        assert "28" in err


class TestReservedArrayNames:
    def test_reserved_set_is_power_and_uevent(self) -> None:
        assert RESERVED_ARRAY_NAMES == frozenset({"power", "uevent"})

    @pytest.mark.parametrize("name", ["power", "uevent"])
    def test_rejects_reserved_names(self, name: str) -> None:
        err = validate_array_name(name)
        assert err is not None
        assert name in err

    @pytest.mark.parametrize("name", ["powerful", "uevents", "power0"])
    def test_accepts_names_that_merely_start_with_a_reserved_word(self, name: str) -> None:
        assert validate_array_name(name) is None

    @pytest.mark.parametrize("name", ["Power", "UEVENT"])
    def test_reserved_check_is_case_sensitive(self, name: str) -> None:
        # The prohibition exists because `power` and `uevent` are sysfs
        # attribute names under /sys/block/xi_<name>/, and those are lowercase.
        assert validate_array_name(name) is None


class TestPartitionCollision:
    def test_warns_when_new_name_is_existing_name_plus_digits(self) -> None:
        warning = partition_collision("test1", ["test", "other"])
        assert warning is not None
        assert "test" in warning

    def test_warns_when_existing_name_is_new_name_plus_digits(self) -> None:
        warning = partition_collision("test", ["test1"])
        assert warning is not None
        assert "test1" in warning

    def test_no_warning_for_unrelated_names(self) -> None:
        assert partition_collision("data0", ["test", "scratch"]) is None

    def test_no_warning_when_suffix_is_not_all_digits(self) -> None:
        assert partition_collision("test_1", ["test"]) is None
        assert partition_collision("testx1", ["test"]) is None

    def test_no_warning_against_an_identical_name(self) -> None:
        # A duplicate name is a different error (the API's `name_taken`
        # blocker); it must not be reported as a partition collision.
        assert partition_collision("test", ["test"]) is None

    def test_no_warning_with_no_existing_arrays(self) -> None:
        assert partition_collision("test1", []) is None


class TestPoolName:
    @pytest.mark.parametrize("name", ["spare0", "SPARE_0", "a" * 64])
    def test_accepts_latin_letters_digits_underscore(self, name: str) -> None:
        assert validate_pool_name(name) is None

    def test_rejects_hyphen(self) -> None:
        err = validate_pool_name("spare-0")
        assert err is not None
        assert "hyphen" in err.lower()

    def test_rejects_65_characters(self) -> None:
        assert validate_pool_name("a" * 65) is not None

    def test_admits_the_derived_xnsp_pool_name_of_the_longest_array(self) -> None:
        # The array executor creates spare pools named `xnsp_<array>`. A pool
        # rule narrower than that would outlaw the pools xiNAS creates itself.
        assert validate_pool_name("xnsp_" + "a" * ARRAY_NAME_MAX_LEN) is None

    def test_rejects_empty(self) -> None:
        assert validate_pool_name("") is not None

    @pytest.mark.parametrize("name", ["power", "uevent"])
    def test_reserved_array_names_are_allowed_for_pools(self, name: str) -> None:
        # A spare pool is not a block device, so it has no /sys/block/xi_<name>/
        # directory to collide with.
        assert validate_pool_name(name) is None


class TestScreensShareTheRule:
    """The screens must call the shared validators, not re-declare the rule.

    Both screens carried their own ``^[a-zA-Z0-9_-]+$`` for a long time, which
    is how they came to disagree with the engine and with each other. A local
    character class is the regression to catch.
    """

    @pytest.mark.parametrize(
        ("path", "validator"),
        [
            ("xinas_menu/screens/raid.py", "validate_array_name"),
            ("xinas_menu/screens/spare_pools.py", "validate_pool_name"),
        ],
    )
    def test_screen_defers_to_the_shared_validator(self, path: str, validator: str) -> None:
        source = (Path(__file__).resolve().parents[1] / path).read_text(encoding="utf-8")
        assert "from xinas_menu.utils.xiraid_names import" in source
        assert validator in source
        for hyphenated in ("[a-zA-Z0-9_-]", "[A-Za-z0-9_-]"):
            assert hyphenated not in source, (
                f"{path} declares its own name character class {hyphenated} — "
                "xiRAID does not accept hyphens in array or pool names"
            )

    def test_exported_patterns_reject_hyphenated_names(self) -> None:
        # The patterns are exported for callers that want the raw rule
        # (e.g. an InputDialog validator); they must agree with the validators.
        assert ARRAY_NAME_RE.match("my-array") is None
        assert POOL_NAME_RE.match("my-pool") is None
