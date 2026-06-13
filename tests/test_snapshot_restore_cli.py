"""S11 T3: the `snapshot restore <id>` CLI command."""

from __future__ import annotations

import argparse
import json

from xinas_history import __main__ as cli
from xinas_history.runner import RunResult


class _FakeRunner:
    def __init__(self, result: RunResult, **_kwargs) -> None:
        self._result = result

    async def execute_restore_snapshot(self, snapshot_id, source, reason, progress_cb=None):
        assert snapshot_id == "snap-1"
        assert reason == "oops"
        return self._result


def _args(**over) -> argparse.Namespace:
    base = {
        "snapshot_id": "snap-1",
        "reason": "oops",
        "source": "api",
        "yes": True,
        "format": "json",
    }
    base.update(over)
    return argparse.Namespace(**base)


def test_snapshot_restore_emits_json(monkeypatch, capsys):
    result = RunResult(success=True, operation="rollback", snapshot_id="snap-1")
    result.output = "recovery applied"
    monkeypatch.setattr(
        "xinas_history.runner.TransactionalRunner", lambda **kw: _FakeRunner(result, **kw)
    )

    rc = cli._cmd_snapshot_restore(_args(), engine=object())
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["success"] is True
    assert out["snapshot_id"] == "snap-1"


def test_snapshot_restore_failure_returns_nonzero(monkeypatch, capsys):
    result = RunResult(success=False, operation="rollback", snapshot_id="snap-1")
    result.error = "no_restorable_payload"
    monkeypatch.setattr(
        "xinas_history.runner.TransactionalRunner", lambda **kw: _FakeRunner(result, **kw)
    )

    rc = cli._cmd_snapshot_restore(_args(), engine=object())
    assert rc == 1
    out = json.loads(capsys.readouterr().out)
    assert out["success"] is False
    assert out["error"] == "no_restorable_payload"
