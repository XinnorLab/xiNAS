import inspect
import re
from pathlib import Path

import yaml

from xinas_menu.screens.raid import _arrays_from_api, _format_raid_overview

_REPO = Path(__file__).resolve().parent.parent


def test_banner_prepended_and_replaces_empty_state():
    out = _format_raid_overview({}, banner="xiRAID down")
    assert "xiRAID down" in out
    assert "(no RAID arrays configured)" not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_raid_overview({})
    assert "(no RAID arrays configured)" in out


# ---- tuning: observed vs unobserved (raid-management-spec §3.2) ----
#
# An unobserved knob must NEVER render as a plausible default. Showing
# "unlimited" for a memory limit nobody read told operators the array was
# unconstrained while the daemon rejected their edit with
# "RAID already has '2048' reserved MiBs".


def _api_row(spec_extra: dict | None = None, status_extra: dict | None = None) -> list[dict]:
    return [
        {
            "id": "data",
            "spec": {
                "name": "data",
                "level": "raid10",
                "member_disk_ids": ["disk-1", "disk-2"],
                "strip_size_kib": 16,
                **(spec_extra or {}),
            },
            "status": {
                "state": "optimal",
                "volume_path": "/dev/xi_data",
                **(status_extra or {}),
            },
        }
    ]


def _plain(text: str) -> str:
    return re.sub(r"\033\[[0-9;]*m", "", text)


def _row(out: str, label: str) -> str:
    for line in _plain(out).splitlines():
        if label in line:
            return line.split("|", 2)[2] if line.count("|") > 2 else line
    raise AssertionError(f"no {label!r} row in:\n{out}")


# ---- per-member device states (S3 spec §5.2, raid-management-spec §3) ----
#
# status.member_states now carries per-member observation. _arrays_from_api
# matches it to member_disk_ids by device id and fills the renderer's device
# triples, so a degraded/offline member shows in the overview breakdown
# instead of collapsing to a bare "N total". A member state the daemon never
# reported must never fabricate "online".


def _member_states(*pairs: tuple[str, list[str]]) -> list[dict]:
    return [
        {"index": i, "device": device, "states": states} for i, (device, states) in enumerate(pairs)
    ]


def test_member_states_surface_online_degraded_breakdown():
    rows = _api_row(
        status_extra={
            "member_states": _member_states(("disk-1", ["online"]), ("disk-2", ["degraded"])),
        }
    )
    dev = _row(_format_raid_overview(_arrays_from_api(rows)), "Devices")
    assert "2 total" in dev
    assert "1 online" in dev
    assert "1 degraded" in dev


def test_member_states_matched_by_device_id_not_position():
    # member_states in the OPPOSITE order from member_disk_ids: matching is by
    # device id, so disk-1 stays online and disk-2 reads offline.
    rows = _api_row(
        status_extra={
            "member_states": _member_states(("disk-2", ["offline"]), ("disk-1", ["online"])),
        }
    )
    dev = _row(_format_raid_overview(_arrays_from_api(rows)), "Devices")
    assert "1 online" in dev
    assert "1 offline" in dev


def test_arrays_from_api_fills_device_state_lists():
    rows = _api_row(
        status_extra={
            "member_states": _member_states(("disk-1", ["online"]), ("disk-2", ["degraded"])),
        }
    )
    devices = _arrays_from_api(rows)["data"]["devices"]
    assert devices == [[0, "disk-1", ["online"]], [1, "disk-2", ["degraded"]]]


def test_absent_member_states_leave_bare_total():
    # No per-member observation (fake transport / degraded backend): the
    # breakdown falls back to the total, never fabricating "online".
    dev = _row(_format_raid_overview(_arrays_from_api(_api_row())), "Devices")
    assert "2 total" in dev
    assert "online" not in dev
    assert "degraded" not in dev
    assert "offline" not in dev


