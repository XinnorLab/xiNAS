"""Threading contract of the Reset-to-Baseline progress callback.

``TransactionalRunner`` invokes ``progress_cb`` from an ``async for`` stream
reader — on the event loop, not from a worker thread — and swallows any
exception the callback raises. A thread-hopping API hop there therefore
raises ``RuntimeError`` on every single line and is silently suppressed, so
the reset renders no live output at all.

Both halves are pinned: the screen must not hop threads, and the runner must
keep invoking the callback on the loop (if the runner ever moves the call into
a thread, the screen has to change with it and this test should fail loudly).
"""

from __future__ import annotations

import inspect
import re

from xinas_history.runner import TransactionalRunner
from xinas_menu.screens.config_history import ConfigHistoryScreen

# Thread-hopping primitives that would raise RuntimeError on the event loop
_FORBIDDEN_APIS = ["call_from_thread", "call_soon_threadsafe", "run_coroutine_threadsafe"]


def test_reset_progress_does_not_hop_threads():
    """Callback must not use thread-hopping primitives.

    All of these raise RuntimeError when called from the event loop,
    and the runner suppresses callback exceptions, so every progress
    line is silently dropped.
    """
    src = inspect.getsource(ConfigHistoryScreen._reset_to_baseline)
    for api in _FORBIDDEN_APIS:
        assert api not in src, (
            f"progress_cb runs on the event loop; {api} raises RuntimeError "
            "there and the runner suppresses it, so every progress line is dropped"
        )


def test_reset_progress_callback_still_updates_the_view():
    # Guard against 'fixing' the above by deleting the update entirely.
    src = inspect.getsource(ConfigHistoryScreen._reset_to_baseline)
    assert "set_content" in src


def test_screen_awaits_runner_on_its_own_loop():
    """Pins the screen's half of the threading contract.

    The direct `view.set_content()` call in the progress callback is only
    correct because the screen awaits `runner.execute_reset_to_baseline`
    inline, on the same event loop the callback runs on. If a future change
    wrapped that call to move it off-loop (e.g.
    `await asyncio.to_thread(lambda: asyncio.run(runner.execute_reset_to_baseline(...)))`),
    the callback would land back on a thread on a foreign loop and
    `call_from_thread` would become necessary again — but every assertion
    above would stay green, since they only inspect the callback body. This
    test catches that class of regression directly.
    """
    src = inspect.getsource(ConfigHistoryScreen._reset_to_baseline)
    assert re.search(r"await\s+runner\.execute_reset_to_baseline", src), (
        "the screen must await runner.execute_reset_to_baseline() inline; "
        "moving it off the event loop (to_thread/asyncio.run) breaks the "
        "callback's direct set_content() call"
    )


def test_runner_invokes_progress_cb_on_the_event_loop():
    """Pins the premise of the test above.

    The runner must invoke the callback on the event loop, not in a thread pool.
    We check: (1) the method is async (2) progress_cb is called by the method,
    tolerant of formatting (3) the method does not use thread pool executors
    (to_thread, run_in_executor) which would move the callback off the loop.
    """
    src = inspect.getsource(TransactionalRunner._run_ansible_playbook)

    # Method must be async (callback is on the event loop)
    assert inspect.iscoroutinefunction(TransactionalRunner._run_ansible_playbook)

    # Callback must be invoked, tolerant of whitespace and keyword form
    assert re.search(r"progress_cb\s*\(", src), (
        "runner must invoke progress_cb; if this assertion fails, check for "
        "reformat (different call style, whitespace, keyword args)"
    )

    # Runner must not move callback into a thread pool
    assert "to_thread" not in src and "run_in_executor" not in src, (
        "callback must run on event loop; to_thread/run_in_executor would move "
        "it into a thread pool, causing the screen's direct view.set_content() "
        "to fail"
    )
