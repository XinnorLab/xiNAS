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


# ---- unreadable state payloads (review P1) ---------------------------------
#
# The check iterated `arr.get("state", [])` raw, so the SHAPE of the payload
# decided the verdict rather than its content: a missing or empty `state`
# reported PASS ("1 array(s) online") for an array nothing was known about,
# `null` raised an uncaught TypeError out of the whole run, and the string
# "online" iterated into six single characters and produced six WARNs. None of
# those may certify an array as healthy.


@pytest.mark.parametrize(
    ("label", "state"),
    [
        ("missing", None),  # key absent entirely
        ("null", None),
        ("empty list", []),
        ("empty string", ""),
        ("dict", {"a": 1}),
        ("number", 7),
        ("list of non-strings", [1, 2]),
    ],
)
def test_unreadable_state_never_passes(monkeypatch, label, state):
    arr = {"name": "data"}
    if label != "missing":
        arr["state"] = state
    result = _run(monkeypatch, {"data": arr})
    assert result.status in ("SKIP", "WARN"), f"{label} produced {result.status}"


def test_unreadable_state_does_not_raise(monkeypatch):
    """`state: null` used to escape as a TypeError and kill the whole run."""
    assert _run(monkeypatch, {"data": {"name": "data", "state": None}}).status in ("SKIP", "WARN")


def test_bare_string_state_is_one_word_not_six_characters(monkeypatch):
    assert _run(monkeypatch, {"data": {"name": "data", "state": "online"}}).status == "PASS"


def test_bare_string_failure_state_still_fails(monkeypatch):
    result = _run(monkeypatch, {"data": {"name": "data", "state": "degraded"}})
    assert result.status == "FAIL"
    assert "degraded" in result.actual


def test_a_real_failure_outranks_an_unreadable_sibling(monkeypatch):
    """One unreadable array must not mask another array that is degraded."""
    result = _run(
        monkeypatch,
        {"a": {"name": "a", "state": None}, "b": {"name": "b", "state": ["degraded"]}},
    )
    assert result.status == "FAIL"
    assert "b" in result.actual


def test_all_arrays_unreadable_reports_skip(monkeypatch):
    """The documented SKIP case: nothing could be read, so nothing is claimed."""
    result = _run(monkeypatch, {"a": {"name": "a"}, "b": {"name": "b", "state": None}})
    assert result.status == "SKIP"
    assert "a" in result.actual and "b" in result.actual


# ---- per-category WARN text (review P1) ------------------------------------
#
# One shared line said "the array is redundant but may be slower until it
# completes" for every WARN. That is not defensible for an initializing array
# (AG 4.4: the RAID reaches "a fully operational 'initialized' state" only once
# initialization concludes), for a stopped restripe (nothing is running), or
# for a word this table does not know (nothing can be inferred at all).


def test_initing_does_not_claim_the_array_is_redundant(monkeypatch):
    result = _run(monkeypatch, _array("online", "initing"))
    assert result.status == "WARN"
    assert "is redundant" not in result.impact
    assert "not yet fully redundant" in result.impact


def test_stopped_restripe_does_not_claim_an_operation_is_running(monkeypatch):
    result = _run(monkeypatch, _array("online", "initialized", "need_restripe"))
    assert result.status == "WARN"
    assert "is running" not in result.impact
    assert "stopped" in result.impact.lower()


def test_unrecognised_word_claims_nothing_about_redundancy(monkeypatch):
    result = _run(monkeypatch, _array("online", "some_future_state"))
    assert result.status == "WARN"
    assert "is redundant" not in result.impact
    assert "some_future_state" in result.actual


def test_genuinely_running_background_op_keeps_the_reassuring_text(monkeypatch):
    result = _run(monkeypatch, _array("online", "initialized", "sdc_scanning"))
    assert result.status == "WARN"
    assert "redundant" in result.impact


def test_the_more_serious_warn_category_supplies_the_impact(monkeypatch):
    """An unreadable array alongside a merely-scanning one reports the former."""
    result = _run(
        monkeypatch,
        {
            "a": {"name": "a", "state": ["online", "initialized", "sdc_scanning"]},
            "b": {"name": "b", "state": None},
        },
    )
    assert result.status == "WARN"
    assert "could not be read" in result.impact


def test_every_warn_and_fail_carries_a_fix_hint(monkeypatch):
    for states in (("online", "initing"), ("degraded",), ("online", "some_future_state")):
        result = _run(monkeypatch, _array(*states))
        assert result.fix_hint, f"{states} has no fix_hint"
