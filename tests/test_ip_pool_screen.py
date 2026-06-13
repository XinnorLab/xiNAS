"""IPPoolScreen helpers — S8/ADR-0010 control-path retarget.

Headless coverage for the pure helpers and the ``apply_pool`` orchestration
(spec construction, server-matched validation bounds, the duplicate-netplan
cleanup gate, and the plan/apply + cleanup-retry flow against a fake control).
The Textual screen worker itself is thin glue over these; the generic
ControlClient transport is covered by tests/test_control_client.py.
"""

from __future__ import annotations

import json

import pytest

import xinas_menu.screens.ip_pool as ip
from xinas_menu.api.control_client import PlanBlocked
from xinas_menu.screens.ip_pool import (
    _cleanup_repairable,
    _pool_spec,
    _validate_ipv4,
    _validate_mtu,
    _validate_prefix,
    apply_pool,
)

_POOL_PATH = "/api/v1/network/ip-pool"


# ── spec construction ─────────────────────────────────────────────────────────


def test_pool_spec_omits_mtu_when_absent():
    assert _pool_spec("10.0.0.1", 24) == {"start": "10.0.0.1", "prefix": 24}
    assert _pool_spec("10.0.0.1", 24, None) == {"start": "10.0.0.1", "prefix": 24}


def test_pool_spec_includes_mtu_when_set():
    assert _pool_spec("10.0.0.1", 24, 9000) == {
        "start": "10.0.0.1",
        "prefix": 24,
        "mtu": 9000,
    }


# ── validation (must match the server's validatePool, ADR-0008) ───────────────


def test_validate_prefix_accepts_server_bounds():
    assert _validate_prefix("8") == (8, None)
    assert _validate_prefix("24") == (24, None)
    assert _validate_prefix("30") == (30, None)


@pytest.mark.parametrize("bad", ["7", "31", "0", "32", "x", ""])
def test_validate_prefix_rejects_out_of_range(bad):
    prefix, err = _validate_prefix(bad)
    assert prefix is None
    assert err is not None


def test_validate_mtu_optional_blank_is_omitted():
    assert _validate_mtu("") == (None, None)
    assert _validate_mtu("   ") == (None, None)


def test_validate_mtu_accepts_server_bounds():
    assert _validate_mtu("1280") == (1280, None)
    assert _validate_mtu("9000") == (9000, None)
    assert _validate_mtu("65520") == (65520, None)


@pytest.mark.parametrize("bad", ["1279", "65521", "abc"])
def test_validate_mtu_rejects_out_of_range(bad):
    mtu, err = _validate_mtu(bad)
    assert mtu is None
    assert err is not None


def test_validate_ipv4():
    assert _validate_ipv4("10.10.1.1") is None
    assert _validate_ipv4("not-an-ip") is not None
    assert _validate_ipv4("10.0.0.256") is not None


# ── duplicate-netplan cleanup gate ────────────────────────────────────────────


def test_cleanup_repairable_only_when_all_duplicate():
    dup = [{"code": "duplicate_netplan_definition", "message": "dup eth0"}]
    assert _cleanup_repairable(dup) == ["dup eth0"]


def test_cleanup_repairable_empty_when_any_other_blocker():
    mixed = [
        {"code": "duplicate_netplan_definition", "message": "dup"},
        {"code": "rdma_not_ready", "message": "no rdma"},
    ]
    assert _cleanup_repairable(mixed) == []
    assert _cleanup_repairable([]) == []


# ── apply_pool orchestration (fake control) ───────────────────────────────────


class _FakeControl:
    """Scripted ``plan_apply_wait``: each entry is ('ok', result) or
    ('blocked', blockers). Records (method, path, spec) per call."""

    def __init__(self, script):
        self._script = list(script)
        self.calls: list[tuple[str, str, dict]] = []

    def plan_apply_wait(self, method, path, spec, *, on_progress=None, cancel_check=None):
        self.calls.append((method, path, dict(spec)))
        kind, payload = self._script.pop(0)
        if kind == "blocked":
            raise PlanBlocked(payload)
        return payload


def test_apply_pool_success_single_call():
    ctrl = _FakeControl([("ok", {"task_id": "t1", "state": "success"})])
    result = apply_pool(ctrl, {"start": "10.10.1.1", "prefix": 24})
    assert result["state"] == "success"
    assert ctrl.calls == [("POST", _POOL_PATH, {"start": "10.10.1.1", "prefix": 24})]


def test_apply_pool_cleanup_retry_on_all_duplicate():
    dup = [{"code": "duplicate_netplan_definition", "message": "dup eth0"}]
    ctrl = _FakeControl([("blocked", dup), ("ok", {"state": "success"})])
    seen = {}

    def confirm(messages):
        seen["messages"] = messages
        return True

    result = apply_pool(ctrl, {"start": "10.10.1.1", "prefix": 24}, confirm_cleanup=confirm)
    assert result["state"] == "success"
    assert seen["messages"] == ["dup eth0"]
    # second call re-applies with cleanup:true, original spec preserved.
    assert ctrl.calls[1][2] == {"start": "10.10.1.1", "prefix": 24, "cleanup": True}


def test_apply_pool_non_duplicate_block_raises_without_confirm():
    ctrl = _FakeControl([("blocked", [{"code": "rdma_not_ready", "message": "x"}])])
    consulted = {"n": 0}

    def confirm(_messages):
        consulted["n"] += 1
        return True

    with pytest.raises(PlanBlocked):
        apply_pool(ctrl, {"start": "10.10.1.1", "prefix": 24}, confirm_cleanup=confirm)
    assert consulted["n"] == 0  # cleanup never offered for non-duplicate blockers
    assert len(ctrl.calls) == 1


def test_apply_pool_declined_cleanup_reraises():
    dup = [{"code": "duplicate_netplan_definition", "message": "dup"}]
    ctrl = _FakeControl([("blocked", dup)])
    with pytest.raises(PlanBlocked):
        apply_pool(ctrl, {"start": "10.10.1.1", "prefix": 24}, confirm_cleanup=lambda _m: False)
    assert len(ctrl.calls) == 1  # declined → no retry


# ── prefill cache: pool_end migrated away ─────────────────────────────────────


def test_cfg_read_and_write_drop_legacy_pool_end(tmp_path, monkeypatch):
    cfg_file = tmp_path / "network-pool.json"
    cfg_file.write_text(
        json.dumps({"pool_start": "10.9.9.9", "pool_prefix": 22, "pool_end": "10.9.9.99"})
    )
    monkeypatch.setattr(ip, "_CFG_PATH", cfg_file)

    cfg = ip._cfg_read()
    assert "pool_end" not in cfg  # migrated away on read
    assert cfg["pool_start"] == "10.9.9.9"
    assert cfg["pool_prefix"] == 22

    ip._cfg_write(cfg)
    on_disk = json.loads(cfg_file.read_text())
    assert "pool_end" not in on_disk  # never written back
    assert on_disk["pool_start"] == "10.9.9.9"
