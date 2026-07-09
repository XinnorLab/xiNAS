# TUI Task-Failure Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a control-path task fails, the TUI shows the failing stage's actual error message (e.g. `preflight: /mnt/data is already a live mountpoint`), wraps long error text in dialogs instead of truncating, and only offers "Retry with force?" on fs.create when the failure really is the existing-filesystem destruction gate.

**Architecture:** `ControlClient.plan_apply_wait` already polls `GET /api/v1/tasks/{id}`, whose response carries the task row (`error_message` set on `FAILED_BEFORE_CHANGE` / `FAILED_MANUAL_RECOVERY_REQUIRED` terminals) and the rolled-up `stages[]` (each with `status` / `name` / `error_message` — the only place the detail lives on the common `FAILED_PARTIAL_ROLLED_BACK` path, because the agent's terminal event carries no message there; see `xiNAS-MCP/src/agent/task/runner.ts` `#runRollback`). The fix extracts that detail at raise time and carries it on `TaskFailed`; screens render `{exc}` unchanged and get the detail for free. `ConfirmDialog`'s `#dialog-body` label gets `width: 100%` so Rich wraps at the container width. `filesystem.py` gates the force retry on the fs-executor destruction-gate message.

**Tech Stack:** Python 3.10+, Textual 8.2.x, pytest (stub UDS HTTP server for client tests, Textual pilot for the dialog test). Python-TUI-only change — **no `Requires-Rebuild:` trailer**.

---

### Task 1: Spec updates (spec-first rule)

**Files:**
- Modify: `docs/control-path/s8-clients-spec.md` (T10 bullet block, after the Lock-conflict UX paragraph)
- Modify: `docs/Storage/fs-shares-management-spec.md` (§3.3 execute portion, §5.1 trace, §7 table, §9 conventions)

- [ ] **Step 1: s8-clients-spec.md — add Task-failure detail contract**

After the existing **Lock-conflict UX** paragraph (which ends "…keep the existing `Failed: <exc>` rendering."), insert:

```markdown
**Task-failure detail.** `plan_apply_wait` polls `GET /tasks/{id}`; when
the terminal state is non-success it raises `TaskFailed` carrying, besides
`task_id` / `state` / `error_code`, an `error_message` with the best
human-readable cause from the final task record: the task row's
`error_message` when set (the `FAILED_BEFORE_CHANGE` /
`FAILED_MANUAL_RECOVERY_REQUIRED` terminals), else the first failed
non-rollback stage's `error_message` (the stage-failure path — a
`FAILED_PARTIAL_ROLLED_BACK` terminal carries no task-level message,
s2-task-envelope-spec §6), else a failed rollback stage's message. The
stage name is prefixed when the message doesn't already start with it
(`preflight: …`). `str(exc)` includes the detail —
`task <id> ended failed (FAILED_PARTIAL_ROLLED_BACK): preflight: /mnt/data
is already a live mountpoint` — so every screen that renders
`Failed: <exc>` shows the cause without code changes. `TaskCancelled`
carries the same field (usually empty — a cancelled terminal has no
error).
```

- [ ] **Step 2: fs-shares-management-spec.md §3.3 — rewrite the execute portion**

Replace the block from "**Step 5 — confirmation.** Summary shows everything: …" through the "…justify the complexity." paragraph with:

```markdown
**Step 5 — confirmation.** Summary shows everything: arrays + roles, mountpoint, derived geometry, full mount option string. On confirm the screen submits **one control-path plan→apply** — `POST /api/v1/filesystems` with the full spec (backing/log device, label, mountpoint, geometry, mount options, `quota_mode: uquota`) via `control.plan_apply_wait`, with a `TaskWaitDialog` showing task-state progress and offering cancel (S10).

**Failure handling.** Three distinct exits:

1. **Cancelled** (`TaskCancelled`, caught before `TaskFailed` — it is a subclass): the view reports "cancelled — partial work rolled back"; no retry is offered.
2. **Destruction gate** (`TaskFailed` whose `error_message` is the fs-executor preflight gate — the device `already carries a … filesystem`, `xiNAS-MCP/src/agent/task/fs-executor.ts`): the screen offers the **force-recreate consent** — a Yes/No dialog quoting the task's failure detail and warning that retrying with `force: true` DESTROYS the existing data. On Yes it re-submits the same spec with `force: true` and `dangerous=True`. This is the *only* failure that offers the retry.
3. **Any other failure** (`TaskFailed` with any other detail — live mountpoint, existing unit, mkfs/mount error — or `PlanBlocked` / `ApiError` / `TransportError`): an OK-only error dialog shows `Filesystem creation failed:` plus the exception text, which includes the failing stage's message (see [s8-clients-spec §S8c T10](../control-path/s8-clients-spec.md)). No force retry is offered — retrying with force cannot fix, say, an occupied mountpoint, and offering it trains operators to click through a destructive consent.

Cross-step rollback is the executor's own (task-level rollback per stage failure); the screen performs no cleanup of its own.
```

- [ ] **Step 3: fs-shares-management-spec.md §5.1 — retarget the trace**

Replace the trace lines from `├─ check_existing_filesystem(/dev/xi_<name>)` through `│    └─ systemctl enable --now <unit>` with:

```
  ├─ control.plan_apply_wait(POST /api/v1/filesystems)   — ONE plan→apply
  │    ├─ mode=plan  → plan_id, blockers checked
  │    ├─ mode=apply → task_id
  │    └─ poll GET /tasks/{id} → preflight → mkfs → unit → mount stages
  │         └─ on failed terminal: TaskFailed carries the failing
  │            stage's error_message (force retry ONLY on the
  │            existing-filesystem destruction gate)
```

- [ ] **Step 4: fs-shares-management-spec.md §7 — replace the two stale create-failure rows**

Replace the `mkfs.xfs fails…` row of the table with:

```markdown
| fs.create task fails (live mountpoint, existing unit, mkfs error, log array too small) | control-path task terminal | `TaskFailed.error_message` carries the failing stage's message; an OK-only dialog shows it. **No force retry** unless the failure is the existing-filesystem destruction gate. |
| fs.create fails on the destruction gate (device already carries a filesystem) | fs-executor preflight (`blkid` gate) | Yes/No force-recreate consent quoting the task detail; on Yes the spec is re-submitted with `force: true` + `dangerous=True`. |
```

(Keep the `Mount unit fails to start…` row — it still describes the on-disk unit semantics.)

- [ ] **Step 5: fs-shares-management-spec.md §9 — add the wrap convention**

Append a third bullet:

```markdown
- **Long dialog text wraps, never truncates.** `#dialog-body` is
  width-constrained to the dialog container, so Rich wraps long error
  lines (task ids + stage messages easily exceed the 80-cell dialog).
  Truncation hid the tail of exactly the text the operator needed
  (`FAILED_PARTIAL_ROL…`).
```

- [ ] **Step 6: Verify spec renders** — `grep -n "Task-failure detail" docs/control-path/s8-clients-spec.md` and re-read the edited §3.3 for coherence.

### Task 2: `TaskFailed` carries the failure detail (TDD)

**Files:**
- Modify: `xinas_menu/api/control_client.py:99-106` (TaskFailed), `:290-311` (raise sites), new module function `_failure_detail`
- Test: `tests/test_control_client.py`

- [ ] **Step 1: Write the failing tests** (append to `tests/test_control_client.py`)

```python
def _failed_task_routes(task_payload: dict) -> None:
    posts = {"n": 0}

    def fs_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (200, {"result": {"plan_id": "p1", "blockers": []}})
        return (202, {"result": {"task_id": "t3", "state": "queued"}})

    ROUTES[("POST", "/api/v1/filesystems")] = fs_post
    ROUTES[("GET", "/api/v1/tasks/t3")] = (200, {"result": task_payload})


def test_task_failed_carries_failing_stage_detail(stub_socket):
    """FAILED_PARTIAL_ROLLED_BACK terminals carry no task-level
    error_message; the detail lives on the failed stage row."""
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_PARTIAL_ROLLED_BACK",
            "stages": [
                {"name": "snapshot_before", "status": "success"},
                {
                    "name": "preflight",
                    "status": "failed",
                    "error_message": "preflight: /mnt/data is already a live mountpoint (/dev/sda1)",
                },
                {"name": "rollback", "status": "success"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == (
        "preflight: /mnt/data is already a live mountpoint (/dev/sda1)"
    )
    assert "already a live mountpoint" in str(err.value)
    assert "FAILED_PARTIAL_ROLLED_BACK" in str(err.value)


def test_task_failed_prefers_task_level_error_message(stub_socket):
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_BEFORE_CHANGE",
            "error_message": "executor rejected the spec",
            "stages": [
                {"name": "preflight", "status": "failed", "error_message": "stage detail"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "executor rejected the spec"


def test_task_failed_stage_detail_gets_stage_name_prefix(stub_socket):
    """A stage message that doesn't already start with the stage name is
    prefixed with it, so bare executor errors keep their context."""
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_PARTIAL_ROLLED_BACK",
            "stages": [
                {"name": "mount", "status": "failed", "error_message": "unit failed to start"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "mount: unit failed to start"


def test_task_failed_falls_back_to_rollback_stage_detail(stub_socket):
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "requires_manual_recovery",
            "error_code": "FAILED_MANUAL_RECOVERY_REQUIRED",
            "stages": [
                {"name": "rollback", "status": "failed", "error_message": "rollback: umount busy"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "rollback: umount busy"


def test_task_failed_without_detail_keeps_legacy_message(stub_socket):
    _failed_task_routes({"task_id": "t3", "state": "failed", "error_code": "BOOM"})
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message is None
    assert str(err.value) == "task t3 ended failed (BOOM)"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_control_client.py -k "task_failed" -v`
Expected: FAIL — `TaskFailed.__init__` takes no detail; `error_message` attribute missing.

- [ ] **Step 3: Implement in `control_client.py`**

Replace the `TaskFailed` class:

```python
class TaskFailed(ControlPathError):
    """The apply task ended in a non-success terminal state.

    ``error_message`` is the best human-readable cause pulled from the
    final task record (see :func:`_failure_detail`); ``str(exc)`` includes
    it so screens that render ``Failed: {exc}`` surface the failing
    stage's message without any change.
    """

    def __init__(
        self,
        task_id: str,
        state: str,
        error_code: str | None,
        error_message: str | None = None,
    ) -> None:
        text = f"task {task_id} ended {state} ({error_code or 'no error code'})"
        if error_message:
            text = f"{text}: {error_message}"
        super().__init__(text)
        self.task_id = task_id
        self.state = state
        self.error_code = error_code
        self.error_message = error_message
```

Add after `lease_conflict_message`:

```python
def _failure_detail(task: dict[str, Any]) -> str | None:
    """Best human-readable failure cause from a terminal task record.

    The task row's ``error_message`` is set on FAILED_BEFORE_CHANGE /
    FAILED_MANUAL_RECOVERY_REQUIRED terminals; on the common stage-failure
    path (FAILED_PARTIAL_ROLLED_BACK) the agent's terminal event carries no
    message and the detail lives only on the failed stage row
    (s2-task-envelope-spec §6). Preference: task row → first failed
    non-rollback stage → failed rollback stage. The stage name is prefixed
    when the message doesn't already carry it.
    """
    message = task.get("error_message")
    if isinstance(message, str) and message:
        return message
    stages = task.get("stages")
    if not isinstance(stages, list):
        return None
    failed = [
        s
        for s in stages
        if isinstance(s, dict)
        and s.get("status") == "failed"
        and isinstance(s.get("error_message"), str)
        and s.get("error_message")
    ]
    ordered = [s for s in failed if s.get("name") != "rollback"] or failed
    if not ordered:
        return None
    stage = ordered[0]
    text = str(stage["error_message"])
    name = stage.get("name")
    if isinstance(name, str) and name and not text.startswith(name):
        return f"{name}: {text}"
    return text
```

In `plan_apply_wait`, change the two terminal raises:

```python
                if state == "cancelled":
                    raise TaskCancelled(
                        task_id, state, current.get("error_code"), _failure_detail(current)
                    )
                if state != "success":
                    raise TaskFailed(
                        task_id, state, current.get("error_code"), _failure_detail(current)
                    )
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_control_client.py -v`
Expected: ALL PASS (including the pre-existing tests — the signature change is backward compatible).

### Task 3: `ConfirmDialog` wraps long lines (TDD)

**Files:**
- Modify: `xinas_menu/styles.tcss:196-199` (`#dialog-body`)
- Test: `tests/test_wizard_dialogs.py`

- [ ] **Step 1: Write the failing pilot test** (append to `tests/test_wizard_dialogs.py`)

```python
def test_confirm_dialog_wraps_long_error_lines():
    """A long single-line error (task id + stage message) must wrap inside
    the dialog container, not render one clipped line (the
    'FAILED_PARTIAL_ROL…' truncation)."""
    import asyncio
    from pathlib import Path

    from textual.app import App

    long_msg = (
        "Filesystem creation failed:\n"
        "task 0b0778a9-1234-5678-9abc-def012345678 ended failed "
        "(FAILED_PARTIAL_ROLLED_BACK): preflight: /mnt/data is already "
        "a live mountpoint (/dev/mapper/something-long)"
    )

    class _Shell(App):
        CSS_PATH = Path(__file__).parent.parent / "xinas_menu" / "styles.tcss"

    async def scenario() -> None:
        app = _Shell()
        async with app.run_test(size=(100, 32)) as pilot:
            dialog = ConfirmDialog(long_msg, "⚠ Create Failed", ok_only=True)
            app.push_screen(dialog)
            await pilot.pause()
            body = dialog.query_one("#dialog-body")
            container = dialog.query_one("#dialog-container")
            # Constrained to the container (not overflowing off-dialog)…
            assert body.region.width <= container.region.width
            # …and the >76-cell line occupies multiple rows, i.e. wrapped.
            assert body.region.height >= 3

    asyncio.run(scenario())
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_wizard_dialogs.py -v`
Expected: FAIL on the height assertion (unwrapped label renders each `\n` line at height 1 per line but the long line stays 1 row → total 2 rows, clipped).

- [ ] **Step 3: Constrain `#dialog-body`** in `xinas_menu/styles.tcss`:

```tcss
#dialog-body {
    color: #999999;
    margin-bottom: 1;
    width: 100%;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_wizard_dialogs.py -v`
Expected: PASS.

### Task 4: Gate the force retry in `filesystem.py` (TDD)

**Files:**
- Modify: `xinas_menu/screens/filesystem.py` (module-level predicate + `_create_filesystem` TaskFailed handler at :491-523)
- Test: `tests/test_fs_create_failure_gate.py` (create)

- [ ] **Step 1: Write the failing test**

```python
"""fs.create force-retry gating: the ⚠ Create Failed / "Retry with force?"
consent must appear ONLY when the task failed on the fs-executor's
existing-filesystem destruction gate — not on every TaskFailed."""

from xinas_menu.api.control_client import TaskFailed
from xinas_menu.screens.filesystem import _is_existing_fs_gate


def _failed(detail: str | None) -> TaskFailed:
    return TaskFailed("t1", "failed", "FAILED_PARTIAL_ROLLED_BACK", detail)


def test_destruction_gate_failure_offers_force_retry():
    exc = _failed(
        "preflight: /dev/xi_data already carries a xfs filesystem "
        "(label 'nfsdata') — re-plan with force: true to overwrite"
    )
    assert _is_existing_fs_gate(exc) is True


def test_live_mountpoint_failure_does_not_offer_force_retry():
    exc = _failed("preflight: /mnt/data is already a live mountpoint (/dev/sda1)")
    assert _is_existing_fs_gate(exc) is False


def test_unit_exists_failure_does_not_offer_force_retry():
    exc = _failed("preflight: unit mnt-data.mount already exists on disk")
    assert _is_existing_fs_gate(exc) is False


def test_detail_free_failure_does_not_offer_force_retry():
    assert _is_existing_fs_gate(_failed(None)) is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_fs_create_failure_gate.py -v`
Expected: FAIL — `ImportError: cannot import name '_is_existing_fs_gate'`.

- [ ] **Step 3: Implement the predicate** (module level in `filesystem.py`, near the other module constants)

```python
# The fs-executor's destruction-gate preflight message
# (xiNAS-MCP/src/agent/task/fs-executor.ts): the ONLY fs.create failure
# where a force retry is the documented remedy. Matched on the message
# because the task-level error_code is the generic
# FAILED_PARTIAL_ROLLED_BACK shared by every stage failure.
_EXISTING_FS_GATE_MARKER = "already carries a"


def _is_existing_fs_gate(exc: TaskFailed) -> bool:
    """True only for the existing-filesystem destruction-gate failure."""
    return _EXISTING_FS_GATE_MARKER in (exc.error_message or "")
```

- [ ] **Step 4: Wire the gate into `_create_filesystem`** — replace the `except TaskFailed as exc:` block body (filesystem.py:491-523) with:

```python
        except TaskFailed as exc:
            create_dialog.dismiss(None)
            # Force retry is offered ONLY on the executor's destruction
            # gate (an existing filesystem on the device); any other stage
            # failure gets the plain error dialog — force cannot fix a
            # live mountpoint or an existing unit, and offering it there
            # trains users to click through a destructive consent.
            if not _is_existing_fs_gate(exc):
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Filesystem creation failed:\n\n{exc}", "Error", ok_only=True)
                )
                view.set_content("\033[31m  Filesystem creation failed.\033[0m")
                return
            warn_confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Filesystem creation failed:\n{exc}\n\n"
                    f"{data_device} already carries a filesystem. Retrying "
                    f"with force will DESTROY all existing data on it.\n\n"
                    f"Retry with force?",
                    "⚠ Create Failed",
                )
            )
            if not warn_confirmed:
                view.set_content("\033[31m  Filesystem creation failed.\033[0m")
                return
            view.set_content(f"  Re-creating with force on {data_device}...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "POST",
                    "/api/v1/filesystems",
                    {**spec, "force": True},
                    dangerous=True,
                    on_progress=self._task_progress("Create Filesystem"),
                )
            except ControlPathError as exc2:
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Filesystem creation failed:\n\n{exc2}", "Error", ok_only=True)
                )
                view.set_content("\033[31m  Filesystem creation failed.\033[0m")
                return
```

(The conditional wording replaces the old "If {device} already carries a filesystem…" hedge — the gate is now confirmed before the dialog appears.)

- [ ] **Step 5: Run to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_fs_create_failure_gate.py -v`
Expected: PASS.

### Task 5: Full verification

- [ ] **Step 1: Full test suite** — `.venv/bin/python -m pytest tests/ -q` — expected: all pass (textual installed in the venv).
- [ ] **Step 2: Lint** — `.venv/bin/ruff check . && .venv/bin/ruff format --check .` — expected: clean (scoped to changed files if pre-existing noise).
- [ ] **Step 3: Confirm no `Requires-Rebuild:` trailer is needed** (Python TUI + docs only; no `xiNAS-MCP/src` change).
