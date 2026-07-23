import re

from xinas_menu.screens.raid import _arrays_from_api, _format_raid_overview


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
