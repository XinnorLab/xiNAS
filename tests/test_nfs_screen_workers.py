"""Worker-vs-coroutine wiring of the NFS screen menu handlers.

``NFSScreen.on_navigable_menu_selected`` and ``on_mount`` are synchronous
Textual handlers that invoke the async menu actions bare (``self._foo()``).
That only works when the target is ``@work``-decorated: the call then
returns a scheduled ``Worker``. A plain ``async def`` called this way
produces a coroutine object that is silently dropped — the menu item does
nothing (f7401d0 lost ``@work`` on ``_remove_share`` exactly this way).

The inverse trap also exists: helpers that are ``await``-ed inline, such as
``_show_control_error``, must stay plain coroutine functions — textual 8.x
``Worker`` objects are not awaitable (see 5150367).
"""

from __future__ import annotations

import ast
import inspect
import textwrap

from xinas_menu.screens.nfs import NFSScreen


def _bare_self_calls(method) -> set[str]:
    """Names of ``self.<name>()`` statement-expression calls in *method*."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(method)))
    names: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
            continue
        func = node.value.func
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "self"
        ):
            names.add(func.attr)
    return names


def test_menu_handlers_are_workers_not_bare_coroutines():
    handlers = _bare_self_calls(NFSScreen.on_navigable_menu_selected) | _bare_self_calls(
        NFSScreen.on_mount
    )
    # Guard the AST extraction itself: the known menu actions must be found.
    assert {"_load_exports", "_add_share_wizard", "_remove_share"} <= handlers

    bare = sorted(
        name for name in handlers if inspect.iscoroutinefunction(getattr(NFSScreen, name, None))
    )
    assert not bare, (
        f"{bare}: bare coroutine function(s) invoked without await from a sync "
        "handler — the coroutine is created and dropped, so the menu item does "
        "nothing. Decorate with @work (or await via a worker)."
    )


def test_show_control_error_stays_awaitable():
    # Awaited inline by the share actions; @work would make it un-awaitable.
    assert inspect.iscoroutinefunction(NFSScreen._show_control_error)
