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


# ── report-line parsing (KB, header-suppressed `report -u -N`) ───────────────────
#
# Real `xfs_quota -x -c 'report -u -N' <mount>` output (block values in KB):
#   root                0          0          0     00 [--------]
#   dfff                0     102400     204800     00 [--------]
# The collector reads `report` (name first), not `quota -u -N -b`, which prints
# nothing for a user-with-a-limit on some xfsprogs/device combinations.

_REPORT = "root                0          0          0     00 [--------]\ndfff                0     102400     204800     00 [--------]\n"


def test_parse_report_user_quota_reads_soft_and_hard_for_named_user():
    assert users._parse_report_user_quota(_REPORT, "dfff") == (102400, 204800)


def test_parse_report_user_quota_zero_limits_returns_zeroes():
    assert users._parse_report_user_quota(_REPORT, "root") == (0, 0)


def test_parse_report_user_quota_absent_user_returns_zeroes():
    assert users._parse_report_user_quota(_REPORT, "ghost") == (0, 0)


def test_parse_report_user_quota_empty_output_returns_zeroes():
    assert users._parse_report_user_quota("", "dfff") == (0, 0)
    assert users._parse_report_user_quota("\n  \n", "dfff") == (0, 0)


# ── xfs_quota error sniffing (it exits 0 even on hard errors) ────────────────────


def test_xfs_quota_errored_detects_no_such_device():
    out = "xfs_quota: cannot setup path for mount /mnt/data: No such device or address"
    assert users._xfs_quota_errored(out, "") is True


def test_xfs_quota_errored_detects_foreign_filesystem():
    out = "report: foreign filesystem. Invoke xfs_quota with -f to enable."
    assert users._xfs_quota_errored(out, "") is True


def test_xfs_quota_errored_clean_report_is_not_an_error():
    assert users._xfs_quota_errored(_REPORT, "") is False
    assert users._xfs_quota_errored("", "") is False


# ── collecting a user's in-scope quotas across XFS mounts ────────────────────────


def test_collect_user_quotas_includes_only_nonzero_mounts(monkeypatch):
    monkeypatch.setattr(users, "_get_xfs_mounts", lambda: ["/mnt/data", "/mnt/scratch"])

    def fake_run_cmd(*args):
        mount = args[-1]
        if mount == "/mnt/data":
            return True, _REPORT, ""
        return True, "root 0 0 0 00 [------]\ndfff 0 0 0 00 [------]", ""

    monkeypatch.setattr(users, "_run_cmd", fake_run_cmd)

    saved, read_ok = users._collect_user_quotas("dfff")
    assert saved == [("/mnt/data", 102400, 204800)]
    assert read_ok is True


def test_collect_user_quotas_marks_read_failure_on_xfs_quota_error(monkeypatch):
    # xfs_quota exits 0 but prints an error; the mount must be a read failure,
    # not silently treated as "no quota".
    monkeypatch.setattr(users, "_get_xfs_mounts", lambda: ["/mnt/data"])
    monkeypatch.setattr(
        users,
        "_run_cmd",
        lambda *a: (True, "xfs_quota: cannot setup path for mount /mnt/data: No such device", ""),
    )
    saved, read_ok = users._collect_user_quotas("dfff")
    assert saved == []
    assert read_ok is False


def test_collect_user_quotas_marks_read_failure_on_nonzero_exit(monkeypatch):
    monkeypatch.setattr(users, "_get_xfs_mounts", lambda: ["/mnt/data"])
    monkeypatch.setattr(users, "_run_cmd", lambda *a: (False, "", "no such fs"))
    saved, read_ok = users._collect_user_quotas("dfff")
    assert saved == []
    assert read_ok is False


# ── delete confirmation note (clear count / no-op / read-failure warning) ─────────


def test_delete_confirm_note_names_clear_count_when_quotas_read():
    note = users._delete_confirm_note([("/mnt/data", 102400, 204800)], True, 1001)
    assert "1 disk quota" in note
    assert "cleared first" in note


def test_delete_confirm_note_is_empty_when_no_quotas():
    assert users._delete_confirm_note([], True, 1001) == ""


def test_delete_confirm_note_warns_when_read_failed():
    note = users._delete_confirm_note([], False, 1001)
    assert "1001" in note  # names the UID that a reused account would inherit
    assert "orphan" in note.lower()


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


# ── create user requires a password (no passwordless / Locked account) ──────────


def test_create_user_sync_rejects_empty_password(monkeypatch):
    # useradd without a password writes `!` to /etc/shadow, so passwd -S reports
    # `L` and the account shows as Locked. _create_user_sync must refuse rather
    # than create that account — and must not shell out at all.
    def _boom(*_a, **_k):
        raise AssertionError("subprocess.run must not run for an empty password")

    monkeypatch.setattr(users.subprocess, "run", _boom)

    ok, err = users._create_user_sync("bob", "/home/bob", "")

    assert ok is False
    assert "password" in err.lower()


def test_create_user_sync_rolls_back_when_chpasswd_fails(monkeypatch):
    # useradd creates a locked (`!`) account; if the follow-up chpasswd fails,
    # that Locked account must be removed rather than left behind.
    calls: list[list[str]] = []

    class _R:
        def __init__(self, rc: int, stderr: str = "") -> None:
            self.returncode = rc
            self.stderr = stderr

    def _fake_run(argv, *_a, **_k):
        calls.append(argv)
        if argv[0] == "useradd":
            return _R(0)
        if argv[0] == "chpasswd":
            return _R(1, "chpasswd: bad password")
        return _R(0)

    monkeypatch.setattr(users.subprocess, "run", _fake_run)

    ok, err = users._create_user_sync("bob", "/home/bob", "secret")

    assert ok is False
    assert "chpasswd" in err
    assert any(c[0] == "userdel" and "bob" in c for c in calls), (
        "the half-created locked account must be rolled back with userdel"
    )
