"""xiRAID array-creation rules, as published by Xinnor for xiRAID Classic 4.4.0.

Every expectation here is traceable to a vendor page — see the module docstring
of ``xinas_menu.utils.raid_rules``. The point of the module under test is that
the TUI rejects a spec xiRAID would reject, *before* the operator finishes the
wizard, so these tests assert the returned operator-facing message too.
"""

import pytest

from xinas_menu.utils import raid_rules


class TestArrayName:
    @pytest.mark.parametrize("name", ["data", "log", "a", "a" * 28, "d_1", "Data0"])
    def test_accepts_valid_names(self, name):
        assert raid_rules.validate_array_name(name) is None

    def test_rejects_name_over_28_chars(self):
        msg = raid_rules.validate_array_name("a" * 29)
        assert msg is not None
        assert "28" in msg

    def test_rejects_hyphen(self):
        # valid in most Linux object names, NOT in a xiRAID array name
        assert raid_rules.validate_array_name("my-array") is not None

    def test_rejects_empty(self):
        assert raid_rules.validate_array_name("") is not None

    @pytest.mark.parametrize("name", ["power", "uevent"])
    def test_rejects_the_prohibited_names(self, name):
        msg = raid_rules.validate_array_name(name)
        assert msg is not None
        assert "prohibits" in msg.lower()

    @pytest.mark.parametrize("name", ["POWER", "Uevent"])
    def test_case_variants_are_not_prohibited(self, name):
        """The match is exact, and deliberately so.

        The name becomes a /sys/block/xi_<name>/ directory and the attributes it
        would collide with are lowercase, so `POWER` collides with nothing. A
        case-insensitive rule would reject a name xiRAID accepts.
        """
        assert raid_rules.validate_array_name(name) is None


class TestMemberCount:
    @pytest.mark.parametrize(
        ("level", "minimum"),
        [("0", 1), ("1", 2), ("5", 4), ("6", 4), ("10", 4), ("50", 8), ("60", 8)],
    )
    def test_level_minimums_match_the_vendor_table(self, level, minimum):
        assert raid_rules.LEVEL_MIN_DRIVES[level] == minimum

    def test_rejects_under_count_naming_the_level_and_requirement(self):
        msg = raid_rules.validate_member_count("5", 3)
        assert msg is not None
        assert "RAID 5" in msg
        assert "4" in msg
        assert "3 selected" in msg

    def test_accepts_exactly_the_minimum(self):
        assert raid_rules.validate_member_count("5", 4) is None

    def test_raid10_rejects_an_odd_member_count(self):
        msg = raid_rules.validate_member_count("10", 5)
        assert msg is not None
        assert "even" in msg.lower()

    def test_raid10_accepts_an_even_member_count(self):
        assert raid_rules.validate_member_count("10", 6) is None

    def test_odd_count_is_fine_for_levels_without_the_even_rule(self):
        assert raid_rules.validate_member_count("5", 5) is None

    def test_unknown_level_is_not_rejected(self):
        # the wizard must never block on a level this module hasn't been taught
        assert raid_rules.validate_member_count("99", 1) is None


class TestGroupSize:
    def test_accepts_a_valid_group_size(self):
        assert raid_rules.validate_group_size("50", 8, 4) is None

    @pytest.mark.parametrize("group_size", [0, 1, 3, 33])
    def test_rejects_out_of_range(self, group_size):
        msg = raid_rules.validate_group_size("50", 8, group_size)
        assert msg is not None
        assert "between 4 and 32" in msg

    def test_raid70_floor_is_6_not_4(self):
        msg = raid_rules.validate_group_size("70", 12, 4)
        assert msg is not None
        assert "between 6 and 32" in msg

    def test_rejects_a_group_size_that_does_not_divide_the_members(self):
        # 5 is inside [4,32], so this exercises divisibility rather than range
        msg = raid_rules.validate_group_size("50", 12, 5)
        assert msg is not None
        assert "divide evenly" in msg

    def test_rejects_fewer_than_two_groups(self):
        msg = raid_rules.validate_group_size("50", 8, 8)
        assert msg is not None
        assert "at least 2" in msg

    def test_levels_without_groups_ignore_group_size(self):
        assert raid_rules.validate_group_size("5", 4, None) is None

    def test_group_size_is_required_for_compound_levels(self):
        msg = raid_rules.validate_group_size("50", 8, None)
        assert msg is not None
        assert "required" in msg.lower()
