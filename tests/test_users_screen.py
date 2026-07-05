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


# ── quota-line parsing (KB, header-suppressed `quota -u -N -b`) ──────────────────


def test_parse_quota_kb_reads_soft_and_hard_from_data_line():
    # `xfs_quota -x -c 'quota -u -N -b rufat' /mnt/data` → device used soft hard ...
    line = "/dev/xi_data      4    10485760    20971520  00 [--------] /mnt/data"
    assert users._parse_quota_kb(line) == (10485760, 20971520)


def test_parse_quota_kb_zero_limits_returns_zeroes():
    line = "/dev/xi_data      4          0          0  00 [--------] /mnt/data"
    assert users._parse_quota_kb(line) == (0, 0)


def test_parse_quota_kb_empty_output_returns_zeroes():
    assert users._parse_quota_kb("") == (0, 0)
    assert users._parse_quota_kb("\n  \n") == (0, 0)


# ── collecting a user's in-scope quotas across XFS mounts ────────────────────────


def test_collect_user_quotas_includes_only_nonzero_mounts(monkeypatch):
    monkeypatch.setattr(users, "_get_xfs_mounts", lambda: ["/mnt/data", "/mnt/scratch"])

    def fake_run_cmd(*args):
        mount = args[-1]
        if mount == "/mnt/data":
            return True, "/dev/xi_data 4 10485760 20971520 00 [------] /mnt/data", ""
        return True, "/dev/scratch 0 0 0 00 [------] /mnt/scratch", ""

    monkeypatch.setattr(users, "_run_cmd", fake_run_cmd)

    saved = users._collect_user_quotas("rufat")
    assert saved == [("/mnt/data", 10485760, 20971520)]


def test_collect_user_quotas_skips_failed_mount_reads(monkeypatch):
    monkeypatch.setattr(users, "_get_xfs_mounts", lambda: ["/mnt/data"])
    monkeypatch.setattr(users, "_run_cmd", lambda *a: (False, "", "no such fs"))
    assert users._collect_user_quotas("rufat") == []


# ── delete + quota-cleanup + rollback orchestration (pure, injectable) ───────────


def _recording_setter(fail_on=None):
    """set_quota_fn stub recording (mount, soft, hard) calls."""
    calls: list[tuple[str, int, int]] = []

    def setter(mount, soft, hard):
        calls.append((mount, soft, hard))
        if fail_on is not None and (mount, soft, hard) == fail_on:
            return False, "helper error"
        return True, ""

    return setter, calls


def test_delete_happy_path_clears_then_deletes():
    saved = [("/mnt/data", 10485760, 20971520)]
    setter, calls = _recording_setter()
    userdel_calls = []

    def userdel():
        userdel_calls.append(True)
        return True, ""

    ok, msg, ops, restore_ok = users._delete_user_with_quota_cleanup(
        "rufat", saved, setter, userdel
    )
    assert ok is True
    assert ops == 1
    # quota was zeroed before delete
    assert calls == [("/mnt/data", 0, 0)]
    assert userdel_calls == [True]


def test_delete_no_quotas_deletes_directly():
    setter, calls = _recording_setter()
    ok, msg, ops, restore_ok = users._delete_user_with_quota_cleanup(
        "rufat", [], setter, lambda: (True, "")
    )
    assert ok is True
    assert ops == 0
    assert calls == []  # set_quota never touched


def test_delete_aborts_and_restores_when_clear_fails_midway():
    saved = [
        ("/mnt/data", 10485760, 20971520),
        ("/mnt/scratch", 4096, 8192),
    ]
    # fail clearing the second mount
    setter, calls = _recording_setter(fail_on=("/mnt/scratch", 0, 0))
    userdel_calls = []

    ok, msg, ops, restore_ok = users._delete_user_with_quota_cleanup(
        "rufat", saved, setter, lambda: userdel_calls.append(True) or (True, "")
    )
    assert ok is False
    assert userdel_calls == []  # user must NOT be deleted
    assert ops == 1  # one quota was cleared then restored
    assert restore_ok is True
    # first cleared to 0/0, then restored to original values
    assert ("/mnt/data", 0, 0) in calls
    assert ("/mnt/data", 10485760, 20971520) in calls
    assert "/mnt/scratch" in msg


def test_delete_restores_quotas_when_userdel_fails():
    saved = [("/mnt/data", 10485760, 20971520)]
    setter, calls = _recording_setter()

    ok, msg, ops, restore_ok = users._delete_user_with_quota_cleanup(
        "rufat", saved, setter, lambda: (False, "user busy")
    )
    assert ok is False
    assert ops == 1
    assert restore_ok is True
    # cleared, then restored to original
    assert calls == [("/mnt/data", 0, 0), ("/mnt/data", 10485760, 20971520)]
    assert "user busy" in msg


def test_delete_flags_incomplete_restore():
    saved = [("/mnt/data", 10485760, 20971520)]
    # clearing works, restore (the 2nd write of original values) fails
    setter, calls = _recording_setter(fail_on=("/mnt/data", 10485760, 20971520))

    ok, msg, ops, restore_ok = users._delete_user_with_quota_cleanup(
        "rufat", saved, setter, lambda: (False, "user busy")
    )
    assert ok is False
    assert restore_ok is False  # surfaced as a warning by the caller
