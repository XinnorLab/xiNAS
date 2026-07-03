# Wizard Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a state-preserving **Back** button to the three day-2 management wizards (Add Share, Edit Share, Create Array) in the Textual TUI.

**Architecture:** A new headless `run_wizard` driver runs an ordered list of `WizardStep`s, owning the index, back navigation, and accumulated answers. The four wizard dialogs gain an `allow_back` flag (renders a Back button, dismisses with a distinct `BACK` sentinel) and pre-selection. Each wizard method builds a step list and delegates to the driver; the dispatch (API call, audit, snapshot) runs after the driver returns a confirmed answers dict.

**Tech Stack:** Python 3, Textual (`textual>=0.71`), pytest (async tested via `asyncio.run`).

**Design doc:** [docs/plans/2026-07-03-wizard-back-navigation-design.md](2026-07-03-wizard-back-navigation-design.md)

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `xinas_menu/widgets/wizard.py` | `BACK`/`CANCEL` sentinels, `WizardStep`, `run_wizard`, pure index helpers | **Create** |
| `tests/test_wizard_driver.py` | Headless driver coverage | **Create** |
| `xinas_menu/widgets/select_dialog.py` | `allow_back` + `selected` pre-highlight | Modify |
| `xinas_menu/widgets/input_dialog.py` | `allow_back` | Modify |
| `xinas_menu/widgets/confirm_dialog.py` | `allow_back` | Modify |
| `xinas_menu/widgets/drive_picker.py` | `allow_back` | Modify |
| `tests/test_wizard_dialogs.py` | Constructor smoke tests for the 4 dialogs' `allow_back` | **Create** |
| `xinas_menu/screens/nfs.py` | `_access_steps`, rewritten `_add_share_wizard`/`_edit_share`, pure prefill helpers | Modify |
| `tests/test_nfs_wizard_helpers.py` | Pure prefill/parse helper coverage | **Create** |
| `xinas_menu/screens/raid.py` | Rewritten `_create_array_wizard` | Modify |
| `docs/Storage/fs-shares-management-spec.md` | Wizard-navigation model + Add/Edit sections | Modify |
| `docs/Storage/raid-management-spec.md` | Create-array wizard section | Modify |

Convention notes (verified in-repo): async code is tested with `asyncio.run(...)` (no pytest-asyncio); TUI screen workers are thin glue over headless-tested helpers and are **not** pilot-tested — this plan keeps to that, testing the driver and pure helpers headless and treating dialog rendering as glue.

---

## Task 1: Wizard driver module

