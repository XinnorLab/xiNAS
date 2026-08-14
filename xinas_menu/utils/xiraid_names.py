"""xiRAID Classic name rules for arrays and spare pools.

Single source of truth for the constraints the xiRAID engine actually
enforces, so the TUI stops accepting names that `xicli` rejects after the
operator has already confirmed the operation.

Array names, per the xiRAID Classic 4.4 command reference for
``xicli raid create -n/--name``
(https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html):

* at most 28 characters;
* Latin letters, digits and underscore only — **no hyphens**;
* ``power`` and ``uevent`` are prohibited;
* names that could collide with partition identifiers should be avoided —
  ``/dev/xi_test`` partitions surface as ``/dev/xi_test1``, so an array named
  ``test1`` next to an existing ``test`` is ambiguous. The reference calls
  this something to avoid rather than something the engine refuses, so
  :func:`partition_collision` returns a warning and the caller may override.

Pool names are not documented in the reference; xiNAS applies the array
character set to them as a conservative choice, but keeps the control path's
incumbent 64-char bound. See docs/Storage/raid-management-spec.md §4 and §7.3.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

ARRAY_NAME_MAX_LEN = 28
#: Not a vendor number: the reference documents no pool rule, so xiNAS keeps
#: the control path's incumbent bound rather than inventing a shorter one. It
#: must stay >= len("xnsp_") + ARRAY_NAME_MAX_LEN, because the array executor
#: derives its spare pools as ``xnsp_<array>``.
POOL_NAME_MAX_LEN = 64

ARRAY_NAME_RE = re.compile(rf"^[A-Za-z0-9_]{{1,{ARRAY_NAME_MAX_LEN}}}$")
POOL_NAME_RE = re.compile(rf"^[A-Za-z0-9_]{{1,{POOL_NAME_MAX_LEN}}}$")

#: Prohibited by xiRAID: they collide with the sysfs attributes that live
#: under ``/sys/block/xi_<name>/``. Matched case-sensitively — sysfs attribute
#: names are lowercase, so ``Power`` collides with nothing.
RESERVED_ARRAY_NAMES = frozenset({"power", "uevent"})

_CHARSET_MSG = (
    "may contain only Latin letters, digits, and underscores — hyphens are not allowed by xiRAID"
)


def _charset_error(kind: str, name: str, pattern: re.Pattern[str], max_len: int) -> str | None:
    if not name:
        return f"{kind} name must not be empty."
    if len(name) > max_len:
        return f"{kind} name must be {max_len} characters or fewer (xiRAID limit)."
    if not pattern.match(name):
        return f"{kind} name {_CHARSET_MSG}."
    return None


def validate_array_name(name: str) -> str | None:
    """Return an operator-facing error for *name*, or ``None`` when it is usable."""
    error = _charset_error("Array", name, ARRAY_NAME_RE, ARRAY_NAME_MAX_LEN)
    if error is not None:
        return error
    if name in RESERVED_ARRAY_NAMES:
        return f"'{name}' is a name xiRAID prohibits for arrays. Choose another."
    return None


def validate_pool_name(name: str) -> str | None:
    """Return an operator-facing error for *name*, or ``None`` when it is usable.

    ``power``/``uevent`` are *not* reserved here: a spare pool is not a block
    device, so it has no ``/sys/block/xi_<name>/`` directory to collide with.
    """
    return _charset_error("Pool", name, POOL_NAME_RE, POOL_NAME_MAX_LEN)


def partition_collision(name: str, existing: Iterable[str]) -> str | None:
    """Return a warning when *name* could be read as a partition of an existing array.

    Digits appended to an array name are how partitions of ``/dev/xi_<name>``
    are spelled, so ``test`` and ``test1`` are ambiguous in either direction.
    An exact match is not a collision — that is a duplicate name, which the
    control path reports separately as ``name_taken``.
    """
    for other in existing:
        if not other or other == name:
            continue
        if name.startswith(other) and name[len(other) :].isdigit():
            return (
                f"'{name}' looks like a partition of the existing array '{other}' "
                f"(/dev/xi_{other} partitions appear as /dev/xi_{name}). "
                "Continue anyway?"
            )
        if other.startswith(name) and other[len(name) :].isdigit():
            return (
                f"Partitions of '{name}' would appear as /dev/xi_{other}, which "
                f"collides with the existing array '{other}'. Continue anyway?"
            )
    return None