def test_unobserved_tuning_renders_unknown_not_a_default():
    out = _format_raid_overview(_arrays_from_api(_api_row()), extended=True)

    assert "unknown" in _row(out, "Memory Limit")
    assert "unlimited" not in _row(out, "Memory Limit")
    assert "unknown" in _row(out, "Memory Pre-alloc")
    assert "disabled" not in _row(out, "Memory Pre-alloc").lower()
    assert "unknown" in _row(out, "Request Limit")
    assert "unknown" in _row(out, "CPU Affinity")
    assert "unknown" in _row(out, "Memory Usage")
    assert "unknown" in _row(out, "Block Size")
    assert "unknown" in _row(out, "Scheduler")
    assert "Disabled" not in _row(out, "Scheduler")
    assert "unknown" in _row(out, "Adaptive Merge")
    # Priorities have no plausible default to fall back on — they already
    # showed the placeholder, and keep it.
    assert "-" in _row(out, "Init Priority")
    assert "-" in _row(out, "SDC Priority")


def test_unobserved_merge_timings_omit_the_rows():
    out = _format_raid_overview(_arrays_from_api(_api_row()), extended=True)
    assert "Merge Read Max" not in _plain(out)


def test_observed_tuning_renders_the_real_values():
    rows = _api_row(
        spec_extra={
            "block_size": 4096,
            "tuning": {
                "init_prio": 100,
                "recon_prio": 80,
                "restripe_prio": 20,
                "sdc_prio": 30,
                "memory_limit": 2048,
                "memory_prealloc": 512,
                "request_limit": 64,
                "cpu_allowed": "0-7",
                "sched_enabled": True,
                "merge_read_enabled": False,
                "adaptive_merge": True,
                "merge_read_max": 100,
                "merge_read_wait": 10,
                "merge_write_max": 200,
                "merge_write_wait": 20,
            },
        },
        status_extra={"memory_usage_mb": 64},
    )
    out = _format_raid_overview(_arrays_from_api(rows), extended=True)

    assert "2048 MB" in _row(out, "Memory Limit")
    assert "512 MB" in _row(out, "Memory Pre-alloc")
    assert "64" in _row(out, "Request Limit")
    assert "0-7" in _row(out, "CPU Affinity")
    assert "64 MB" in _row(out, "Memory Usage")
    assert "4096 bytes" in _row(out, "Block Size")
    assert "100%" in _row(out, "Init Priority")
    assert "30%" in _row(out, "SDC Priority")
    assert "Enabled" in _row(out, "Scheduler")
    assert "Disabled" in _row(out, "Merge Read ")
    assert "100 us" in _row(out, "Merge Read Max")


def test_observed_zero_means_unlimited_not_unknown():
    # 0 IS a real observed value: xiRAID's "no limit" / "prealloc off".
    rows = _api_row(
        spec_extra={"tuning": {"memory_limit": 0, "memory_prealloc": 0, "request_limit": 0}},
        status_extra={"memory_usage_mb": 0},
    )
    out = _format_raid_overview(_arrays_from_api(rows), extended=True)

    assert "unlimited" in _row(out, "Memory Limit")
    assert "disabled" in _row(out, "Memory Pre-alloc").lower()
    assert "unlimited" in _row(out, "Request Limit")
    assert "0 MB" in _row(out, "Memory Usage")


def test_observed_empty_cpu_mask_means_all():
    rows = _api_row(spec_extra={"tuning": {"cpu_allowed": ""}})
    out = _format_raid_overview(_arrays_from_api(rows), extended=True)
    assert "all" in _row(out, "CPU Affinity")


def test_merge_max_edit_params_are_labelled_microseconds_not_kb():
    # The Extended view renders the merge windows in us; the Edit-Array knobs
    # for the same fields must not claim KB. The daemon spells them
    # merge_*_usecs (Storage/raid-management-spec §3.2).
    from xinas_menu.screens.raid import _MODIFY_PARAMS

    labels = {key: label for key, label, *_ in _MODIFY_PARAMS}
    assert "(us)" in labels["merge_read_max"]
    assert "(us)" in labels["merge_write_max"]
    assert "KB" not in labels["merge_read_max"]
    assert "KB" not in labels["merge_write_max"]


# ---- array-name validation vs the API contract (raid-management-spec §4) ----
#
# The Create wizard used to accept 64 characters while
# XiraidArray.spec.name is ^[A-Za-z0-9_-]{1,63}$ — a 64-char name passed
# every wizard step and was then rejected at dispatch. The two bounds must
# stay equal; that is what these pin.


def _api_array_name_pattern() -> str:
    doc = yaml.safe_load((_REPO / "docs/control-path/api-v1.yaml").read_text())
    schema = doc["components"]["schemas"]["XiraidArray"]["properties"]["spec"]
    return schema["properties"]["name"]["pattern"]


