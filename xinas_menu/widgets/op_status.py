"""OpStatusWidget — inline step progress display."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import Label

from xinas_menu.utils.op_tracker import OpResult, OpStatus


class OpStatusWidget(Widget):
    """Displays the result of an OpTracker operation."""

    DEFAULT_CSS = """
    OpStatusWidget {
        height: auto;
        border: solid $secondary;
        padding: 0 1;
        margin: 1 0;
    }
    """

    def __init__(self, result: OpResult, **kwargs) -> None:
        super().__init__(**kwargs)
        self._result = result

    def compose(self) -> ComposeResult:
        r = self._result
        color = {
            OpStatus.SUCCESS: "green",
            OpStatus.PARTIAL: "yellow",
            OpStatus.FAILED: "red",
        }[r.status]
        yield Label(f"[{color}]{r.name}: {r.status.value}[/{color}]")
        for step in r.steps:
            if step.tag.value == "OK":
                yield Label(f"  [green][OK]   {step.name}[/green]", classes="op-step-ok")
            else:
                yield Label(f"  [red][FAIL] {step.name}[/red]", classes="op-step-fail")
                if step.detail:
                    yield Label(f"         [dim]{step.detail}[/dim]")
        if r.after:
            yield Label(f"\n{r.after}")
