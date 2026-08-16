"""The force retry must run under the same progress surface as the first
attempt.

`_create_filesystem_wizard` submits the create twice: once as planned, and once
more with `force: true` after the operator consents to overwriting an
existing filesystem. The first attempt pushed a `TaskWaitDialog` and fed it
`on_progress`; the retry called `plan_apply_wait` with a toast callback and
no dialog, so the longer and destructive of the two attempts ran behind a
static line and could not be cancelled (reported 2026-08-16, introduced with
the TaskWaitDialog in 0bfb2f1).

Driving the real screen would mean standing up a Textual app plus the whole
wizard; these assertions are structural instead, the same approach
`test_nfs_screen_workers.py` uses for call-site wiring. They pin the shape
the fix establishes: both submissions go through ONE helper, and that helper
is the thing that owns the dialog and the cancel hook.
"""

from __future__ import annotations

import ast
import inspect
import textwrap

from xinas_menu.screens.filesystem import FilesystemScreen


def _calls_named(method, name: str) -> list[ast.Call]:
    """Every call to ``<anything>.name(...)`` or ``name(...)`` in *method*."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(method)))
    out: list[ast.Call] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == name:
            out.append(node)
        elif isinstance(func, ast.Name) and func.id == name:
            out.append(node)
    return out


def _kwarg_names(call: ast.Call) -> set[str]:
    return {kw.arg for kw in call.keywords if kw.arg is not None}


def _submissions(method) -> list[ast.Call]:
    """`asyncio.to_thread(self.app.control.plan_apply_wait, …)` calls.

    The submission is NOT a call to `plan_apply_wait` — the bound method is
    handed to `to_thread` as an argument, so matching on call names finds
    nothing and any assertion built that way passes vacuously.
    """
    tree = ast.parse(textwrap.dedent(inspect.getsource(method)))
    out: list[ast.Call] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and _calls_to_thread(node)):
            continue
        if any(isinstance(a, ast.Attribute) and a.attr == "plan_apply_wait" for a in node.args):
            out.append(node)
    return out


def _calls_to_thread(node: ast.Call) -> bool:
    func = node.func
    return isinstance(func, ast.Attribute) and func.attr == "to_thread"


def test_create_submits_through_the_single_progress_helper():
    # No direct submissions left in the wizard: both the first attempt and the
    # force retry go through the helper, which is what keeps them identical.
    assert _submissions(FilesystemScreen._create_filesystem_wizard) == []
    assert len(_calls_named(FilesystemScreen._create_filesystem_wizard, "_submit_create")) == 2


def test_the_helper_owns_the_dialog_and_the_cancel_hook():
    helper = FilesystemScreen._submit_create
    source = textwrap.dedent(inspect.getsource(helper))

    # It pushes the progress dialog itself...
    assert _calls_named(helper, "TaskWaitDialog"), (
        "_submit_create must create the TaskWaitDialog — if a caller passes one "
        "in, the two call sites can drift apart again"
    )
    assert "push_screen" in source

    # ...and every submission it makes carries both the progress sink and the
    # cancel check, so a force retry is as watchable and as abortable as the
    # attempt it repeats.
    submissions = _submissions(helper)
    assert len(submissions) == 1
    kwargs = _kwarg_names(submissions[0])
    assert "on_progress" in kwargs
    assert "cancel_check" in kwargs


def test_retry_submission_passes_force_and_dangerous():
    # The consent the operator gave is destructive; the retry must carry both
    # the spec flag and the apply-level gate (spec §3.3, destruction gate).
    source = textwrap.dedent(inspect.getsource(FilesystemScreen._create_filesystem_wizard))
    retry = [c for c in _calls_named(FilesystemScreen._create_filesystem_wizard, "_submit_create")][
        -1
    ]
    kwargs = _kwarg_names(retry)
    assert "dangerous" in kwargs, "the force retry must pass dangerous=True"
    assert '"force": True' in source or "'force': True" in source
