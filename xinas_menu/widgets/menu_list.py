"""NavigableMenu — numbered + arrow-key menu widget."""
from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding
from textual.message import Message
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label


@dataclass
class MenuItem:
    key: str          # "1", "2", "0", "A", …
    label: str
    enabled: bool = True
    separator: bool = False  # if True, renders as divider line


class NavigableMenu(Widget):
    """Keyboard-navigable menu.

    Emits a :class:`Selected` message when the user presses Enter or a
    hotkey that matches a menu item key.
    """

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("up", "move_up", "Up", show=False),
        Binding("down", "move_down", "Down", show=False),
        Binding("enter", "select", "Select", show=False),
    ]

    class Selected(Message):
        """Emitted when an item is selected."""

        def __init__(self, key: str, label: str) -> None:
            super().__init__()
            self.key = key
            self.label = label

    highlighted: reactive[int] = reactive(0)

    def __init__(self, items: list[MenuItem], **kwargs) -> None:
        super().__init__(**kwargs)
        self._items = items

    @property
    def _navigable(self) -> list[tuple[int, MenuItem]]:
        return [
            (i, it)
            for i, it in enumerate(self._items)
            if not it.separator and it.enabled
        ]

    def compose(self) -> ComposeResult:
        for idx, item in enumerate(self._items):
            if item.separator:
                yield Label("  ─────────────────────────────", classes="menu-item-separator")
            else:
                label_text = f"  [{item.key}] {item.label}"
                cls = "menu-item"
                if idx == self.highlighted:
                    cls += " --highlight"
                yield Label(label_text, classes=cls, id=f"menu-item-{idx}")

    def watch_highlighted(self, _old: int, new: int) -> None:
        for i, _item in enumerate(self._items):
            try:
                widget = self.query_one(f"#menu-item-{i}", Label)
                if i == new:
                    widget.add_class("--highlight")
                else:
                    widget.remove_class("--highlight")
            except Exception:
                pass

    def action_move_up(self) -> None:
        nav = self._navigable
        if not nav:
            return
        positions = [i for i, _ in nav]
        try:
            cur_pos = positions.index(self.highlighted)
        except ValueError:
            self.highlighted = positions[0]
            return
        self.highlighted = positions[(cur_pos - 1) % len(positions)]

    def action_move_down(self) -> None:
        nav = self._navigable
        if not nav:
            return
        positions = [i for i, _ in nav]
        try:
            cur_pos = positions.index(self.highlighted)
        except ValueError:
            self.highlighted = positions[0]
            return
        self.highlighted = positions[(cur_pos + 1) % len(positions)]

    def action_select(self) -> None:
        nav = self._navigable
        for i, item in nav:
            if i == self.highlighted:
                self.post_message(NavigableMenu.Selected(item.key, item.label))
                return

    def on_key(self, event) -> None:
        key = event.character or ""
        if not key:
            return
        for item in self._items:
            if not item.separator and item.enabled and item.key.upper() == key.upper():
                self.post_message(NavigableMenu.Selected(item.key, item.label))
                event.stop()
                return
