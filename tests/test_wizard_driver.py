# tests/test_wizard_driver.py
"""Headless coverage for the generic wizard driver (run_wizard)."""

from __future__ import annotations

import asyncio

from xinas_menu.widgets.wizard import BACK, CANCEL, WizardStep, run_wizard


def _script_step(key, script, applies=lambda a: True):
    """A step whose run() pops the next scripted outcome each time it is entered.

    `script` is a list of outcomes. Each outcome is either a callable
    `fn(answers, allow_back, step_no) -> value|BACK|CANCEL` or a plain value.
    Records the (allow_back, step_no) it was called with in `calls`.
    """
    calls = []
    it = iter(script)

    async def run(answers, allow_back, step_no):
        calls.append((allow_back, step_no))
        nxt = next(it)
        return nxt(answers, allow_back, step_no) if callable(nxt) else nxt

    step = WizardStep(key=key, run=run, applies=applies)
    step.calls = calls  # type: ignore[attr-defined]
    return step


def test_forward_accumulates_all_answers():
    steps = [
        _script_step("a", ["A"]),
        _script_step("b", ["B"]),
        _script_step("c", ["C"]),
    ]
    result = asyncio.run(run_wizard(steps))
    assert result == {"a": "A", "b": "B", "c": "C"}


def test_cancel_returns_none():
    steps = [_script_step("a", ["A"]), _script_step("b", [CANCEL])]
    assert asyncio.run(run_wizard(steps)) is None


def test_back_retains_earlier_and_later_answers():
    # a="A", b enters -> BACK, a re-enters -> keeps "A" (prefill visible via answers),
    # a returns "A2", b returns "B".
    a = _script_step("a", ["A", "A2"])
    b = _script_step("b", [BACK, "B"])
    result = asyncio.run(run_wizard([a, b]))
    assert result == {"a": "A2", "b": "B"}
    # a was entered twice, b twice; a saw allow_back False both times (first step).
    assert a.calls == [(False, 1), (False, 1)]
    assert b.calls[0] == (True, 2)


def test_back_on_first_step_is_noop():
    # A misbehaving first step that returns BACK must not underflow.
    a = _script_step("a", [BACK, "A"])
    b = _script_step("b", ["B"])
    result = asyncio.run(run_wizard([a, b]))
    assert result == {"a": "A", "b": "B"}


def test_conditional_step_skipped_forward_and_back():
    # b applies only when a == "yes". With a == "no", forward skips b; Back from
    # c lands on a, not b.
    a = _script_step("a", ["no", "no"])
    b = _script_step("b", ["Bshould", "not", "run"], applies=lambda ans: ans.get("a") == "yes")
    c = _script_step("c", [BACK, "C"])
    result = asyncio.run(run_wizard([a, b, c]))
    assert result == {"a": "no", "c": "C"}
    assert b.calls == []  # never entered
    # c enters, backs to a (skipping b), a re-runs, c re-runs.
    assert a.calls == [(False, 1), (False, 1)]


def test_display_number_counts_only_applicable():
    seen = {}

    def rec(key):
        def fn(answers, allow_back, step_no):
            seen[key] = step_no
            return key.upper()

        return fn

    a = _script_step("a", [rec("a")])
    b = _script_step("b", [rec("b")], applies=lambda ans: False)
    c = _script_step("c", [rec("c")])
    asyncio.run(run_wizard([a, b, c]))
    assert seen == {"a": 1, "c": 2}  # b skipped, c numbered 2 not 3


def test_back_then_invalidate_drops_stale_answer():
    # a="yes" -> b applies, returns "B"; c backs to b, b backs to a, a changes to
    # "no" -> b is now skipped, so its stale answer must be dropped from the result.
    a = _script_step("a", ["yes", "no"])
    b = _script_step("b", ["B", BACK], applies=lambda ans: ans.get("a") == "yes")
    c = _script_step("c", [BACK, "C"])
    result = asyncio.run(run_wizard([a, b, c]))
    assert result == {"a": "no", "c": "C"}  # no "b" key
    assert "b" not in result


def test_initial_seeds_answers():
    a = _script_step("a", ["A"])
    result = asyncio.run(run_wizard([a], initial={"x": 1}))
    assert result == {"x": 1, "a": "A"}
