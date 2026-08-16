"""`raid_status` must not report normal xiRAID activity as a failure.

The check used to FAIL every state that was not ``online``/``initialized``.
xiRAID's own state vocabulary (AG 4.4 "Showing RAID State",
https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html)
contains several states an entirely healthy array passes through — an array
initializes for hours after it is created, an SDC scan runs on a schedule, a
restripe is an operator-requested expansion — so a freshly installed node
reported ``FAIL: data: initing`` with the impact line "Degraded RAID reduces
redundancy", which is neither true nor actionable.
"""

from __future__ import annotations

import json

import pytest

from xinas_menu.health import engine


def _run(monkeypatch, payload):
    """Run check_storage's raid_status branch over a canned raid_show payload."""

    def fake_run_cmd(cmd, *a, **kw):
        if "command -v xicli" in cmd:
            return "/usr/bin/xicli"
        if "xicli raid show" in cmd:
            return json.dumps(payload)
        return None

    monkeypatch.setattr(engine, "run_cmd", fake_run_cmd)
    results = engine.check_storage({}, ["raid_status"])
    assert len(results) == 1
    return results[0]


def _array(*states):
    return {"data": {"name": "data", "level": "5", "state": list(states)}}


@pytest.mark.parametrize(
    "states",
    [
        ("online",),
        ("online", "initialized"),
        # A finished restripe awaiting a resize, and a completed SDC scan, are
        # states of a fully redundant array.
        ("online", "initialized", "need_resize"),
    ],
)
def test_healthy_states_pass(monkeypatch, states):
    assert _run(monkeypatch, _array(*states)).status == "PASS"


@pytest.mark.parametrize(
    "states",
    [
        # "initing – the RAID is initializing."  The expected state right after
        # every install; redundancy is being built, not lost.
        ("online", "initing"),
        # "sdc_scanning – an SDC scan is in progress."
        ("online", "initialized", "sdc_scanning"),
        # "restriping – RAID is restriping."  An operator-requested expansion.
        ("online", "restriping"),
        # "need_restripe – restriping was stopped and not finished."
        ("online", "initialized", "need_restripe"),
    ],
)
def test_in_progress_states_warn_but_do_not_fail(monkeypatch, states):
    result = _run(monkeypatch, _array(*states))
    assert result.status == "WARN", f"{states} should not read as a failure"
    # The array is still redundant, so the redundancy-loss impact line must not
    # be attached to it.
    assert "reduces redundancy" not in result.impact


@pytest.mark.parametrize(
    "states",
    [
        ("degraded",),
        ("online", "degraded"),
        ("reconstructing",),
        ("online", "need_recon"),
        ("online", "need_init"),
        ("offline",),
        ("none",),
        ("unrecovered",),
        ("online", "inconsistent"),
        ("online", "read_only"),
    ],
)
def test_redundancy_loss_states_fail(monkeypatch, states):
    result = _run(monkeypatch, _array(*states))
    assert result.status == "FAIL"
    assert "data" in result.actual


def test_worst_state_in_the_list_decides(monkeypatch):
    """`state` is a list; one bad word outranks any number of good ones."""
    result = _run(monkeypatch, _array("online", "initialized", "degraded"))
    assert result.status == "FAIL"


def test_unknown_state_word_is_not_silently_healthy(monkeypatch):
    """A word this table has never seen must be surfaced, not passed."""
    result = _run(monkeypatch, _array("online", "some_future_state"))
    assert result.status in ("WARN", "FAIL")
    assert "some_future_state" in result.actual


# ---- raid_devices: the per-member sibling check ----------------------------
#
# xiRAID's `devices` entries arrive in three shapes (s3-xiraid-array-spec §5.2).
# The check read `dev[2][0]` unconditionally, which only parses the tuple: a
# bare-string entry yielded a single CHARACTER as the "state" (so every drive
# read as failed), and an object entry raised straight out of the check.


def _run_devices(monkeypatch, payload):
    def fake_run_cmd(cmd, *a, **kw):
        if "command -v xicli" in cmd:
            return "/usr/bin/xicli"
        if "xicli raid show" in cmd:
            return json.dumps(payload)
        return None

    monkeypatch.setattr(engine, "run_cmd", fake_run_cmd)
    return engine.check_storage({}, ["raid_devices"])


ONLINE_SHAPES = [
    # [index, path, [states]] — the real xiRAID tuple
    [[0, "/dev/nvme0n1", ["online"]], [1, "/dev/nvme1n1", ["online"]]],
    # bare paths — no per-member state reported at all
    ["/dev/nvme0n1", "/dev/nvme1n1"],
    # per-device objects — the gRPC reference shape
    [
        {"path": "/dev/nvme0n1", "state": ["online"]},
        {"device": "/dev/nvme1n1", "states": "online"},
    ],
]


@pytest.mark.parametrize("devices", ONLINE_SHAPES, ids=["tuple", "bare", "object"])
def test_raid_devices_reads_every_payload_shape(monkeypatch, devices):
    (result,) = _run_devices(monkeypatch, {"data": {"name": "data", "devices": devices}})
    assert result.status == "PASS", result.actual
    assert "2" in result.actual


def test_raid_devices_still_flags_a_failed_member(monkeypatch):
    (result,) = _run_devices(
        monkeypatch,
        {
            "data": {
                "name": "data",
                "devices": [[0, "/dev/nvme0n1", ["online"]], [1, "/dev/nvme1n1", ["offline"]]],
            }
        },
    )
    assert result.status == "WARN"
    assert "/dev/nvme1n1" in result.actual
    assert "offline" in result.actual


def test_raid_devices_does_not_invent_a_state_for_an_unreported_member(monkeypatch):
    """A member the daemon reported no state for is not a failed member."""
    (result,) = _run_devices(monkeypatch, {"data": {"name": "data", "devices": ["/dev/nvme0n1"]}})
    assert result.status == "PASS"
