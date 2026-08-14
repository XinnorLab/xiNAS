"""Threading contract of the Reset-to-Baseline progress callback.

``TransactionalRunner`` invokes ``progress_cb`` from an ``async for`` stream
reader — on the event loop, not from a worker thread — and swallows any
exception the callback raises. A ``call_from_thread`` hop there therefore
raises ``RuntimeError`` on every single line and is silently suppressed, so
the reset renders no live output at all.

Both halves are pinned: the screen must not hop threads, and the runner must
keep invoking the callback on the loop (if the runner ever moves the call into
a thread, the screen has to change with it and this test should fail loudly).
"""

from __future__ import annotations

import inspect

from xinas_history.runner import TransactionalRunner
from xinas_menu.screens.config_history import ConfigHistoryScreen


def test_reset_progress_does_not_hop_threads():
    src = inspect.getsource(ConfigHistoryScreen._reset_to_baseline)
    assert "call_from_thread" not in src, (
        "progress_cb runs on the event loop; call_from_thread raises there "
        "and the runner suppresses it, so every progress line is dropped"
    )


def test_reset_progress_callback_still_updates_the_view():
    # Guard against 'fixing' the above by deleting the update entirely.
    src = inspect.getsource(ConfigHistoryScreen._reset_to_baseline)
    assert "set_content" in src


def test_runner_invokes_progress_cb_on_the_event_loop():
    """Pins the premise of the test above."""
    src = inspect.getsource(TransactionalRunner._run_ansible_playbook)
    assert "async def _read_stream" in src
    assert "progress_cb(line)" in src
