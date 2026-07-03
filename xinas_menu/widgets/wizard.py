# xinas_menu/widgets/wizard.py
"""Generic back-navigable wizard driver for the Textual management wizards.

A wizard is an ordered list of :class:`WizardStep`. Each step's ``run``
coroutine drives one logical step (which may internally show more than one
dialog) and returns the step's answer value, or one of the sentinels
:data:`BACK` / :data:`CANCEL`.

``run_wizard`` owns the current index, back navigation, and the accumulated
answers dict. It has no Textual dependency, so it is unit-tested headless with
fake steps.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


class _Sentinel:
    __slots__ = ("_name",)

    def __init__(self, name: str) -> None:
        self._name = name

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return self._name


#: Returned by a step's ``run`` to go back to the previous applicable step.
BACK = _Sentinel("BACK")
#: Returned by a step's ``run`` to abort the whole wizard.
CANCEL = _Sentinel("CANCEL")

#: ``run(answers, allow_back, step_no) -> value | BACK | CANCEL``
StepRun = Callable[[dict, bool, int], Awaitable[Any]]


@dataclass
class WizardStep:
    key: str
    run: StepRun
    applies: Callable[[dict], bool] = field(default=lambda answers: True)


def _applicable(steps: list[WizardStep], answers: dict) -> list[int]:
    return [i for i, s in enumerate(steps) if s.applies(answers)]


def _has_prior_applicable(steps: list[WizardStep], idx: int, answers: dict) -> bool:
    return any(i < idx for i in _applicable(steps, answers))


def _prev_applicable(steps: list[WizardStep], idx: int, answers: dict) -> int:
    prior = [i for i in _applicable(steps, answers) if i < idx]
    return prior[-1] if prior else idx  # stay put if nothing earlier applies


def _display_number(steps: list[WizardStep], idx: int, answers: dict) -> int:
    return sum(1 for i in _applicable(steps, answers) if i <= idx)


async def run_wizard(steps: list[WizardStep], initial: dict | None = None) -> dict | None:
    """Drive ``steps`` with Back/Cancel navigation.

    Returns the accumulated answers dict when the user advances past the last
    step, or ``None`` if any step returns :data:`CANCEL`. ``initial`` seeds the
    answers dict (used by Edit to pre-fill from the current share).

    The returned dict never contains a key for a step that is inapplicable on
    the taken path (such keys are dropped when the step is skipped); answers for
    still-applicable later steps are retained across Back.
    """
    answers: dict = dict(initial or {})
    idx = 0
    while idx < len(steps):
        step = steps[idx]
        if not step.applies(answers):
            answers.pop(step.key, None)  # forget a now-inapplicable step's stale answer
            idx += 1
            continue
        allow_back = _has_prior_applicable(steps, idx, answers)
        step_no = _display_number(steps, idx, answers)
        result = await step.run(answers, allow_back, step_no)
        if result is CANCEL:
            return None
        if result is BACK:
            idx = _prev_applicable(steps, idx, answers)
            continue
        answers[step.key] = result
        idx += 1
    return answers
