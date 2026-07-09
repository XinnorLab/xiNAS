"""GuardedModalScreen — ModalScreen whose dismiss() tolerates duplicate events."""

from __future__ import annotations

from textual.await_complete import AwaitComplete
from textual.screen import ModalScreen, ScreenResultType


class GuardedModalScreen(ModalScreen[ScreenResultType]):
    """ModalScreen whose ``dismiss()`` is a no-op once the screen is inactive.

    Duplicated input events (double Enter, double-click) can queue a second
    dismiss-triggering message before the first ``dismiss()`` pops the
    screen. textual 8.2.8's ``Screen.dismiss`` unconditionally calls
    ``App.pop_screen()``, so the duplicate pops the wrong screen — or raises
    ``ScreenStackError`` when only the base screen remains. Guarding on
    ``is_active`` makes the duplicate harmless.

    All modal dialog widgets should subclass this instead of ``ModalScreen``.
    """

    def dismiss(self, result: ScreenResultType | None = None) -> AwaitComplete:
        if not self.is_active:
            return AwaitComplete()
        return super().dismiss(result)
