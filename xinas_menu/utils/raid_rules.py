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
    "RESERVED_ARRAY_NAMES",
    "group_size_min",
    "partition_collision",
    "validate_array_name",
    "validate_group_size",
    "validate_member_count",
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
