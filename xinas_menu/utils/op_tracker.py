"""OpTracker — structured operation tracking, port of lib/op_status.sh."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable

OP_LOG = Path("/var/log/xinas/operations.log")


class StepTag(str, Enum):
    OK = "OK"
    FAIL = "FAIL"


@dataclass
class OpStep:
    tag: StepTag
    name: str
    detail: str = ""


class OpStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


@dataclass
class OpResult:
    name: str
    status: OpStatus
    steps: list[OpStep]
    before: str = ""
    after: str = ""
    duration: float = 0.0

    @property
    def ok_count(self) -> int:
        return sum(1 for s in self.steps if s.tag == StepTag.OK)

    @property
    def fail_count(self) -> int:
        return sum(1 for s in self.steps if s.tag == StepTag.FAIL)

    def format_lines(self) -> list[str]:
        lines: list[str] = []
        for step in self.steps:
            prefix = "[OK]  " if step.tag == StepTag.OK else "[FAIL]"
            lines.append(f"  {prefix} {step.name}")
            if step.detail:
                lines.append(f"         {step.detail}")
        if self.after:
            lines.append("")
            lines.append(self.after)
        return lines


class OpTracker:
    """Tracks steps for a single operation; produces an OpResult."""

    def __init__(self, name: str, before: str = "") -> None:
        self._name = name
        self._before = before
        self._steps: list[OpStep] = []
        self._start = time.monotonic()

    def step(self, name: str, ok: bool, detail: str = "") -> None:
        self._steps.append(OpStep(StepTag.OK if ok else StepTag.FAIL, name, detail))

    def run(self, name: str, fn: Callable[[], None]) -> bool:
        """Run *fn*; record the step. Returns True on success."""
        try:
            fn()
            self.step(name, ok=True)
            return True
        except Exception as exc:
            self.step(name, ok=False, detail=str(exc))
            return False

    def finish(self, after: str = "") -> OpResult:
        duration = time.monotonic() - self._start
        total = len(self._steps)
        fails = sum(1 for s in self._steps if s.tag == StepTag.FAIL)

        if total == 0 or fails == total:
            status = OpStatus.FAILED
        elif fails > 0:
            status = OpStatus.PARTIAL
        else:
            status = OpStatus.SUCCESS

        result = OpResult(
            name=self._name,
            status=status,
            steps=list(self._steps),
            before=self._before,
            after=after,
            duration=duration,
        )
        _write_op_log(result)
        return result


def _write_op_log(result: OpResult) -> None:
    import os
    import pwd

    try:
        user = pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        user = os.environ.get("USER", "unknown")

    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        f"=== {ts} | {user} | {result.name} | {result.status.value} ===",
    ]
    if result.before:
        lines.append(f"  BEFORE: {result.before}")
    for step in result.steps:
        line = f"  [{step.tag.value}] {step.name}"
        if step.detail:
            line += f" | {step.detail}"
        lines.append(line)
    if result.after:
        lines.append(f"  AFTER: {result.after}")
    lines.append(f"  ENDED: {ts}")

    try:
        OP_LOG.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        with OP_LOG.open("a") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError:
        pass
