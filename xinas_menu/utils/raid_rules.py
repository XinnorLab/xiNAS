"""xiRAID array-creation constraints, in one place.

Every value here comes from Xinnor's documentation for **xiRAID Classic
4.4.0** — the version the ``xiraid_classic`` role installs. Re-check these
pages when that version moves:

* Naming rules, ``group_size`` range, strip sizes — command reference:
  https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html
* Per-level drive minimums and group rules — Administrator's Guide,
  "RAIDs explained":
  https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html

The TypeScript control path keeps the same rules in
``xiNAS-MCP/src/lib/xiraid/schema.ts``; the two must agree. Neither may be
*looser* than the vendor table — a floor below the engine's prevents nothing,
it just moves the failure from a wizard prompt to an opaque
``xicli raid create`` rejection. Stricter is allowed but must be commented as
a xiNAS choice.

Each validator returns ``None`` when the value is acceptable, or an
operator-facing message explaining what is wrong. Levels this module does not
know about pass everything: the wizard must never block a level just because
this table is behind.
"""

from __future__ import annotations

# --- array names ------------------------------------------------------------
# Naming lives in xiraid_names, which also owns spare-pool names and the
# partition-collision warning. Re-exported here so this module stays the single
# import for "what does xiRAID accept" without owning two copies of the rule.
from xinas_menu.utils.xiraid_names import (
    ARRAY_NAME_MAX_LEN,
    ARRAY_NAME_RE,
    RESERVED_ARRAY_NAMES,
    partition_collision,
    validate_array_name,
)

__all__ = [
    "ARRAY_NAME_MAX_LEN",
    "ARRAY_NAME_RE",
    "GROUP_SIZE_MAX",
    "GROUP_SIZE_MIN",
    "LEVELS_REQUIRING_EVEN_MEMBERS",
    "LEVELS_REQUIRING_GROUP_SIZE",
    "LEVEL_MIN_DRIVES",
    "MIN_GROUPS",
    "MODIFY_RANGES",
    "RESERVED_ARRAY_NAMES",
    "group_size_min",
    "modify_range_hint",
    "partition_collision",
    "validate_array_name",
    "validate_group_size",
    "validate_member_count",
    "validate_modify_value",
]

# --- per-level drive counts (Administrator's Guide) ------------------------
LEVEL_MIN_DRIVES: dict[str, int] = {
    "0": 1,
    "1": 2,
    "5": 4,
    "6": 4,
    "7": 6,
    # xiNAS choice: the guide's minimum is 2 (even), but a 2-drive RAID 10 is
    # a mirror with extra bookkeeping, so the TUI asks for 4.
    "10": 4,
    "50": 8,
    "60": 8,
    "70": 12,
}

# "RAID 10 requires at least 2 drives (the number of drives must be even)."
LEVELS_REQUIRING_EVEN_MEMBERS = frozenset({"10"})

# --- group size (command reference range, guide's per-level floor) ---------
LEVELS_REQUIRING_GROUP_SIZE = frozenset({"50", "60", "70"})
GROUP_SIZE_MIN = 4
GROUP_SIZE_MAX = 32
# "The group size is at least 6 drives" for RAID 70.
GROUP_SIZE_MIN_BY_LEVEL: dict[str, int] = {"70": 6}
# "at least 2 groups are required"
MIN_GROUPS = 2


def group_size_min(level: str) -> int:
    """The group-size floor for ``level``."""
    return GROUP_SIZE_MIN_BY_LEVEL.get(level, GROUP_SIZE_MIN)


def validate_member_count(level: str, count: int) -> str | None:
    """Check the member count for ``level`` against the vendor minimum."""
    minimum = LEVEL_MIN_DRIVES.get(level)
    if minimum is not None and count < minimum:
        return f"RAID {level} needs at least {minimum} drives ({count} selected)."
    if level in LEVELS_REQUIRING_EVEN_MEMBERS and count % 2 != 0:
        return f"RAID {level} needs an even number of drives ({count} selected)."
    return None


# --- `xicli raid modify` value ranges --------------------------------------
# From the command reference's *modify* table, which is NOT the create table:
# ``--init_prio`` and ``--restripe_prio`` are "from 0 to 100" on modify and
# "from 1 to 100" on create, while ``--recon_prio`` and ``--sdc_prio`` stay
# "from 1 to 100" on both. The control path encodes the same split in
# ``PRIO_MIN`` / ``PRIO_MIN_MODIFY`` (xiNAS-MCP/src/lib/xiraid/schema.ts).
#
# Each entry is ``(minimum, maximum, extra_allowed_values)``. Only the knobs
# the Edit Array screen actually offers are listed; a key that is absent is
# not validated here, so adding a parameter to the screen without adding its
# range degrades to the old behaviour rather than blocking it.
MODIFY_RANGES: dict[str, tuple[int, int, tuple[int, ...]]] = {
    # "Initialization priority in %. Possible values are from 0 to 100."
    "init_prio": (0, 100, ()),
    # "Reconstruction priority in %. Possible values: from 1 to 100."
    "recon_prio": (1, 100, ()),
    # "RAM usage limit in MiB. Possible values: 0 and integers from 1024 to
    # 1048576. The 0 value sets unlimited RAM usage."
    "memory_limit": (1024, 1048576, (0,)),
    # "Maximum wait time (in microseconds) […] integers from 1 to 100000."
    "merge_read_max": (1, 100000, ()),
    "merge_write_max": (1, 100000, ()),
}


def modify_range_hint(key: str) -> str:
    """The range for ``key`` as an operator-facing string (``"0 or 1024-1048576"``).

    The Edit Array labels are built from this, so a label can never advertise a
    range the validator does not enforce.
    """
    minimum, maximum, extra = MODIFY_RANGES[key]
    span = f"{minimum}-{maximum}"
    return f"{' or '.join(str(e) for e in extra)} or {span}" if extra else span


def validate_modify_value(key: str, value: int) -> str | None:
    """Check a ``xicli raid modify`` value against the vendor range for ``key``.

    Returns ``None`` for a key this table does not cover — the screen must not
    block a knob just because no range was recorded for it.
    """
    bounds = MODIFY_RANGES.get(key)
    if bounds is None:
        return None
    minimum, maximum, extra = bounds
    if value in extra or minimum <= value <= maximum:
        return None
    return f"Value must be {modify_range_hint(key)} (xiRAID limit)."


def validate_group_size(level: str, member_count: int, group_size: int | None) -> str | None:
    """Check ``group_size`` for a compound level against the vendor rules.

    Levels that take no group size accept anything, including ``None``.
    """
    if level not in LEVELS_REQUIRING_GROUP_SIZE:
        return None
    if group_size is None:
        return f"Group size is required for RAID {level}."
    minimum = group_size_min(level)
    if group_size < minimum or group_size > GROUP_SIZE_MAX:
        return f"Group size must be between {minimum} and {GROUP_SIZE_MAX}."
    if member_count % group_size != 0:
        return f"{member_count} drives do not divide evenly into groups of {group_size}."
    groups = member_count // group_size
    if groups < MIN_GROUPS:
        return (
            f"Group size {group_size} leaves only {groups} group; "
            f"at least {MIN_GROUPS} are required."
        )
    return None
