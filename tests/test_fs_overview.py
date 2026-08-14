import inspect
from pathlib import Path

from xinas_menu.screens.filesystem import _format_filesystems

_REPO = Path(__file__).resolve().parent.parent
_FS_SCREEN = _REPO / "xinas_menu/screens/filesystem.py"


def test_banner_replaces_empty_state():
    out = _format_filesystems([], banner="fs backend down")
    assert "fs backend down" in out
    assert "No XFS filesystems found." not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_filesystems([])
    assert "No XFS filesystems found." in out


def test_rows_render_with_banner():
    rows = [
        {
            "mountpoint": "/mnt/data",
            "id": "data",
            "mounted": True,
            "backing_device": "/dev/xi_data",
            "options": ["rw"],
            "size_bytes": None,
        }
    ]
    out = _format_filesystems(rows, banner="degraded")
    assert "/mnt/data" in out
    assert "degraded" in out


# ---- Delete Filesystem teardown (fs-shares-management-spec §3.4,
#      s8-clients-spec §6) ----
#
# The spec used to promise that a failed teardown step re-added the removed
# shares via nfs.add_export and reported "Rolled back N share(s)". It never
# did: a step failure stops the sequence and completed steps stay completed.
# If a rollback is ever added, §3.4 has to be rewritten with it.


def test_delete_filesystem_never_restores_a_completed_step():
    from xinas_menu.screens.filesystem import FilesystemScreen

    src = inspect.getsource(FilesystemScreen._delete_filesystem)
    for undo in ("add_export", "mount_filesystem", "remount", "rollback(", "Rolled back"):
        assert undo not in src, f"_delete_filesystem appears to undo a completed step: {undo}"


def test_fs_teardown_failure_says_the_sequence_stopped():
    from xinas_menu.screens.filesystem import FilesystemScreen

    src = inspect.getsource(FilesystemScreen._teardown_failed)
    assert "remaining steps were not run" in src
    assert "No cross-step rollback" in src
    assert "Delete Filesystem — Stopped" in src
    # Reporting a halt is informational: OK-only, never an unanswerable Yes/No.
    assert "ok_only=True" in src


def test_fs_teardown_uses_the_control_path_endpoints():
    from xinas_menu.screens.filesystem import FilesystemScreen

    src = inspect.getsource(FilesystemScreen._delete_filesystem)
    assert "/api/v1/shares/" in src
    assert "/api/v1/filesystems/" in src
    assert '"mounted": False' in src
    assert "app.nfs" not in src


def test_filesystem_screen_reads_the_control_path_not_findmnt_or_grpc():
    # §3.1: the whole screen rides the control path; the direct findmnt /
    # mkfs / mount-unit helpers and the gRPC client left it.
    src = _FS_SCREEN.read_text()
    assert "app.grpc" not in src
    assert "app.nfs" not in src
    # No findmnt string literal to hand to a subprocess (the module
    # docstring mentions it only to say it left).
    assert '"findmnt"' not in src and "'findmnt'" not in src
    for helper in ("unmount_filesystem", "mount_filesystem", "update_mount_unit_quota"):
        assert helper not in src, f"filesystem.py still calls {helper}"


# ---- Create wizard: geometry is server-derived (§3.3) ----
#
# The spec used to document a client-side calculate_stripe_width /
# build_mount_options derivation. The screen sends a structured spec and
# omits su_kb/sw so the api derives them; the flat option string in the
# summary is display-only.


def test_create_wizard_derives_no_geometry_client_side():
    from xinas_menu.screens.filesystem import FilesystemScreen

    src = inspect.getsource(FilesystemScreen._create_filesystem_wizard)
    for helper in ("calculate_stripe_width", "calculate_parity_disks", "build_mount_options"):
        assert helper not in src, f"create wizard computes geometry itself: {helper}"
    # su_kb is displayed in the summary but must not reach the spec.
    assert '"su_kb"' not in src and '"sw"' not in src


def test_in_use_volumes_cover_log_devices_not_just_backing_devices():
    # §3.3 pre-check: an array serving as someone's logdev= is as
    # unavailable as one serving as their data device.
    from xinas_menu.screens.filesystem import _volumes_in_use

    used = _volumes_in_use(
        [
            {
                "backing_device": "/dev/xi_data",
                "options": ["rw", "logdev=/dev/xi_log", "noatime"],
            }
        ]
    )
    assert used == {"/dev/xi_data", "/dev/xi_log"}


def test_create_spec_carries_logdev_and_quota_as_structured_fields():
    from xinas_menu.screens.filesystem import _DEFAULT_MOUNT_OPTIONS, FilesystemScreen

    # logdev= and uquota ride log_device / quota_mode, not mount_options.
    assert not any("logdev" in o or "quota" in o for o in _DEFAULT_MOUNT_OPTIONS)

    src = inspect.getsource(FilesystemScreen._create_filesystem_wizard)
    for field in ('"log_device"', '"quota_mode"', '"mount_options"', '"sector_size"'):
        assert field in src, f"create spec is missing {field}"
    # The force retry is the only place dangerous consent is submitted.
    assert "dangerous=True" in src


# ---- Manage Quotas: one mode per filesystem (§3.5) ----
#
# The API holds a single quota_mode enum, so "Enable Both (user + project)"
# is gone and enabling one mode replaces the other.


def test_quota_toggle_offers_no_enable_both_and_patches_one_intent():
    from xinas_menu.screens.filesystem import FilesystemScreen

    src = inspect.getsource(FilesystemScreen._manage_quotas)
    assert "Enable Both" not in src
    assert '"quota_mode"' in src
    assert "replaces" in src, "the replace-semantics warning is part of the contract"
    # One intent key per PATCH — never bundled with mounted/grow.
    assert '"mounted"' not in src and '"grow"' not in src


def test_quota_flags_parse_both_option_spellings():
    from xinas_menu.screens.filesystem import _quota_flags

    assert _quota_flags(["uquota"]) == {"user": True, "project": False, "group": False}
    assert _quota_flags(["usrquota"])["user"] is True
    assert _quota_flags(["prjquota"])["project"] is True
    assert _quota_flags(["grpquota"])["group"] is True
    assert _quota_flags(["rw", "noatime"]) == {"user": False, "project": False, "group": False}