def test_array_name_max_matches_the_api_contract():
    from xinas_menu.screens.raid import _ARRAY_NAME_MAX

    pattern = _api_array_name_pattern()
    bound = re.search(r"\{1,(\d+)\}\$?$", pattern)
    assert bound, f"unexpected XiraidArray.spec.name pattern: {pattern!r}"
    assert int(bound.group(1)) == _ARRAY_NAME_MAX


def test_array_name_validator_agrees_with_the_api_pattern():
    from xinas_menu.screens.raid import _ARRAY_NAME_MAX, _array_name_error

    api_re = re.compile(_api_array_name_pattern())
    at_limit = "a" * _ARRAY_NAME_MAX
    over_limit = "a" * (_ARRAY_NAME_MAX + 1)

    # Accepted by the TUI exactly when the API would accept it.
    assert _array_name_error(at_limit) is None
    assert api_re.match(at_limit)
    assert _array_name_error(over_limit) is not None
    assert not api_re.match(over_limit)

    for bad in ("", "data 0", "data/0", "data.0", "dat@"):
        assert _array_name_error(bad) is not None, bad
        assert not api_re.match(bad), bad

    for good in ("data0", "xi_log", "a-b_C9"):
        assert _array_name_error(good) is None, good
        assert api_re.match(good), good


def test_array_name_error_message_states_the_real_limit():
    from xinas_menu.screens.raid import _ARRAY_NAME_MAX, _array_name_error

    msg = _array_name_error("a" * (_ARRAY_NAME_MAX + 1))
    assert msg is not None
    assert str(_ARRAY_NAME_MAX) in msg


# ---- teardown has no cross-step rollback (raid-management-spec §6.4,
#      s8-clients-spec §6) ----
#
# The spec used to promise that a failed teardown step re-added the removed
# shares and re-mounted the unmounted filesystems. It never did: a step
# failure stops the sequence and completed steps stay completed. If a
# rollback is ever added, §6.4 has to be rewritten with it.


def test_delete_array_never_restores_a_completed_step():
    from xinas_menu.screens.raid import RAIDScreen

    src = inspect.getsource(RAIDScreen._delete_array)
    for undo in ("add_export", "mount_filesystem", "remount", "rollback("):
        assert undo not in src, f"_delete_array appears to undo a completed step: {undo}"


def test_teardown_failure_says_the_sequence_stopped():
    from xinas_menu.screens.raid import RAIDScreen

    src = inspect.getsource(RAIDScreen._teardown_failed)
    assert "remaining steps were not run" in src
    assert "No cross-step rollback" in src
    # Reporting a halt is informational: OK-only, never an unanswerable Yes/No.
    assert "ok_only=True" in src


def test_raid_screen_does_not_import_the_mutating_xfs_helpers():
    # §2.4: the RAID screen's only xfs_helpers use is the read side.
    src = (_REPO / "xinas_menu/screens/raid.py").read_text()
    imports = [ln for ln in src.splitlines() if "xfs_helpers" in ln and "import" in ln]
    assert imports
    for line in imports:
        assert "unmount_filesystem" not in line
        assert "mount_filesystem" not in line


# ---- control-path, not gRPC (raid-management-spec §2.2, §6.3, §7.1) ----


def test_raid_and_pool_screens_do_not_call_the_grpc_client():
    for rel in ("xinas_menu/screens/raid.py", "xinas_menu/screens/spare_pools.py"):
        src = (_REPO / rel).read_text()
        assert "app.grpc" not in src, f"{rel} still calls the gRPC client"
        for rpc in ("raid_destroy", "raid_create", "raid_modify", "pool_create", "pool_show"):
            assert f".{rpc}(" not in src, f"{rel} still calls {rpc}"


def test_teardown_uses_the_control_path_endpoints():
    from xinas_menu.screens.raid import RAIDScreen

    src = inspect.getsource(RAIDScreen._delete_array)
    assert "/api/v1/shares/" in src
    assert "/api/v1/filesystems/" in src
    assert "/api/v1/arrays/" in src
    # The array delete is the dangerous one; the two confirm dialogs are its gate.
    assert "dangerous=True" in src
    assert "app.nfs" not in src
