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


def _api_row(
    spec_extra: dict | None = None,
    status_extra: dict | None = None,
    level: str = "raid5",
) -> list[dict]:
    # A PARITY level by default, so the unobserved-tuning tests below exercise
    # the `unknown` path for every knob — including the eight that exist only
    # on parity arrays. On a non-parity level those narrow to `NA` instead
    # (§3.3), which is what the tests further down pin with level="raid10".
    return [
        {
            "id": "data",
            "spec": {
                "name": "data",
                "level": level,
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


# ---- parity-only knobs on a non-parity level (raid-management-spec §3.3) ----
#
# `unknown` and "does not exist" are different facts. A RAID 10 array showed
# Merge Read / Merge Write / Adaptive Merge as `unknown` and SDC Priority as
# `-`, sending the operator looking for four values a mirror cannot have.


def test_parity_only_knobs_render_na_on_a_mirror():
    out = _format_raid_overview(_arrays_from_api(_api_row(level="raid10")), extended=True)

    for label in ("Merge Read", "Merge Write", "Adaptive Merge"):
        assert "NA" in _row(out, label), label
        assert "unknown" not in _row(out, label), label
    # SDC narrows from the Priorities block's dash, not from `unknown`.
    assert "NA" in _row(out, "SDC Priority")


def test_na_does_not_leak_to_knobs_every_level_has():
    # Only the eight parity-only knobs narrow. Everything else keeps `unknown`
    # — NA there would claim a value cannot exist when it merely was not read.
    out = _format_raid_overview(_arrays_from_api(_api_row(level="raid10")), extended=True)

    for label in ("Memory Limit", "Memory Pre-alloc", "Request Limit", "CPU Affinity", "Scheduler"):
        assert "unknown" in _row(out, label), label
        assert "NA" not in _row(out, label), label
    # ...and the priorities that exist at every level keep their dash.
    for label in ("Init Priority", "Recon Priority", "Restripe Priority"):
        assert "-" in _row(out, label), label
        assert "NA" not in _row(out, label), label


def test_parity_level_keeps_unknown_for_the_same_knobs():
    out = _format_raid_overview(_arrays_from_api(_api_row(level="raid5")), extended=True)

    for label in ("Merge Read", "Merge Write", "Adaptive Merge"):
        assert "unknown" in _row(out, label), label
        assert "NA" not in _row(out, label), label
    assert "-" in _row(out, "SDC Priority")


def test_unrecognised_level_keeps_unknown_rather_than_claiming_na():
    # The non-parity set is a whitelist. A level this code has never seen
    # must not become a claim that a knob cannot exist for it.
    for level in ("raidn+m", "raid7", "raid60", "", "raid-who-knows"):
        out = _format_raid_overview(_arrays_from_api(_api_row(level=level)), extended=True)
        assert "unknown" in _row(out, "Adaptive Merge"), level
        assert "NA" not in _row(out, "Adaptive Merge"), level


def test_na_never_overrides_an_observed_value():
    # If the daemon ever does report one of these on a mirror, show the real
    # value. NA only ever narrows a PLACEHOLDER.
    rows = _api_row(
        level="raid10",
        spec_extra={"tuning": {"adaptive_merge": True, "sdc_prio": 40}},
    )
    out = _format_raid_overview(_arrays_from_api(rows), extended=True)
    assert "Enabled" in _row(out, "Adaptive Merge")
    assert "NA" not in _row(out, "Adaptive Merge")
    assert "40%" in _row(out, "SDC Priority")


def test_merge_timing_rows_stay_omitted_on_a_non_parity_level():
    # They are unobserved, so §3.2's omission rule already covers them; four
    # more NA rows under a merge feature already marked NA is noise.
    out = _format_raid_overview(_arrays_from_api(_api_row(level="raid10")), extended=True)
    assert "Merge Read Max" not in _plain(out)


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