**Files:**
- Create: `xinas_menu/widgets/wizard.py`
- Test: `tests/test_wizard_driver.py`

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/wonderful-heyrovsky-f81608 && python -m pytest tests/test_wizard_driver.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'xinas_menu.widgets.wizard'`.

- [ ] **Step 3: Write the driver module**

```python
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
    """
    answers: dict = dict(initial or {})
    idx = 0
    while idx < len(steps):
        step = steps[idx]
        if not step.applies(answers):
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_wizard_driver.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Lint**

Run: `ruff check xinas_menu/widgets/wizard.py tests/test_wizard_driver.py && ruff format --check xinas_menu/widgets/wizard.py tests/test_wizard_driver.py`
Expected: no errors (run `ruff format` if the check fails, then re-check).

- [ ] **Step 6: Commit**

```bash
git add xinas_menu/widgets/wizard.py tests/test_wizard_driver.py
git commit -m "feat(tui): headless wizard driver with Back/Cancel navigation"
```

---

## Task 2: `allow_back` on the wizard dialogs

Adds a Back button (dismisses with `BACK`) to the four dialogs, plus `selected` pre-highlight on `SelectDialog`. `Esc` stays Cancel. `SelectDialog`/`ConfirmDialog` also bind `left` → Back.

**Files:**
- Modify: `xinas_menu/widgets/select_dialog.py`, `input_dialog.py`, `confirm_dialog.py`, `xinas_menu/widgets/drive_picker.py`
- Test: `tests/test_wizard_dialogs.py`

- [ ] **Step 1: Write the failing smoke tests**

```python
# tests/test_wizard_dialogs.py
"""Constructor smoke tests: the four wizard dialogs accept allow_back and the
BACK sentinel is a distinct object (headless — no Textual app mounted)."""

from __future__ import annotations

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.wizard import BACK


def test_back_sentinel_is_distinct():
    assert BACK is not None and BACK is not True and BACK is not False and BACK != ""


def test_select_dialog_accepts_allow_back_and_selected():
    d = SelectDialog(["a", "b"], title="t", prompt="p", selected="b", allow_back=True)
    assert d._allow_back is True
    assert d._selected == "b"


def test_input_dialog_accepts_allow_back():
    d = InputDialog("prompt", "title", default="x", allow_back=True)
    assert d._allow_back is True


def test_confirm_dialog_accepts_allow_back():
    d = ConfirmDialog("msg", "title", allow_back=True)
    assert d._allow_back is True


def test_drive_picker_accepts_allow_back():
    d = DrivePickerScreen([], title="t", allow_back=True)
    assert d._allow_back is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_wizard_dialogs.py -q`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'allow_back'`.

- [ ] **Step 3: Modify `select_dialog.py`**

Replace the class body from the `BINDINGS` line through `action_cancel` with:

```python
    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        Binding("left", "back", "Back", show=False),
    ]

    def __init__(
        self,
        items: list[str],
        title: str = "Select",
        prompt: str = "",
        *,
        selected: str | None = None,
        allow_back: bool = False,
    ) -> None:
        super().__init__()
        self._items = items
        self._title = title
        self._prompt = prompt
        self._selected = selected
        self._allow_back = allow_back

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            if self._prompt:
                yield Label(self._prompt, id="dialog-body")
            yield OptionList(
                *[Option(item, id=f"opt-{i}") for i, item in enumerate(self._items)],
                id="dialog-select",
            )
            with Horizontal(id="dialog-buttons"):
                if self._allow_back:
                    yield Button("Back [←]", variant="default", id="btn-back")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_mount(self) -> None:
        if self._selected is not None and self._selected in self._items:
            option_list = self.query_one("#dialog-select", OptionList)
            option_list.highlighted = self._items.index(self._selected)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(str(event.option.prompt))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-back":
            self.action_back()
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_back(self) -> None:
        if self._allow_back:
            from xinas_menu.widgets.wizard import BACK

            self.dismiss(BACK)
```

Update the class declaration and imports at the top of the file:

```python
from textual.widgets import Button, Label, OptionList
from textual.widgets.option_list import Option

from xinas_menu.widgets.wizard import BACK as _BACK  # noqa: F401  (re-exported for typing)


class SelectDialog(ModalScreen["str | object | None"]):
```

(The `object` in the type parameter covers the `BACK` sentinel. The local
import inside `action_back` avoids a circular import at module load; the
top-level `_BACK` alias is only for readers — delete it if ruff flags F401 and
keep the inline import.)

- [ ] **Step 4: Modify `input_dialog.py`**

```python
    def __init__(
        self,
        prompt: str,
        title: str = "Input",
        default: str = "",
        password: bool = False,
        placeholder: str = "",
        *,
        allow_back: bool = False,
    ) -> None:
        super().__init__()
        self._prompt = prompt
        self._title = title
        self._default = default
        self._password = password
        self._placeholder = placeholder
        self._allow_back = allow_back

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._prompt, id="dialog-body")
            yield Input(
                value=self._default,
                placeholder=self._placeholder,
                password=self._password,
                id="dialog-input",
            )
            with Horizontal(id="dialog-buttons"):
                yield Button("OK [Enter]", variant="primary", id="btn-ok")
                if self._allow_back:
                    yield Button("Back", variant="default", id="btn-back")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            inp = self.query_one("#dialog-input", Input)
            self.dismiss(inp.value)
        elif event.button.id == "btn-back":
            self._dismiss_back()
        else:
            self.dismiss(None)

    def on_input_submitted(self, _event: Input.Submitted) -> None:
        inp = self.query_one("#dialog-input", Input)
        self.dismiss(inp.value)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _dismiss_back(self) -> None:
        if self._allow_back:
            from xinas_menu.widgets.wizard import BACK

            self.dismiss(BACK)
```

Change the class declaration to `class InputDialog(ModalScreen["str | object | None"]):`.

- [ ] **Step 5: Modify `confirm_dialog.py`**

Add to `BINDINGS`: `Binding("left", "back", "Back", show=False),`. Add `allow_back: bool = False` as a keyword-only param in `__init__` and store `self._allow_back = allow_back`. In `compose`, inside the `dialog-buttons` `Horizontal`, before the Yes/No/OK buttons add:

```python
                if self._allow_back:
                    yield Button("Back [←]", variant="default", id="btn-back", classes="dialog-btn")
```

In `on_button_pressed`, handle Back first:

```python
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-back":
            self.action_back()
        elif event.button.id == "btn-ok":
            self.dismiss(True)
        else:
            self.dismiss(event.button.id == "btn-yes")
```

Add the action:

```python
    def action_back(self) -> None:
        if self._allow_back:
            from xinas_menu.widgets.wizard import BACK

            self.dismiss(BACK)
```

Change the class declaration to `class ConfirmDialog(ModalScreen["bool | object"]):`.

- [ ] **Step 6: Modify `drive_picker.py`**

Add `allow_back: bool = False` as a keyword-only param to `__init__` and store `self._allow_back = allow_back`. Add to `BINDINGS`: `Binding("b", "back", "Back", show=True),`. In `compose`, inside `#picker-buttons`, before the Cancel button add:

```python
                if self._allow_back:
                    yield Button("Back [b]", variant="default", id="btn-back")
```

Add the action and Back handling in `on_button_pressed`:

```python
    def action_back(self) -> None:
        if self._allow_back:
            from xinas_menu.widgets.wizard import BACK

            self.dismiss(BACK)
```

In `on_button_pressed`, add a branch `if event.button.id == "btn-back": self.action_back(); return` before the existing OK/Cancel handling. Change the class declaration to `class DrivePickerScreen(ModalScreen["list[str] | object | None"]):`.

- [ ] **Step 7: Run smoke tests**

Run: `python -m pytest tests/test_wizard_dialogs.py -q`
Expected: PASS (6 passed).

- [ ] **Step 8: Lint**

Run: `ruff check xinas_menu/widgets/ tests/test_wizard_dialogs.py && ruff format --check xinas_menu/widgets/`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add xinas_menu/widgets/select_dialog.py xinas_menu/widgets/input_dialog.py \
        xinas_menu/widgets/confirm_dialog.py xinas_menu/widgets/drive_picker.py \
        tests/test_wizard_dialogs.py
git commit -m "feat(tui): allow_back + pre-selection on wizard dialogs"
```

---

## Task 3: NFS pure prefill/parse helpers

Extract the "which radio + input default" logic for the host step and the "mount vs custom" logic for the path step into pure module-level functions so they are headless-testable and reused by the step closures.

**Files:**
- Modify: `xinas_menu/screens/nfs.py` (add module-level helpers near the other module functions)
- Test: `tests/test_nfs_wizard_helpers.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_nfs_wizard_helpers.py
"""Pure prefill helpers for the NFS share wizard."""

from __future__ import annotations

from xinas_menu.screens.nfs import _host_prefill, _path_prefill

_HOST_CHOICES = [
    "Everyone (any host on the network)",
    "Specific network (e.g., 192.168.1.0/24)",
    "Single host (by IP address)",
]


def test_host_prefill_everyone():
    sel, hint = _host_prefill("*")
    assert sel == _HOST_CHOICES[0]
    assert hint == "Everyone"


def test_host_prefill_network():
    sel, hint = _host_prefill("192.168.1.0/24")
    assert sel == _HOST_CHOICES[1]
    assert hint == "Network 192.168.1.0/24"


def test_host_prefill_single():
    sel, hint = _host_prefill("10.0.0.5")
    assert sel == _HOST_CHOICES[2]
    assert hint == "Host 10.0.0.5"


def test_path_prefill_matches_mount():
    sel, default = _path_prefill("/mnt/data", ["/mnt/data", "/mnt/log"])
    assert sel == "/mnt/data"
    assert default == "/mnt/data/"  # custom default is unused when a mount matches


def test_path_prefill_custom_when_no_match():
    sel, default = _path_prefill("/mnt/data/share1", ["/mnt/data"])
    assert sel == "Custom path…"
    assert default == "/mnt/data/share1"


def test_path_prefill_empty():
    sel, default = _path_prefill("", ["/mnt/data"])
    assert sel is None
    assert default == "/mnt/data/"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_nfs_wizard_helpers.py -q`
Expected: FAIL — `ImportError: cannot import name '_host_prefill'`.

- [ ] **Step 3: Add the helpers to `nfs.py`**

Add near the top-level helper functions (e.g. just below the imports block, before `class NFSScreen`). Also define the shared choice list constants there:

```python
_HOST_CHOICES = [
    "Everyone (any host on the network)",
    "Specific network (e.g., 192.168.1.0/24)",
    "Single host (by IP address)",
]
_CUSTOM_PATH = "Custom path…"


def _host_prefill(host: str) -> tuple[str, str]:
    """Map a stored export host to (selected radio label, "(Current:)" hint)."""
    if host == "*":
        return _HOST_CHOICES[0], "Everyone"
    if "/" in host:
        return _HOST_CHOICES[1], f"Network {host}"
    return _HOST_CHOICES[2], f"Host {host}"


def _path_prefill(stored: str, mount_points: list[str]) -> tuple[str | None, str]:
    """Map a stored path to (SelectDialog pre-selection, custom-input default).

    Returns ``(mount, "/mnt/data/")`` when *stored* is one of *mount_points*,
    ``("Custom path…", stored)`` when it is a non-empty non-mount path, and
    ``(None, "/mnt/data/")`` when *stored* is empty (first entry).
    """
    if not stored:
        return None, "/mnt/data/"
    if stored in mount_points:
        return stored, "/mnt/data/"
    return _CUSTOM_PATH, stored
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_nfs_wizard_helpers.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add xinas_menu/screens/nfs.py tests/test_nfs_wizard_helpers.py
git commit -m "refactor(tui): extract pure NFS wizard prefill helpers"
```

---

## Task 4: Rewrite the NFS wizards on the driver

Replace `_access_wizard` with `_access_steps` (returns 5 `WizardStep`s) and rewrite `_add_share_wizard`/`_edit_share` to assemble a step list, call `run_wizard`, then dispatch. Behavior parity plus: Back navigation, remembered answers, and an empty host sub-input now returns to the host select instead of aborting.

**Files:**
- Modify: `xinas_menu/screens/nfs.py:118-544` (replace `_access_wizard`, `_add_share_wizard`, `_edit_share`)

- [ ] **Step 1: Add the wizard import**

At the top of `nfs.py`, with the other `xinas_menu.widgets` imports, add:

```python
from xinas_menu.widgets.wizard import BACK, CANCEL, WizardStep, run_wizard
```

- [ ] **Step 2: Replace `_access_wizard` (lines 120-297) with `_access_steps`**

```python
    # ── Shared access-control steps (host / perms / admin / sync / security) ──

    def _access_steps(self, prefix: str, total: int) -> list[WizardStep]:
        """Build the 5 shared access-control steps.

        Each step reads its working value from ``answers`` (retained across
        Back) and, when ``answers`` carries an ``_orig`` snapshot (Edit),
        annotates the prompt with the share's original value.
        """

        def title(step_no: int) -> str:
            return f"{prefix} — Step {step_no}/{total}"

        def orig(answers: dict) -> dict | None:
            return answers.get("_orig")

        async def host_step(answers, allow_back, step_no):
            while True:
                cur_host = answers.get("host", "*")
                selected, _ = _host_prefill(cur_host)
                prompt = "Who should be able to connect?"
                o = orig(answers)
                if o is not None:
                    _, hint = _host_prefill(o.get("host", "*"))
                    prompt += f"\n(Current: {hint})"
                who = await self.app.push_screen_wait(
                    SelectDialog(
                        _HOST_CHOICES,
                        title=title(step_no),
                        prompt=prompt,
                        selected=selected,
                        allow_back=allow_back,
                    )
                )
                if who is None:
                    return CANCEL
                if who is BACK:
                    return BACK
                if who.startswith("Everyone"):
                    return "*"
                if who.startswith("Specific"):
                    default = cur_host if "/" in cur_host else "192.168.1.0/24"
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Network address:",
                            title(step_no),
                            default=default,
                            placeholder="192.168.1.0/24",
                            allow_back=True,
                        )
                    )
                else:
                    default = cur_host if (cur_host != "*" and "/" not in cur_host) else ""
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Host IP address:",
                            title(step_no),
                            default=default,
                            placeholder="192.168.1.100",
                            allow_back=True,
                        )
                    )
                if sub is None:
                    return CANCEL
                if sub is BACK or not sub:
                    continue  # back to (or empty at) the who-select
                return sub

        access_choices = [
            "Read & Write (can add, edit, delete files)",
            "Read Only (can only view files)",
        ]
        admin_choices = [
            "Yes - Full admin access (recommended)",
            "No - Limited access (more secure)",
        ]
        sync_choices = [
            "Sync - confirm after writing to disk (safer, recommended)",
            "Async - confirm immediately (faster, risk of data loss on crash)",
        ]
        sec_choices = [
            "Standard UID/GID (default)",
            "Kerberos authentication",
            "Kerberos + integrity",
            "Kerberos + encryption",
        ]
        _SEC_MAP = {
            "Standard": "sys",
            "Kerberos authentication": "krb5",
            "Kerberos + integrity": "krb5i",
            "Kerberos + encryption": "krb5p",
        }
        _SEC_LABELS = {
            "sys": "Standard UID/GID",
            "krb5": "Kerberos",
            "krb5i": "Kerberos + integrity",
            "krb5p": "Kerberos + encryption",
        }

        def _sec_value(choice: str) -> str:
            for key, val in _SEC_MAP.items():
                if choice.startswith(key):
                    return val
            return "sys"

        steps: list[WizardStep] = [WizardStep(key="host", run=host_step)]

        async def access_run_fn(answers, allow_back, step_no):
            cur = answers.get("access", "rw")
            selected = access_choices[0] if cur == "rw" else access_choices[1]
            prompt = "What can connected hosts do?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Read & Write" if o.get("access") == "rw" else "Read Only"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(access_choices, title=title(step_no), prompt=prompt,
                             selected=selected, allow_back=allow_back)
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "rw" if pick.startswith("Read & Write") else "ro"

        async def admin_run_fn(answers, allow_back, step_no):
            cur = answers.get("root_squash", "no_root_squash")
            selected = admin_choices[0] if cur == "no_root_squash" else admin_choices[1]
            prompt = "Allow full administrator access?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Yes" if o.get("root_squash") == "no_root_squash" else "No"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(admin_choices, title=title(step_no), prompt=prompt,
                             selected=selected, allow_back=allow_back)
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "no_root_squash" if pick.startswith("Yes") else "root_squash"

        async def sync_run_fn(answers, allow_back, step_no):
            cur = answers.get("sync_mode", "sync")
            selected = sync_choices[0] if cur == "sync" else sync_choices[1]
            prompt = "When should the server confirm writes?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Sync (safer)" if o.get("sync_mode") == "sync" else "Async (faster)"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(sync_choices, title=title(step_no), prompt=prompt,
                             selected=selected, allow_back=allow_back)
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "sync" if pick.startswith("Sync") else "async"

        async def sec_run_fn(answers, allow_back, step_no):
            cur = answers.get("sec", "sys")
            selected = next((c for c in sec_choices if _sec_value(c) == cur), sec_choices[0])
            prompt = "Select authentication mode:"
            o = orig(answers)
            if o is not None:
                prompt += f"\n(Current: {_SEC_LABELS.get(o.get('sec'), o.get('sec'))})"
            pick = await self.app.push_screen_wait(
                SelectDialog(sec_choices, title=title(step_no), prompt=prompt,
                             selected=selected, allow_back=allow_back)
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return _sec_value(pick)

        steps.append(WizardStep(key="access", run=access_run_fn))
        steps.append(WizardStep(key="root_squash", run=admin_run_fn))
        steps.append(WizardStep(key="sync_mode", run=sync_run_fn))
        steps.append(WizardStep(key="sec", run=sec_run_fn))
        return steps
```

- [ ] **Step 3: Rewrite `_add_share_wizard`**

```python
    @work(exclusive=True)
    async def _add_share_wizard(self) -> None:
        """7-step share creation wizard with Back navigation."""
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd("findmnt", "-t", "xfs", "-n", "-o", "TARGET", timeout=10)
        if ok and out:
            mount_points = [line.strip() for line in out.splitlines() if line.strip()]

        async def path_step(answers, allow_back, step_no):
            stored = answers.get("path", "")
            title = f"Add Share — Step {step_no}/7"
            while True:
                if mount_points:
                    selected, custom_default = _path_prefill(stored, mount_points)
                    choice = await self.app.push_screen_wait(
                        SelectDialog(
                            mount_points + [_CUSTOM_PATH],
                            title=title,
                            prompt="Select filesystem to export (or choose custom for a subfolder):",
                            selected=selected,
                            allow_back=allow_back,
                        )
                    )
                    if choice is None:
                        return CANCEL
                    if choice is BACK:
                        return BACK
                    if choice == _CUSTOM_PATH:
                        sub = await self.app.push_screen_wait(
                            InputDialog(
                                "Export path:",
                                title,
                                default=custom_default,
                                placeholder="/mnt/data/share1",
                                allow_back=True,
                            )
                        )
                        if sub is None:
                            return CANCEL
                        if sub is BACK:
                            continue
                        path = sub
                    else:
                        path = choice
                else:
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Export path:",
                            title,
                            default=stored or "/mnt/data/",
                            placeholder="/mnt/data/share1",
                            allow_back=allow_back,
                        )
                    )
                    if sub is None:
                        return CANCEL
                    if sub is BACK:
                        return BACK
                    path = sub
                if not path.startswith("/"):
                    self.app.notify("Export path must start with '/'.", severity="error")
                    continue
                return path.rstrip("/") or "/"

        async def confirm_step(answers, allow_back, step_no):
            host = answers["host"]
            access = answers["access"]
            root_squash = answers["root_squash"]
            sync_mode = answers["sync_mode"]
            sec = answers["sec"]
            options = [access, sync_mode, "no_subtree_check", root_squash]
            if sec != "sys":
                options.append(f"sec={sec}")
            summary = _share_summary(answers["path"], host, access, root_squash, sync_mode, sec, options)
            result = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Create this export?\n\n{summary}",
                    f"Add Share — Step {step_no}/7",
                    allow_back=allow_back,
                )
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = (
            [WizardStep(key="path", run=path_step)]
            + self._access_steps("Add Share", total=7)
            + [WizardStep(key="confirmed", run=confirm_step)]
        )
        answers = await run_wizard(steps)
        if answers is None:
            return

        path = answers["path"]
        host = answers["host"]
        access = answers["access"]
        root_squash = answers["root_squash"]
        sync_mode = answers["sync_mode"]
        sec = answers["sec"]

        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, lambda: os.makedirs(path, exist_ok=True))
        except OSError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Cannot create directory:\n{exc}", "Error"))
            return

        used: set[int] = set()
        for row in await self._get_exports():
            fsid = row.get("fsid")
            if isinstance(fsid, int):
                used.add(fsid)
            elif isinstance(fsid, str) and fsid.strip().lstrip("-").isdigit():
                used.add(int(fsid))
        spec: dict[str, Any] = {
            "path": path,
            "fsid": max(used, default=0) + 1,
            "clients": [{"pattern": host, "options": [access, root_squash, "no_subtree_check"]}],
            "sync": sync_mode,
        }
        if sec != "sys":
            spec["security_mode"] = sec
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/shares",
                spec,
                on_progress=self._task_progress("Add Share"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {exc}", "Error"))
            return
        self.app.audit.log("nfs.add_export", path, "OK")
        await self.app.snapshots.record("share_create", diff_summary=f"Added NFS share {path}")
        self._load_exports()
```

- [ ] **Step 4: Add the shared summary helper near the module helpers**

```python
def _share_summary(path, host, access, root_squash, sync_mode, sec, options) -> str:
    access_label = "Read & Write" if access == "rw" else "Read Only"
    admin_label = "Yes (no_root_squash)" if root_squash == "no_root_squash" else "No (root_squash)"
    sync_label = "Sync (safer)" if sync_mode == "sync" else "Async (faster)"
    sec_labels = {
        "sys": "Standard UID/GID",
        "krb5": "Kerberos",
        "krb5i": "Kerberos + integrity",
        "krb5p": "Kerberos + encryption",
    }
    return (
        f"Path:       {path}\n"
        f"Access:     {host}\n"
        f"Permission: {access_label}\n"
        f"Admin:      {admin_label}\n"
        f"Sync:       {sync_label}\n"
        f"Security:   {sec_labels.get(sec, sec)}\n"
        f"Options:    {','.join(options)}"
    )
```

- [ ] **Step 5: Rewrite `_edit_share`**

```python
    @work(exclusive=True)
    async def _edit_share(self) -> None:
        """7-step edit share wizard with Back navigation."""
        exports = await self._get_exports()
        if not exports:
            await self.app.push_screen_wait(ConfirmDialog("No shares configured.", "Edit Share"))
            return
        paths = [e["path"] for e in exports]

        async def select_step(answers, allow_back, step_no):
            choice = await self.app.push_screen_wait(
                SelectDialog(
                    paths,
                    title=f"Edit Share — Step {step_no}/7",
                    prompt="Select export to edit:",
                    selected=answers.get("path"),
                    allow_back=allow_back,
                )
            )
            if choice is None:
                return CANCEL
            if choice is BACK:
                return BACK
            if choice != answers.get("path"):
                export = next((e for e in exports if e["path"] == choice), {})
                share_id = str(export.get("id", ""))
                if not share_id:
                    await self.app.push_screen_wait(ConfirmDialog("Share not found.", "Edit Share"))
                    return CANCEL
                current = _parse_current_export(export)
                answers["_orig"] = current
                answers["share_id"] = share_id
                for k in ("host", "access", "root_squash", "sync_mode", "sec"):
                    answers[k] = current[k]
            return choice

        async def confirm_step(answers, allow_back, step_no):
            host = answers["host"]
            access = answers["access"]
            root_squash = answers["root_squash"]
            sync_mode = answers["sync_mode"]
            sec = answers["sec"]
            extra = answers["_orig"]["extra_opts"]
            options = [access, sync_mode, root_squash]
            if sec != "sys":
                options.append(f"sec={sec}")
            options.extend(extra)
            summary = _share_summary(answers["path"], host, access, root_squash, sync_mode, sec, options)
            result = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Update this export?\n\n{summary}",
                    f"Edit Share — Step {step_no}/7",
                    allow_back=allow_back,
                )
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = (
            [WizardStep(key="path", run=select_step)]
            + self._access_steps("Edit Share", total=7)
            + [WizardStep(key="confirmed", run=confirm_step)]
        )
        answers = await run_wizard(steps)
        if answers is None:
            return

        host = answers["host"]
        access = answers["access"]
        root_squash = answers["root_squash"]
        sync_mode = answers["sync_mode"]
        sec = answers["sec"]
        share_id = answers["share_id"]
        extra = answers["_orig"]["extra_opts"]

        patch: dict[str, Any] = {
            "clients": [{"pattern": host, "options": [access, root_squash, *extra]}],
            "sync": sync_mode,
            "security_mode": sec,
        }
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/shares/{share_id}",
                patch,
                on_progress=self._task_progress("Edit Share"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {exc}", "Error"))
            return
        self.app.audit.log("nfs.update_export", answers["path"], "OK")
        await self.app.snapshots.record("share_modify", diff_summary=f"Updated NFS share {answers['path']}")
        self._load_exports()
```

- [ ] **Step 6: Run the full suite + lint**

Run: `python -m pytest tests/ -q && ruff check xinas_menu/screens/nfs.py && ruff format --check xinas_menu/screens/nfs.py`
Expected: all pass; no lint errors. (Existing tests `test_render_nfs_profile.py` must still pass.)

- [ ] **Step 7: Manual smoke (headless import)**

Run: `python -c "import xinas_menu.screens.nfs"`
Expected: no error (guards against a syntax/NameError in the rewrite).

- [ ] **Step 8: Commit**

```bash
git add xinas_menu/screens/nfs.py
git commit -m "feat(tui): Back navigation for Add/Edit Share wizards"
```

---

## Task 5: Rewrite the Create Array wizard on the driver

Rewrite `_create_array_wizard` to fetch disks/pools up front, build a step list (with `applies` predicates for group-size and spare-pool), call `run_wizard`, then assemble the spec and dispatch. RAID titles switch to driver-computed `Create Array — Step N`. Two benign, documented behavior changes: the "no NVMe drives" check now runs before the name prompt, and `Esc` on the strip step cancels (as every other step) instead of silently defaulting to 64 — the strip dialog pre-selects `64` so Enter still yields 64.

**Files:**
- Modify: `xinas_menu/screens/raid.py:396-609` (`_create_array_wizard`) and imports.

- [ ] **Step 1: Add the wizard import**

With the other `xinas_menu.widgets` imports in `raid.py`:

```python
from xinas_menu.widgets.wizard import BACK, CANCEL, WizardStep, run_wizard
```

- [ ] **Step 2: Replace `_create_array_wizard` (lines 396-609)**

```python
    @work(exclusive=True)
    async def _create_array_wizard(self) -> None:
        """Create-array wizard with Back navigation."""
        # Fetch disks up front so the drive + spare steps and their applies()
        # predicates have their data; fail fast if there are no NVMe drives.
        try:
            disk_rows = await _list_api_disks(self.app.control)
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Could not list disks.\n{exc}", "Error"))
            return
        groups, nvme = _drive_groups(disk_rows)
        if not nvme:
            await self.app.push_screen_wait(ConfirmDialog("No available NVMe drives found.", "Error"))
            return
        name_to_id = {d["name"]: d["id"] for d in nvme}

        _NONE_POOL = "(none)"
        try:
            p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
        except ControlPathError:
            p_rows = []
        pools = _pools_by_name(p_rows)

        async def name_step(answers, allow_back, step_no):
            default = answers.get("name", "")
            while True:
                name = await self.app.push_screen_wait(
                    InputDialog(
                        "Array name:",
                        f"Create Array — Step {step_no}",
                        default=default,
                        placeholder="data0",
                        allow_back=allow_back,
                    )
                )
                if name is None:
                    return CANCEL
                if name is BACK:
                    return BACK
                if len(name) > 64:
                    self.app.notify("Array name must be 64 characters or fewer.", severity="error")
                    default = name
                    continue
                if not _ARRAY_NAME_RE.match(name):
                    self.app.notify(
                        "Array name must contain only letters, digits, hyphens, and underscores.",
                        severity="error",
                    )
                    default = name
                    continue
                return name

        async def level_step(answers, allow_back, step_no):
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    _RAID_LEVELS,
                    title=f"Create Array — Step {step_no}",
                    prompt="Select RAID level:",
                    selected=answers.get("level"),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def drives_step(answers, allow_back, step_no):
            prior = answers.get("drives")
            if prior:
                # Re-entry: jump straight to the picker with the prior selection.
                selected = await self.app.push_screen_wait(
                    DrivePickerScreen(
                        nvme, title="Create Array — Select Drives",
                        preselected=prior, allow_back=allow_back,
                    )
                )
                if selected is None:
                    return CANCEL
                if selected is BACK:
                    return BACK
                return selected
            while True:
                choices = list(groups.keys()) + ["Pick individual drives"]
                group_choice = await self.app.push_screen_wait(
                    SelectDialog(
                        choices, title=f"Create Array — Step {step_no}",
                        prompt="Select drive group:", allow_back=allow_back,
                    )
                )
                if group_choice is None:
                    return CANCEL
                if group_choice is BACK:
                    return BACK
                if group_choice == "Pick individual drives":
                    selected = await self.app.push_screen_wait(
                        DrivePickerScreen(nvme, title="Create Array — Select Drives", allow_back=True)
                    )
                else:
                    group_drives = groups.get(group_choice, [])
                    group_names = {d if isinstance(d, str) else d.get("name", "") for d in group_drives}
                    group_drive_info: list[dict[str, Any]] = [
                        d for d in nvme if d.get("name") in group_names
                    ] or group_drives  # pyright: ignore[reportAssignmentType]
                    selected = await self.app.push_screen_wait(
                        DrivePickerScreen(
                            group_drive_info, title=f"Review — {group_choice}",
                            preselected=group_names, allow_back=True,
                        )
                    )
                if selected is None:
                    return CANCEL
                if selected is BACK:
                    continue  # back to the group select
                if not selected:
                    await self.app.push_screen_wait(ConfirmDialog("No drives selected.", "Error"))
                    continue
                return selected

        async def strip_step(answers, allow_back, step_no):
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    _STRIP_SIZES,
                    title=f"Create Array — Step {step_no}",
                    prompt="Strip size (KB), default 64:",
                    selected=answers.get("strip", "64"),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def group_size_step(answers, allow_back, step_no):
            default = str(answers.get("group_size", ""))
            while True:
                value = await self.app.push_screen_wait(
                    InputDialog(
                        "Group size (required for RAID 50/60):",
                        f"Create Array — Step {step_no}",
                        default=default,
                        placeholder="4",
                        allow_back=allow_back,
                    )
                )
                if value is None:
                    return CANCEL
                if value is BACK:
                    return BACK
                try:
                    gs = int(value)
                    if gs <= 0:
                        raise ValueError
                except ValueError:
                    self.app.notify("Group size must be a positive integer.", severity="error")
                    default = value
                    continue
                return gs

        async def spare_step(answers, allow_back, step_no):
            pool_choices = [_NONE_POOL] + sorted(pools.keys())
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    pool_choices,
                    title=f"Create Array — Step {step_no}",
                    prompt="Select spare pool (or none):",
                    selected=answers.get("spare", _NONE_POOL),
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return pick

        async def confirm_step(answers, allow_back, step_no):
            summary = (
                f"Name:       {answers['name']}\n"
                f"Level:      RAID-{answers['level']}\n"
                f"Drives:     {', '.join(answers['drives'])}\n"
                f"Strip Size: {answers['strip']} KB"
            )
            if answers["level"] in ("50", "60"):
                summary += f"\nGroup Size: {answers.get('group_size')}"
            spare = answers.get("spare", _NONE_POOL)
            if spare != _NONE_POOL:
                summary += f"\nSpare Pool: {spare}"
            result = await self.app.push_screen_wait(
                ConfirmDialog(f"Create this RAID array?\n\n{summary}", "Confirm Create", allow_back=allow_back)
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = [
            WizardStep(key="name", run=name_step),
            WizardStep(key="level", run=level_step),
            WizardStep(key="drives", run=drives_step),
            WizardStep(key="strip", run=strip_step),
            WizardStep(
                key="group_size", run=group_size_step,
                applies=lambda a: a.get("level") in ("50", "60"),
            ),
            WizardStep(key="spare", run=spare_step, applies=lambda a: bool(pools)),
            WizardStep(key="confirmed", run=confirm_step),
        ]
        answers = await run_wizard(steps)
        if answers is None:
            return

        # Assemble the API spec from the collected answers.
        drives = answers["drives"]
        spec: dict[str, Any] = {
            "name": answers["name"],
            "level": f"raid{answers['level']}",
            "member_disk_ids": [name_to_id.get(n, n) for n in drives],
            "strip_size_kib": int(answers["strip"]),
        }
        if answers["level"] in ("50", "60"):
            spec["group_size"] = int(answers["group_size"])
        spare = answers.get("spare", _NONE_POOL)
        if spare != _NONE_POOL:
            path_to_id = {d["device_path"]: d["id"] for d in disk_rows}
            spare_ids = [
                path_to_id.get(p, p.rsplit("/", 1)[-1])
                for p in _pool_drive_paths(pools.get(spare, {}))
            ]
            if spare_ids:
                spec["spare_disk_ids"] = spare_ids
            else:
                self.app.notify(
                    f"Pool '{spare}' has no drives — skipping spare assignment.",
                    severity="warning",
                )

        dialog = TaskWaitDialog(f"Creating RAID array '{answers['name']}'…", "Create Array")
        self.app.push_screen(dialog)
        cancelled = False
        error: ControlPathError | None = None
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/arrays",
                spec,
                on_progress=dialog.progress_from_thread(self.app),
                cancel_check=dialog.cancel_requested,
            )
        except TaskCancelled:
            cancelled = True
        except ControlPathError as exc:
            error = exc
        finally:
            dialog.dismiss(None)
        if cancelled:
            await self.app.push_screen_wait(
                ConfirmDialog("Create cancelled — partial work rolled back.", "Cancelled", ok_only=True)
            )
            return
        if error is not None:
            await self.app.push_screen_wait(ConfirmDialog(f"Create failed.\n{error}", "Error"))
            return
        self.app.audit.log(
            "raid.create", f"{answers['name']} RAID-{answers['level']} ({len(drives)} drives)", "OK"
        )
        await self.app.snapshots.record(
            "raid_create",
            diff_summary=f"Created RAID-{answers['level']} array '{answers['name']}' with {len(drives)} drives",
        )
        self._show_quick()
```

- [ ] **Step 3: Run the full suite + lint + import smoke**

Run: `python -m pytest tests/ -q && ruff check xinas_menu/screens/raid.py && ruff format --check xinas_menu/screens/raid.py && python -c "import xinas_menu.screens.raid"`
Expected: all pass; no lint errors; import clean.

- [ ] **Step 4: Commit**

```bash
git add xinas_menu/screens/raid.py
git commit -m "feat(tui): Back navigation for Create Array wizard"
```

---

## Task 6: Update the specs

**Files:**
- Modify: `docs/Storage/fs-shares-management-spec.md`, `docs/Storage/raid-management-spec.md`

- [ ] **Step 1: fs-shares spec** — Add a "Wizard navigation model" subsection (before §4.3) describing: the `run_wizard` driver (`xinas_menu/widgets/wizard.py`), the `BACK`/`CANCEL` sentinels, `allow_back` on the dialogs, `selected` pre-selection, and that answers are retained across Back. Update §4.3 to describe `_access_steps` (replacing `_access_wizard`) returning a `list[WizardStep]` reused by Add and Edit, reading prefill from `answers` and the "(Current:)" hint from `answers["_orig"]`. Update §4.4 to note the path step is step 1, the Back button appears on steps 2–7, the confirm step can Back, and the empty-host-input-returns-to-select behavior.

- [ ] **Step 2: raid spec** — Update §4 to describe: disks and pools fetched up front (the "no NVMe drives" check now precedes the name prompt); driver-computed `Create Array — Step N` titles; group-size and spare-pool as conditional steps (`applies` predicates) that Back skips in both directions; the drives step re-entry opening the picker directly with `preselected`; and `Esc` on strip now cancelling (dialog pre-selects `64`).

- [ ] **Step 3: Commit**

```bash
git add docs/Storage/fs-shares-management-spec.md docs/Storage/raid-management-spec.md
git commit -m "docs(storage): spec Back navigation for share and RAID wizards"
```

---

## Self-Review

**Spec coverage:** driver (Task 1) ✓; dialog Back + pre-select (Task 2) ✓; state retention (driver + `selected`/`default`/`preselected`) ✓; NFS Add/Edit rewrite incl. cross-boundary Back (Task 4) ✓; RAID rewrite incl. conditional steps (Task 5) ✓; spec updates (Task 6) ✓; no `Requires-Rebuild` (Python-only) ✓.

**Placeholder scan:** none — every code step carries full, runnable code; no TBD/TODO/"handle edge cases" prose.

**Type consistency:** `run_wizard`, `WizardStep`, `BACK`, `CANCEL` are used identically across Tasks 1/4/5. Dialog params `allow_back` (kw-only bool) and `SelectDialog.selected` match between Task 2 definitions and Task 4/5 call sites. Helper names `_host_prefill`/`_path_prefill`/`_share_summary`/`_HOST_CHOICES`/`_CUSTOM_PATH` are defined in Task 3/4 and used consistently. `_parse_current_export` keys (`host`,`access`,`root_squash`,`sync_mode`,`sec`,`extra_opts`) match the seeding in `select_step` and the dispatch reads.
</content>
