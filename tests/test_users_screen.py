"""UsersScreen — List Users lock-status column.

Headless coverage for the pure rendering helpers in
``xinas_menu.screens.users``: the per-row lock-status cell and the
``_format_users`` table (which now takes an injected username→locked map
so it renders without touching ``passwd -S``).
"""

from __future__ import annotations

import pwd

import xinas_menu.screens.users as users


def _mk(name: str, uid: int) -> pwd.struct_passwd:
    return pwd.struct_passwd((name, "x", uid, uid, "", f"/home/{name}", "/bin/bash"))


# ── status cell ────────────────────────────────────────────────────────────────


def test_format_lock_status_locked_is_red_locked():
    cell = users._format_lock_status(True)
    assert "Locked" in cell
    assert "Active" not in cell
    assert users._RED in cell


def test_format_lock_status_active_is_green_active():
    cell = users._format_lock_status(False)
    assert "Active" in cell
    assert "Locked" not in cell
    assert users._GRN in cell


# ── table rendering ─────────────────────────────────────────────────────────────


def test_format_users_has_status_column_header():
    out = users._format_users([_mk("rufat", 1001)], {"rufat": True})
    assert "Status" in out


def test_format_users_marks_locked_and_active_rows():
    user_list = [_mk("rufat", 1001), _mk("xinnor", 1000)]
    locked = {"rufat": True, "xinnor": False}
    out = users._format_users(user_list, locked)

    rufat_line = next(line for line in out.splitlines() if "rufat" in line)
    xinnor_line = next(line for line in out.splitlines() if "xinnor" in line)

    assert "Locked" in rufat_line
    assert "Active" in xinnor_line


def test_format_users_defaults_unknown_user_to_active():
    # Username absent from the lock map is reported Active (fail-safe).
    out = users._format_users([_mk("ghost", 1005)], {})
    ghost_line = next(line for line in out.splitlines() if "ghost" in line)
    assert "Active" in ghost_line
