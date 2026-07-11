# WS4 — xinas_history hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 9 live WS4 findings against `xinas_history` (GC concurrency, ephemeral retention, vacuous post-apply/post-restore validation, netplan flush parity, lock TOCTOU, mount-unit drift, classifier fail-safe, store id/tmp-dir integrity, `datetime.utcnow()`) so the config-history/rollback safety net matches `docs/config-history/specs.md` (commit `3b90da2`).
**Architecture:** 11 bite-sized TDD tasks against the existing `xinas_history/` library (no new modules) plus the two standalone GC entry points (`__main__.py`, `xinas_menu/screens/config_history.py`) and one remediation-plan bookkeeping task. Each task is failing-test-first, one commit per task, no cross-task coupling except where noted (a later task's "current code" reflects an earlier task's edit — called out explicitly).
**Tech Stack:** Python 3.10+, pytest, `xinas_history` (stdlib `fcntl`/`asyncio`/`datetime`, no third-party runtime deps beyond PyYAML).

---

## Context

Owning spec: `docs/config-history/specs.md` + `docs/config-history/requirements.md` (already updated, commit `3b90da2` — read both before starting; every code assertion below was re-verified against the tree at HEAD of branch `ws4-xinas-history-hardening`, not assumed from the remediation-plan table). Master tracking doc: `docs/plans/2026-07-07-codebase-review-remediation-plan.md` §WS4 (checkboxes WS4.1–WS4.4, ticked by Task 11).

The snapshot-ID collision finding from the original WS4 table (`models.py:327`) is **already fixed** upstream (`generate_snapshot_id` uses microsecond resolution; `tests/test_snapshot_id_unique.py` passes) and is **not** a task here — Task 4 only touches `models.py` for the separate `datetime.utcnow()` deprecation, and updates that same test file's mock in lockstep (see Task 4).

Every finding below was re-confirmed by reading the current file at the cited lines, and the three highest-risk mechanisms (GC-deletes-in-flight-restore-source, the lock TOCTOU race, and the `ruff format` output for the trickier code blocks) were verified by actually running the current code and a patched copy in a scratch directory — not inferred. Exact commands/outputs in each task are real, not hypothetical.

---

## Conventions

- **TDD, every task:** write the failing test → run it → confirm it fails for the stated reason (RED) → write the minimal fix → run it again → confirm it passes (GREEN) → commit. No task skips the RED step.
- **Python venv:** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q` (this venv already has `xinas_history`/`xinas_menu` editable-installed against this worktree — verified working). CI additionally runs `ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper` and `ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper` and `pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper` (`.github/workflows/ci.yml`). Keep every touched file clean against all three.
- **Commits:** one commit per task, staging exact file paths (never `git add -A`), message ending with:

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

  If a task ever needs a `Requires-Rebuild:` trailer, it goes immediately before the `Co-Authored-By:` line with **no blank line** between them (a blank-line-separated trailer is silently dropped by git). None of the tasks in this plan need one — see the per-task determination below.
- **`Requires-Rebuild:` determination (stated per task, default NO):** the `xinas_history` Ansible role (`collection/roles/xinas_history/`) only copies the package and installs the CLI wrapper; it does not template or gate any individual `.py` file's behavior. A pure `.py` change inside `xinas_history/` or `xinas_menu/` takes effect the moment the release is checked out (the CLI wrapper and the TUI both import the checked-out package directly) — **no trailer**. A trailer would only be needed if a task changed the systemd unit, the CLI wrapper script, or added a new package dependency; no task in this plan does that. **Every task below: NO trailer.**
- **`datetime.utcnow()` → `datetime.now(timezone.utc)` gotcha (Task 4):** `.isoformat()` on a naive `utcnow()` produces `"2026-07-11T09:46:26.302127"` (no offset); the existing code appends a literal `"Z"`. `.isoformat()` on a **timezone-aware** `datetime.now(timezone.utc)` produces `"2026-07-11T09:46:26.302227+00:00"` — appending `"Z"` on top would produce `"...+00:00Z"` (malformed). Task 4 uses `.isoformat().replace("+00:00", "Z")` everywhere this pattern occurs, which was verified byte-for-byte to reproduce the exact prior string shape. `models.py`'s `generate_snapshot_id` uses `strftime("%Y%m%dT%H%M%S%fZ")`, not `isoformat()` — `strftime` output is identical whether the datetime is naive or timezone-aware (no `%z`/`%Z` token is used), verified directly — so that one call site needs no suffix massaging, only the `.utcnow()` → `.now(timezone.utc)` swap. `tests/test_snapshot_id_unique.py::test_same_second_ids_are_unique_and_chronologically_sortable` mocks `fake.datetime.utcnow.side_effect = [...]`; Task 4 updates it to `fake.datetime.now.side_effect = [...]` in lockstep (the mock target changes because the source now calls `.now()` instead of `.utcnow()`).
- **Two GC entry points (Task 5):** `GarbageCollector.run()` is invoked from two structurally different places and must be treated differently:
  - **INLINE** — `SnapshotEngine.create_snapshot()`'s own tail call, which fires every time ANY snapshot is created, including from inside a transaction that has **already acquired** `GlobalConfigLock` (`runner.py`'s `execute()` and `execute_restore_snapshot()` both call `engine.create_snapshot()` while holding their own lock). A second `flock(LOCK_EX | LOCK_NB)` attempt from the *same process* on the *same lock file* fails immediately (`BlockingIOError`, verified directly) — it is **not** reentrant. The inline call path must therefore **never** attempt to acquire the lock; it is already covered by the enclosing transaction's lock for the whole transaction's duration, and is protected on a per-call basis via an explicit `in_progress_ids` set threaded in from the caller.
  - **STANDALONE** — the CLI `gc run` (`xinas_history/__main__.py::_cmd_gc_run`) and the TUI "Run GC" action (`xinas_menu/screens/config_history.py::_run_gc`) run with **no enclosing lock at all** today. This is the actual reachable hazard: either can run concurrently with an in-flight `execute()`/`execute_restore_snapshot()` in another process and delete a snapshot the other operation is reading or about to read. Both are fixed to acquire `GlobalConfigLock` themselves (non-blocking) before calling `gc.run()`, and to refuse — printing/showing a clear message, not a raw traceback — when the lock is already held.

---

## File Structure

| File | Responsibility | Task(s) |
|---|---|---|
| `xinas_history/classifier.py` | Rollback-risk classification | 1 |
| `xinas_history/runner.py` | Transactional apply/restore/rollback orchestration | 1, 5, 6, 7, 8 |
| `xinas_history/engine.py` | Snapshot creation orchestrator | 1, 4, 5, 6 |
| `xinas_history/store.py` | Filesystem CRUD for snapshots | 2, 3 |
| `xinas_history/lock.py` | Global config lock + transaction journal | 4, 9 |
| `xinas_history/drift.py` | Out-of-band drift detection | 4, 10 |
| `xinas_history/models.py` | Core dataclasses/enums, snapshot-id generation | 4 |
| `xinas_history/collector.py` | Config/runtime state collection for snapshots | 10 |
| `xinas_history/__main__.py` | CLI entry point (`gc run`, etc.) | 5 |
| `xinas_menu/screens/config_history.py` | TUI Config History screen ("Run GC") | 5 |
| `docs/plans/2026-07-07-codebase-review-remediation-plan.md` | Master remediation tracker | 11 |
| `tests/test_classifier_fail_safe.py` (new) | Task 1 regression test | 1 |
| `tests/test_store_snapshot_id_safety.py` (new) | Task 2 regression test | 2 |
| `tests/test_snapshot_list_skips_tmp_staging.py` (new) | Task 3 regression test | 3 |
| `tests/test_history_timestamps_tz_aware.py` (new) | Task 4 regression test | 4 |
| `tests/test_snapshot_id_unique.py` (modified) | Lockstep mock update | 4 |
| `tests/test_gc_concurrency.py` (new) | Task 5 regression tests | 5 |
| `tests/test_ephemeral_retention.py` (new) | Task 6 regression tests | 6 |
| `tests/test_post_apply_validation.py` (new) | Task 7 regression tests (post-apply half) | 7 |
| `tests/test_execute_restore_snapshot.py` (modified) | Lockstep `_validate_restore` signature + restore-validation test + netplan assertion strengthening | 7, 8 |
| `tests/test_netplan_reconverge_flush_parity.py` (new) | Task 8 regression tests | 8 |
| `tests/test_lock_stale_recovery.py` (new) | Task 9 regression tests | 9 |
| `tests/test_mount_unit_drift.py` (new) | Task 10 regression tests | 10 |

---

## Task 1: Classifier + runner + engine unknown-operation fail-safe → `DESTROYING_DATA`

Closes **F-classifier-151** (spec §4.7). Three sites share the identical bug pattern: an operation the classifier cannot recognize currently defaults to the **safest-looking, most wrong** answer (`NON_DISRUPTIVE`, the no-confirmation path) instead of the most destructive one. The remediation-plan table names `classifier.py:150-151` and `runner.py:169`; while reading the surrounding code, `engine.py:117-123` was found to have the exact same fallback (reached directly by `python3 -m xinas_history snapshot create --operation <anything>`, since `--operation` is a free-form, non-`choices` argparse string at `__main__.py:66`) — spec §4.7 explicitly generalizes to "any caller-side fallback... including but not limited to" the two named sites, so it is fixed here too.

**Files:**
- Modify: `xinas_history/classifier.py:147-151`
- Modify: `xinas_history/runner.py:164-170`
- Modify: `xinas_history/engine.py:117-123`
- Test: `tests/test_classifier_fail_safe.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing test**

Create `tests/test_classifier_fail_safe.py`:

```python
"""T1(a) / F-classifier-151: an operation the classifier cannot recognize
must be classified at the MOST destructive tier (specs.md §4.7) -- the
system knows the LEAST about what an unrecognized operation will do, so it
must get the two-screen destroying_data gate, never the auto-proceed
non_disruptive path. Three independent fallback sites share this bug:
classifier.py's own terminal fallthrough, runner.py's execute() catching a
non-parsing operation string, and engine.py's create_snapshot() doing the
same (reachable directly via `snapshot create --operation <anything>`,
since --operation is a free-form argparse string, not a choices= list).
"""

from __future__ import annotations

import asyncio

from xinas_history.classifier import RollbackClassifier
from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, OperationType, RollbackClass
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore


def test_classifier_unknown_operation_type_defaults_destroying_data():
    """classify_operation only ever receives a real OperationType member, so
    this pins the terminal fallthrough for an enum member present in
    OperationType but missing from _OPERATION_CLASS (a future op someone
    forgets to add to the table) -- the exact case specs.md §4.7 is about."""
    classifier = RollbackClassifier()
    # RAID_MODIFY/FS_MODIFY are handled by dedicated methods; every other
    # current OperationType member IS in _OPERATION_CLASS, so to exercise
    # the fallthrough we call the private table directly rather than
    # requiring a forgotten-future-enum-member fixture.
    import xinas_history.classifier as classifier_module

    original = dict(classifier_module._OPERATION_CLASS)
    try:
        classifier_module._OPERATION_CLASS.pop(OperationType.SHARE_CREATE, None)
        result = classifier.classify_operation(OperationType.SHARE_CREATE)
    finally:
        classifier_module._OPERATION_CLASS.clear()
        classifier_module._OPERATION_CLASS.update(original)
    assert result is RollbackClass.DESTROYING_DATA


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums()


def test_engine_create_snapshot_unparseable_operation_defaults_destroying_data(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    manifest = asyncio.run(
        engine.create_snapshot(source="api", operation="totally-bogus-operation")
    )
    assert manifest.rollback_class == RollbackClass.DESTROYING_DATA.value


def test_runner_execute_unparseable_operation_defaults_destroying_data(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    runner = TransactionalRunner(engine)

    async def _apply_ok() -> bool:
        return True

    result = asyncio.run(
        runner.execute(
            operation="totally-bogus-operation",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
        )
    )
    assert result.rollback_class == RollbackClass.DESTROYING_DATA.value
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_classifier_fail_safe.py -q`
Expected: 3 failed — all three `assert ... is RollbackClass.DESTROYING_DATA` / `== RollbackClass.DESTROYING_DATA.value` fail because current code returns `RollbackClass.NON_DISRUPTIVE` (`classifier.py:151`) / `"non_disruptive"` (`engine.py:123`, `runner.py:170`).

- [ ] **Step 3: Fix `classifier.py`**

In `xinas_history/classifier.py`, replace (lines 147-151):

```python
        # --- Static lookup for everything else ---------------------------
        if operation in _OPERATION_CLASS:
            return _OPERATION_CLASS[operation]

        # Unknown operations default to the safest assumption.
        return RollbackClass.NON_DISRUPTIVE
```

with:

```python
        # --- Static lookup for everything else ---------------------------
        if operation in _OPERATION_CLASS:
            return _OPERATION_CLASS[operation]

        # Unknown operations default to the MOST destructive class
        # (specs.md §4.7): an operation the classifier cannot recognize is
        # the case where the system knows the LEAST about what it will do,
        # so it must get the two-screen destroying_data confirmation gate,
        # never the auto-proceed non_disruptive path.
        return RollbackClass.DESTROYING_DATA
```

- [ ] **Step 4: Fix `runner.py`**

In `xinas_history/runner.py`, replace (lines 164-170):

```python
        # Step 1: Classify the operation.
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum)
            result.rollback_class = rollback_class.value
        except ValueError:
            result.rollback_class = RollbackClass.NON_DISRUPTIVE.value
```

with:

```python
        # Step 1: Classify the operation.
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum)
            result.rollback_class = rollback_class.value
        except ValueError:
            # An operation string that does not even parse to a known
            # OperationType is the case the classifier knows LEAST about --
            # specs.md §4.7 fail-safe: default to the MOST destructive
            # tier, not the auto-proceed non_disruptive path.
            result.rollback_class = RollbackClass.DESTROYING_DATA.value
```

- [ ] **Step 5: Fix `engine.py`**

In `xinas_history/engine.py`, replace (lines 117-123):

```python
        # 5. Classify the operation
        rollback_class = ""
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum).value
        except ValueError:
            rollback_class = RollbackClass.NON_DISRUPTIVE.value
```

with:

```python
        # 5. Classify the operation
        rollback_class = ""
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum).value
        except ValueError:
            # Same fail-safe as runner.py's Step 1 (specs.md §4.7): an
            # operation string that fails to parse defaults to the MOST
            # destructive class. Reachable directly via
            # `snapshot create --operation <anything>` (a free-form
            # argparse string, not a choices= list).
            rollback_class = RollbackClass.DESTROYING_DATA.value
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_classifier_fail_safe.py -q`
Expected: `3 passed`

- [ ] **Step 7: Run the full relevant regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q -k "classifier or restore or rollback or engine"`
Expected: all pass (no other test asserts `NON_DISRUPTIVE` for an unknown operation).

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/classifier.py xinas_history/runner.py xinas_history/engine.py tests/test_classifier_fail_safe.py`
Expected: `All checks passed!`

- [ ] **Step 8: Commit**

```bash
git add xinas_history/classifier.py xinas_history/runner.py xinas_history/engine.py tests/test_classifier_fail_safe.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): unknown-operation fail-safe defaults to destroying_data

Three fallback sites (classifier.py's terminal fallthrough, runner.py's and
engine.py's ValueError handlers for a non-parsing operation string) defaulted
to NON_DISRUPTIVE -- the auto-proceed path -- for an operation the classifier
cannot recognize. specs.md §4.7 requires the opposite: an unrecognized
operation is the case the system knows LEAST about, so it must get the
two-screen destroying_data confirmation gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Store snapshot-id allowlist (defense-in-depth)

Closes **F-store-251**. `FilesystemStore.snapshot_path()` joins a caller-supplied `snapshot_id` onto the store root with no validation. Reachable only with disk-derived ids today (`delete_snapshot` is called only from `gc.py` against ids it just read off disk; `read_manifest`/restore fail closed on a missing manifest) — this is defense-in-depth per specs.md §1 ("Snapshot ID and Store-Path Safety"), not a remote exploit; the task does not overstate it. `snapshot_path()` is the single choke point every other store method funnels through (`read_manifest`, `read_file`, `read_runtime_file`, `read_system_file`, `list_system_files`, `delete_snapshot`, `update_manifest`, `get_snapshot_size_bytes`, `snapshot_exists`, `write_snapshot`), so validating there covers all of them at once.

**Files:**
- Modify: `xinas_history/store.py:72-74`
- Test: `tests/test_store_snapshot_id_safety.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing test**

Create `tests/test_store_snapshot_id_safety.py`:

```python
"""T1(b) / F-store-251: any snapshot id turned into a filesystem path MUST
be validated against the allowlist ^[A-Za-z0-9._-]+$ and MUST reject a
".." path segment or an absolute path (specs.md §1, "Snapshot ID and
Store-Path Safety") before joining it onto the store root. Defense-in-depth:
ids are normally generated internally, never taken from untrusted input, but
the store must not rely on that as its only safeguard.
"""

from __future__ import annotations

import pytest

from xinas_history.store import FilesystemStore


def test_snapshot_path_rejects_traversal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("../etc")


def test_snapshot_path_rejects_bare_dotdot(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("..")


def test_snapshot_path_rejects_absolute_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("/etc/passwd")


def test_delete_snapshot_rejects_traversal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    with pytest.raises(ValueError):
        store.delete_snapshot("../x")


def test_snapshot_path_accepts_normal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    normal_id = "20260711T120000123456Z-raid-create"
    assert store.snapshot_path(normal_id) == store.snapshots_path / normal_id
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_store_snapshot_id_safety.py -q`
Expected: 4 failed (`test_snapshot_path_rejects_*` and `test_delete_snapshot_rejects_traversal_id` each fail with `Failed: DID NOT RAISE <class 'ValueError'>` — `Path.__truediv__` silently accepts any string today); 1 passed (`test_snapshot_path_accepts_normal_id`, since a normal id already round-trips correctly with no validation).

- [ ] **Step 3: Implement the allowlist check**

In `xinas_history/store.py`, add near the top (after the existing module-level constants, before the `FilesystemStore` class):

```python
import re

_SNAPSHOT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_snapshot_id(snapshot_id: str) -> None:
    """Reject a snapshot id that is unsafe to join onto the store root
    (specs.md §1, "Snapshot ID and Store-Path Safety"). The allowlist
    regex already excludes "/", so it rejects any absolute path or any
    ".." segment that contains a slash; the one case it would otherwise
    miss -- an id that is exactly ".." or "." (composed entirely of
    allowlisted characters, no slash needed to traverse) -- is rejected
    explicitly.
    """
    if not snapshot_id or not _SNAPSHOT_ID_RE.match(snapshot_id) or snapshot_id in (".", ".."):
        raise ValueError(f"Invalid snapshot id: {snapshot_id!r}")
```

(Add the `import re` to the existing import block at the top of the file rather than inline, if the file does not already import `re`.)

Then modify `snapshot_path()` (lines 72-74):

```python
    def snapshot_path(self, snapshot_id: str) -> Path:
        """Get the filesystem path for a snapshot ID."""
        return self.snapshots_path / snapshot_id
```

to:

```python
    def snapshot_path(self, snapshot_id: str) -> Path:
        """Get the filesystem path for a snapshot ID."""
        _validate_snapshot_id(snapshot_id)
        return self.snapshots_path / snapshot_id
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_store_snapshot_id_safety.py -q`
Expected: `5 passed`

- [ ] **Step 5: Run the full store regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q -k "store or snapshot"`
Expected: all pass — every existing caller passes a well-formed generated id (e.g. `20260316T145500123456Z-raid-create`), which matches the allowlist and is not `.`/`..`.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/store.py tests/test_store_snapshot_id_safety.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/store.py tests/test_store_snapshot_id_safety.py`
Expected: both `All checks passed!` / `1 file already formatted` (adjust with `ruff format` if not).

- [ ] **Step 6: Commit**

```bash
git add xinas_history/store.py tests/test_store_snapshot_id_safety.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): validate snapshot ids before building a store path

FilesystemStore.snapshot_path() joined any caller-supplied id onto the store
root with no validation. specs.md §1 requires the allowlist
^[A-Za-z0-9._-]+$ and rejection of ".."/absolute ids at the path-building
choke point. Defense-in-depth: unreachable with today's disk-derived ids,
but the store must not rely on that as its only safeguard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `list_snapshots` skips `.tmp-*` staging directories

Closes **F-store-128**. `write_snapshot()` builds the new snapshot inside a `tempfile.mkdtemp(dir=..., prefix=f".tmp-{snapshot_id}-")` staging directory, writes the (already `status: applied`) manifest into it, then does an atomic `os.rename()` into `snapshots/<id>/`. A crash between those two steps leaves a `.tmp-{id}-XXXXXX/` directory containing a fully-valid, parseable `manifest.yml` sitting directly under `snapshots/`. `list_snapshots()` iterates every directory entry under `snapshots_path` with no name filter, so that leaked staging directory is indistinguishable from a real, committed snapshot to every consumer (CLI `snapshot list`, TUI history view, GC's own `list_snapshots()` call).

**Files:**
- Modify: `xinas_history/store.py:205-220` (`list_snapshots`)
- Test: `tests/test_snapshot_list_skips_tmp_staging.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing test**

Create `tests/test_snapshot_list_skips_tmp_staging.py`:

```python
"""T1(c) / F-store-128: list_snapshots() must skip .tmp-* staging
directories -- a crash between write_snapshot() writing into its temp
staging dir and the atomic rename into snapshots/<id>/ leaves a directory
with a fully-valid manifest.yml sitting directly under snapshots/, and it
must never be surfaced as a real, committed snapshot (specs.md §1).
"""

from __future__ import annotations

from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore


def test_list_snapshots_skips_tmp_staging_dir(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()

    # A real, committed snapshot.
    real_id = "20260711T120000000000Z-raid-create"
    store.write_snapshot(
        snapshot_id=real_id,
        manifest=Manifest(
            id=real_id,
            timestamp="2026-07-11T12:00:00Z",
            user="root",
            source="api",
        ),
        config_files={},
        runtime_files={},
    )

    # A crash-leaked staging dir: same shape write_snapshot creates before
    # the atomic rename, but never renamed (simulates a crash mid-write).
    # Its manifest.yml is fully valid and parseable on its own.
    stale_id = "20260711T130000000000Z-raid-delete"
    stale_dir = store.snapshots_path / f".tmp-{stale_id}-abcd12"
    stale_dir.mkdir()
    (stale_dir / "manifest.yml").write_text(
        f"id: {stale_id}\ntimestamp: '2026-07-11T13:00:00Z'\nuser: root\n"
        "source: api\nstatus: applied\n"
    )

    ids = {m.id for m in store.list_snapshots()}
    assert ids == {real_id}
    assert stale_id not in ids
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_snapshot_list_skips_tmp_staging.py -q`
Expected: `1 failed` — `assert {real_id, stale_id} == {real_id}` (the `.tmp-*` dir's valid manifest gets loaded and returned today, since `list_snapshots()` only checks `entry.is_dir()`).

- [ ] **Step 3: Implement the fix**

In `xinas_history/store.py`, replace `list_snapshots()` (lines 205-220):

```python
    def list_snapshots(self) -> list[Manifest]:
        """List all snapshots (excluding baseline), sorted by timestamp
        ascending."""
        manifests: list[Manifest] = []
        if not self.snapshots_path.is_dir():
            return manifests

        for entry in self.snapshots_path.iterdir():
            if not entry.is_dir():
                continue
            m = self._load_manifest(entry / MANIFEST_FILE)
            if m is not None:
                manifests.append(m)

        manifests.sort(key=lambda m: m.timestamp)
        return manifests
```

with:

```python
    def list_snapshots(self) -> list[Manifest]:
        """List all snapshots (excluding baseline), sorted by timestamp
        ascending. Skips ".tmp-*" staging directories -- a crash between
        write_snapshot()'s temp-dir write and its atomic rename can leave
        one behind with a fully-valid manifest.yml (specs.md §1); it must
        never be surfaced as a committed snapshot."""
        manifests: list[Manifest] = []
        if not self.snapshots_path.is_dir():
            return manifests

        for entry in self.snapshots_path.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.startswith(".tmp-"):
                continue
            m = self._load_manifest(entry / MANIFEST_FILE)
            if m is not None:
                manifests.append(m)

        manifests.sort(key=lambda m: m.timestamp)
        return manifests
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_snapshot_list_skips_tmp_staging.py -q`
Expected: `1 passed`

- [ ] **Step 5: Run the full store/GC regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q -k "store or snapshot or gc"`
Expected: all pass.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/store.py tests/test_snapshot_list_skips_tmp_staging.py`
Expected: `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add xinas_history/store.py tests/test_snapshot_list_skips_tmp_staging.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): list_snapshots skips leaked .tmp-* staging directories

A crash between write_snapshot()'s temp-directory write and its atomic
rename into snapshots/<id>/ can leave a .tmp-{id}-XXXXXX/ directory with a
fully-valid manifest.yml sitting directly under snapshots/. list_snapshots()
had no name filter, so a leaked staging dir was indistinguishable from a
real, committed snapshot to the CLI, the TUI, and GC's own listing
(specs.md §1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `datetime.utcnow()` → `datetime.now(timezone.utc)` (6 sites)

Closes **F-lock-127**. `datetime.utcnow()` is deprecated (`DeprecationWarning`, confirmed emitted by the current test suite) at exactly 6 sites, confirmed by `grep -rn "utcnow()" xinas_history/*.py` and no others: `lock.py:127,222,330`, `engine.py:146`, `models.py:342`, `drift.py:208`. See Conventions above for the `"Z"`-suffix gotcha and the lockstep test-mock update this task requires.

**Files:**
- Modify: `xinas_history/lock.py:127,222,330` (via a new `_utc_now_iso()` helper — DRY, 3 call sites in one file)
- Modify: `xinas_history/engine.py:146`
- Modify: `xinas_history/drift.py:208`
- Modify: `xinas_history/models.py:342-343`
- Test: `tests/test_history_timestamps_tz_aware.py` (new)
- Test: `tests/test_snapshot_id_unique.py` (modified — lockstep mock update)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing test (new file)**

Create `tests/test_history_timestamps_tz_aware.py`:

```python
"""T1(d) / F-lock-127: datetime.utcnow() is deprecated at 6 sites
(lock.py:127,222,330; engine.py:146; models.py:342; drift.py:208). Each
call site must switch to datetime.now(timezone.utc) while preserving the
existing "...Z"-suffixed serialized form (specs.md §1: "the serialized
form is unchanged: ISO 8601 with a Z suffix").
"""

from __future__ import annotations

import warnings
from datetime import datetime as real_datetime

from xinas_history.drift import DriftDetector
from xinas_history.engine import SnapshotEngine
from xinas_history.lock import GlobalConfigLock
from xinas_history.models import Checksums
from xinas_history.store import FilesystemStore


def _assert_z_suffix_and_parses(ts: str) -> None:
    assert ts.endswith("Z"), ts
    real_datetime.fromisoformat(ts.replace("Z", "+00:00"))  # must not raise


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums()


def test_engine_snapshot_timestamp_is_tz_aware_with_z_suffix(tmp_path):
    import asyncio

    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        manifest = asyncio.run(
            engine.create_snapshot(source="api", operation="install", snapshot_type="baseline")
        )
    _assert_z_suffix_and_parses(manifest.timestamp)


def test_lock_meta_started_is_tz_aware_with_z_suffix(tmp_path):
    lock = GlobalConfigLock(str(tmp_path / "state"))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            lock.acquire(operation="raid_create", source="api")
        info = lock.get_lock_info()
        assert info is not None
        _assert_z_suffix_and_parses(info["started"])
        journal = lock.get_journal()
        assert journal is not None
        _assert_z_suffix_and_parses(journal["started"])
        _assert_z_suffix_and_parses(journal["last_updated"])
    finally:
        lock.release()


def test_drift_report_timestamp_is_tz_aware_with_z_suffix(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    detector = DriftDetector(store=store, repo_root=str(tmp_path))
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        report = detector.check()
    _assert_z_suffix_and_parses(report.timestamp)
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_history_timestamps_tz_aware.py -q`
Expected: `3 failed` — each fails with `DeprecationWarning: datetime.datetime.utcnow() is deprecated...` raised as an error (via `warnings.simplefilter("error", ...)`), sourced from `engine.py:146`, `lock.py:127`/`330`, and `drift.py:208` respectively (verified: this exact warning is what the current suite already emits, unguarded, for these call sites).

- [ ] **Step 3: Update the lockstep mock in `tests/test_snapshot_id_unique.py`**

The existing test mocks `models.py`'s `.utcnow()` call; once Step 4 below switches `generate_snapshot_id` to `.now(timezone.utc)`, this mock target must move too. Replace (the full `test_same_second_ids_are_unique_and_chronologically_sortable` function):

```python
def test_same_second_ids_are_unique_and_chronologically_sortable():
    # Two creates in the SAME second but different microseconds — the exact
    # collision window. Build the fake times BEFORE patching so the real
    # datetime constructor is still available.
    t0 = datetime.datetime(2026, 7, 7, 18, 59, 54, 100_000)
    t1 = datetime.datetime(2026, 7, 7, 18, 59, 54, 900_000)

    with mock.patch.object(models, "datetime") as fake:
        fake.datetime.utcnow.side_effect = [t0, t1]
        first = models.generate_snapshot_id("share_create")
        second = models.generate_snapshot_id("share_create")

    assert first != second
    # Both fall in the same wall-clock second ...
    assert first.startswith("20260707T185954")
    assert second.startswith("20260707T185954")
    # ... and lexicographic order still matches chronological order.
    assert first < second
```

with:

```python
def test_same_second_ids_are_unique_and_chronologically_sortable():
    # Two creates in the SAME second but different microseconds — the exact
    # collision window. Build the fake times BEFORE patching so the real
    # datetime constructor is still available.
    t0 = datetime.datetime(2026, 7, 7, 18, 59, 54, 100_000, tzinfo=datetime.timezone.utc)
    t1 = datetime.datetime(2026, 7, 7, 18, 59, 54, 900_000, tzinfo=datetime.timezone.utc)

    with mock.patch.object(models, "datetime") as fake:
        fake.datetime.now.side_effect = [t0, t1]
        first = models.generate_snapshot_id("share_create")
        second = models.generate_snapshot_id("share_create")

    assert first != second
    # Both fall in the same wall-clock second ...
    assert first.startswith("20260707T185954")
    assert second.startswith("20260707T185954")
    # ... and lexicographic order still matches chronological order.
    assert first < second
```

(`test_snapshot_id_has_microsecond_resolution`, the other test in that file, calls the real function with no mocking and is unaffected.)

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_snapshot_id_unique.py -q`
Expected: `1 failed, 1 passed` — the updated test now fails because `models.py` still calls `.utcnow()`, not `.now()`, so `fake.datetime.now` is never invoked with the configured `side_effect`, and `fake.datetime.utcnow()` (still called by the un-patched source) returns an unconfigured `MagicMock`, breaking the `.startswith(...)` assertions. This confirms the RED state before Step 4.

- [ ] **Step 4: Implement the fix — `lock.py` (add a helper, replace 3 call sites)**

In `xinas_history/lock.py`, add a module-level helper right after the imports (before `class LockError`):

```python
def _utc_now_iso() -> str:
    """Timezone-aware UTC timestamp, serialized with the same "...Z"
    suffix the prior ``datetime.utcnow().isoformat() + "Z"`` pattern
    produced (specs.md §1)."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
```

Replace line 127 (`acquire()`):

```python
        now = datetime.datetime.utcnow().isoformat() + "Z"
```

with:

```python
        now = _utc_now_iso()
```

Replace line 222 (`update_journal()`):

```python
        journal["last_updated"] = datetime.datetime.utcnow().isoformat() + "Z"
```

with:

```python
        journal["last_updated"] = _utc_now_iso()
```

Replace line 330 (`_write_lock_meta()`):

```python
            "started": datetime.datetime.utcnow().isoformat() + "Z",
```

with:

```python
            "started": _utc_now_iso(),
```

- [ ] **Step 5: Implement the fix — `engine.py`**

Replace line 146:

```python
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
```

with (verified exact `ruff format` output for this call-site depth):

```python
            timestamp=datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
```

- [ ] **Step 6: Implement the fix — `drift.py`**

Replace line 208:

```python
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
```

with:

```python
            timestamp=datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
```

- [ ] **Step 7: Implement the fix — `models.py`**

Replace lines 342-343:

```python
    now = datetime.datetime.utcnow()
    ts = now.strftime("%Y%m%dT%H%M%S%fZ")
```

with:

```python
    now = datetime.datetime.now(datetime.timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%S%fZ")
```

(`strftime` output is identical for a naive vs. timezone-aware datetime here — no `%z`/`%Z` token is used — verified directly; only the `.utcnow()` → `.now(timezone.utc)` swap is needed.)

- [ ] **Step 8: Run all four test files to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_history_timestamps_tz_aware.py tests/test_snapshot_id_unique.py -q`
Expected: `5 passed`, **zero** `DeprecationWarning` lines in the output.

Run: `grep -rn "utcnow()" xinas_history/*.py`
Expected: no output (all 6 sites converted; confirms no site was missed).

- [ ] **Step 9: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass, no `DeprecationWarning: datetime.datetime.utcnow()` anywhere in the output (previously emitted by `test_auto_rollback_file_level.py` and others, per the venv's baseline run).

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/lock.py xinas_history/engine.py xinas_history/drift.py xinas_history/models.py tests/test_history_timestamps_tz_aware.py tests/test_snapshot_id_unique.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/lock.py xinas_history/engine.py xinas_history/drift.py xinas_history/models.py tests/test_history_timestamps_tz_aware.py tests/test_snapshot_id_unique.py`
Expected: `All checks passed!` for both (the exact wrapped forms in Steps 5-6 were verified byte-for-byte against real `ruff format` output at this file's actual indentation depth).

- [ ] **Step 10: Commit**

```bash
git add xinas_history/lock.py xinas_history/engine.py xinas_history/drift.py xinas_history/models.py tests/test_history_timestamps_tz_aware.py tests/test_snapshot_id_unique.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): replace deprecated datetime.utcnow() at all 6 sites

lock.py (3 sites, via a new _utc_now_iso() helper), engine.py, drift.py, and
models.py all called the deprecated datetime.utcnow(). Switched to
datetime.now(timezone.utc), preserving the existing "...Z"-suffixed
serialized form specs.md §1 requires via .isoformat().replace("+00:00", "Z").
Updated test_snapshot_id_unique.py's mock target (utcnow -> now) in lockstep
with models.py's generate_snapshot_id.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: GC concurrency — standalone lock-gate + in-flight-restore protection

Closes **F-engine-176 (HIGH)**. See Conventions above for the two-entry-point wrinkle. This was verified by actually reproducing the bug: with `RetentionPolicy(max_snapshots=1)`, two `rollback_eligible` snapshots on disk, and no other protection, calling `execute_restore_snapshot(old_id, ...)` on the **current, unfixed** code silently deletes `old_id` — the very snapshot being restored FROM — via the inline GC pass fired by the pre-restore ephemeral's own `create_snapshot()` call, **before** the restore's file-write loop runs. Because `read_system_file()` on a missing snapshot directory returns `None` (not an error) and the write loop only acts `if content is not None`, the restore then silently no-ops and still reports `result.success = True` — a false-positive success, confirmed by direct reproduction, worse than a mere "GC deleted something it shouldn't have" framing.

**Files:**
- Modify: `xinas_history/engine.py` (`create_snapshot` signature + tail GC call — adds `gc_protect_ids` param)
- Modify: `xinas_history/runner.py` (`execute_restore_snapshot` — passes `gc_protect_ids={snapshot_id}` for its pre-restore ephemeral)
- Modify: `xinas_history/__main__.py` (`_cmd_gc_run` — acquires `GlobalConfigLock`, refuses when held)
- Modify: `xinas_menu/screens/config_history.py` (`_run_gc` — same fix, TUI side)
- Test: `tests/test_gc_concurrency.py` (new)

**Requires-Rebuild:** NO (pure `.py` library/TUI change — no systemd unit, wrapper, or package dependency changes).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_gc_concurrency.py`:

```python
"""T2 (F-engine-176, HIGH): GC must never delete a snapshot while a restore
is reading it, and standalone GC entry points must not run lock-free
(specs.md §7.4: "no lock-free deletion, and an active restore's source
snapshot is always protected").

Two GC entry points, two different fixes:
- INLINE (engine.create_snapshot's own tail GC pass) fires from INSIDE a
  transaction that already holds GlobalConfigLock (e.g. execute_restore_
  snapshot's pre-restore ephemeral creation). A second flock() attempt from
  the same process on the same lock file fails immediately (verified
  directly) -- it must NOT try to acquire the lock; it is protected instead
  by an explicit in_progress_ids set threaded in by the caller.
- STANDALONE (CLI `gc run`, TUI "Run GC") own no enclosing lock today --
  they must acquire GlobalConfigLock themselves and refuse when it is
  already held by another operation.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from xinas_history.engine import SnapshotEngine
from xinas_history.gc import GarbageCollector, RetentionPolicy
from xinas_history.lock import GlobalConfigLock
from xinas_history.models import Checksums, Manifest, SnapshotType
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore

REPO_ROOT = Path(__file__).resolve().parents[1]


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"EPHEMERAL-LIVE"}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")


def test_gc_does_not_delete_in_flight_restore_source(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    # Aggressive retention (max_snapshots=1) so the restore TARGET (oldest
    # rollback_eligible snapshot) is purge-eligible the instant a second
    # rollback_eligible snapshot exists -- exactly the window the restore's
    # own pre-snapshot creation opens via its inline GC pass.
    engine._gc = GarbageCollector(store, RetentionPolicy(max_snapshots=1))

    old_id = "20260101T000000000000Z-share-create"  # the restore target/source
    other_id = "20260103T000000000000Z-share-modify"  # a second, newer rollback_eligible snapshot
    store.write_snapshot(
        snapshot_id=old_id,
        manifest=Manifest(
            id=old_id,
            timestamp="2026-01-01T00:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            status="applied",
            type=SnapshotType.ROLLBACK_ELIGIBLE.value,
            checksums={"etc_exports": "sha256:TARGET"},
        ),
        config_files={},
        runtime_files={},
        system_files={"etc_exports": b"TARGET-EXPORTS"},
    )
    store.write_snapshot(
        snapshot_id=other_id,
        manifest=Manifest(
            id=other_id,
            timestamp="2026-01-03T00:00:00Z",
            user="root",
            source="api",
            operation="share_modify",
            status="applied",
            type=SnapshotType.ROLLBACK_ELIGIBLE.value,
        ),
        config_files={},
        runtime_files={},
    )

    runner = TransactionalRunner(engine)
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {"etc_exports": str(live_dir / "exports")}  # type: ignore[attr-defined]

    async def _fake_run(argv):
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]

    async def _live_checksums():
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live_checksums  # type: ignore[attr-defined]

    result = asyncio.run(
        runner.execute_restore_snapshot(old_id, source="api", reason="concurrency-check")
    )

    assert store.read_manifest(old_id) is not None, (
        "the restore's own pre-snapshot creation fired an inline GC pass "
        "that deleted the snapshot being restored FROM"
    )
    assert result.success is True
    assert (live_dir / "exports").read_bytes() == b"TARGET-EXPORTS", (
        "old code: read_system_file() on the deleted target silently "
        "returned None, so the restore no-op'd while still reporting success"
    )


def test_cli_gc_run_refuses_when_lock_held(tmp_path):
    lock = GlobalConfigLock(str(tmp_path / "state"))
    lock.acquire(operation="raid_create", source="xinas_menu")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "xinas_history", "--store-path", str(tmp_path), "gc", "run"],
            cwd=tmp_path,
            env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
        )
    finally:
        lock.release()
    assert result.returncode != 0
    assert "lock" in (result.stdout + result.stderr).lower()


def test_cli_gc_run_succeeds_when_lock_free(tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "xinas_history", "--store-path", str(tmp_path), "gc", "run"],
        cwd=tmp_path,
        env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_gc_concurrency.py -q`
Expected: `2 failed, 1 passed` —
- `test_gc_does_not_delete_in_flight_restore_source` fails at `assert store.read_manifest(old_id) is not None` (reproduced directly: the inline GC pass deletes `old_id` before the restore reads it).
- `test_cli_gc_run_refuses_when_lock_held` fails at `assert result.returncode != 0` (reproduced directly: current `_cmd_gc_run` returns 0 and prints `"No snapshots purged."` regardless of the held lock).
- `test_cli_gc_run_succeeds_when_lock_free` already passes today (no lock involved).

- [ ] **Step 3: Implement the fix — `engine.py` (`gc_protect_ids` param)**

Replace the `create_snapshot` signature (lines 62-71):

```python
    async def create_snapshot(
        self,
        source: str,
        operation: str,
        preset: str = "",
        snapshot_type: str = SnapshotType.ROLLBACK_ELIGIBLE.value,
        parent_id: str | None = None,
        extra_vars: dict | None = None,
        diff_summary: str | None = None,
    ) -> Manifest:
```

with:

```python
    async def create_snapshot(
        self,
        source: str,
        operation: str,
        preset: str = "",
        snapshot_type: str = SnapshotType.ROLLBACK_ELIGIBLE.value,
        parent_id: str | None = None,
        extra_vars: dict | None = None,
        diff_summary: str | None = None,
        gc_protect_ids: set[str] | None = None,
    ) -> Manifest:
```

Add to the docstring's `Args:` block: `gc_protect_ids: Snapshot ids to protect from this call's own inline GC pass (e.g. a restore's source snapshot) -- see specs.md §7.4.`

Then replace the tail GC call (lines 175-179):

```python
        # 9. Run garbage collection (non-baseline only)
        if not is_baseline:
            effective_id = snapshot_id  # this one is now the effective
            with contextlib.suppress(Exception):  # GC failures are non-fatal
                self._gc.run(current_effective_id=effective_id)

        return manifest
```

with:

```python
        # 9. Run garbage collection (non-baseline only). This call runs
        # INLINE, inside whatever GlobalConfigLock the caller (runner.py)
        # is already holding for the duration of its transaction -- it
        # must NEVER try to acquire the lock itself (a second flock()
        # attempt on the same lock file from this same process fails
        # immediately, verified directly). Callers that know a specific
        # snapshot must survive this pass (e.g. a restore protecting the
        # snapshot it is restoring FROM) pass it via gc_protect_ids
        # (specs.md §7.4).
        if not is_baseline:
            effective_id = snapshot_id  # this one is now the effective
            with contextlib.suppress(Exception):  # GC failures are non-fatal
                self._gc.run(current_effective_id=effective_id, in_progress_ids=gc_protect_ids)

        return manifest
```

- [ ] **Step 4: Implement the fix — `runner.py` (`execute_restore_snapshot` protects its source)**

Replace (inside `execute_restore_snapshot`):

```python
            pre = await self._engine.create_snapshot(
                source=source,
                operation=result.operation,
                snapshot_type=SnapshotType.EPHEMERAL.value,
                diff_summary=f"Pre-restore snapshot for {snapshot_id}",
            )
```

with:

```python
            pre = await self._engine.create_snapshot(
                source=source,
                operation=result.operation,
                snapshot_type=SnapshotType.EPHEMERAL.value,
                diff_summary=f"Pre-restore snapshot for {snapshot_id}",
                # specs.md §7.4: GC must not delete the snapshot this
                # restore is reading FROM. This creation's own inline GC
                # pass is the only unprotected window (the standalone
                # entry points are now lock-gated in Step 5/6 below).
                gc_protect_ids={snapshot_id},
            )
```

- [ ] **Step 5: Implement the fix — `__main__.py` (`_cmd_gc_run` acquires the lock)**

Replace `_cmd_gc_run` (lines 486-503):

```python
def _cmd_gc_run(engine: SnapshotEngine) -> int:
    from .gc import GarbageCollector, load_retention_policy

    effective = engine.get_current_effective()
    effective_id = effective.id if effective else None

    policy = load_retention_policy()
    gc = GarbageCollector(engine._store, policy)
    purged = gc.run(current_effective_id=effective_id)

    if purged:
        print(f"Purged {len(purged)} snapshot(s):")
        for sid in purged:
            print(f"  - {sid}")
    else:
        print("No snapshots purged.")

    return 0
```

with:

```python
def _cmd_gc_run(engine: SnapshotEngine) -> int:
    from .gc import GarbageCollector, load_retention_policy
    from .lock import GlobalConfigLock, LockError

    effective = engine.get_current_effective()
    effective_id = effective.id if effective else None

    policy = load_retention_policy()
    gc = GarbageCollector(engine._store, policy)

    # specs.md §7.4: GC must not run lock-free. This is a standalone entry
    # point with no enclosing transaction, so it acquires the lock itself
    # and refuses if another operation already holds it.
    lock = GlobalConfigLock(str(engine._store.state_path))
    try:
        lock.acquire(operation="gc_run", source="api")
    except LockError as exc:
        print(
            f"Error: cannot run GC while a configuration change is in progress: {exc}",
            file=sys.stderr,
        )
        return 1

    try:
        purged = gc.run(current_effective_id=effective_id)
    finally:
        lock.release()

    if purged:
        print(f"Purged {len(purged)} snapshot(s):")
        for sid in purged:
            print(f"  - {sid}")
    else:
        print("No snapshots purged.")

    return 0
```

- [ ] **Step 6: Implement the fix — `xinas_menu/screens/config_history.py` (`_run_gc`, TUI side)**

Replace (inside `_run_gc`):

```python
        loop = asyncio.get_running_loop()
        try:
            from xinas_history.gc import GarbageCollector, load_retention_policy
            from xinas_history.store import FilesystemStore

            store = FilesystemStore()
            gc = GarbageCollector(store, load_retention_policy())
            engine = _create_engine(store=store)
            effective = await loop.run_in_executor(
                None,
                engine.get_current_effective,
            )
            effective_id = effective.id if effective else None
            purged = await loop.run_in_executor(
                None,
                lambda: gc.run(current_effective_id=effective_id),
            )
        except Exception as exc:
            view.set_content(f"{_RED}Garbage collection failed: {exc}{_NC}")
            return
```

with:

```python
        loop = asyncio.get_running_loop()
        try:
            from xinas_history.gc import GarbageCollector, load_retention_policy
            from xinas_history.lock import GlobalConfigLock, LockError
            from xinas_history.store import FilesystemStore

            store = FilesystemStore()
            gc = GarbageCollector(store, load_retention_policy())
            engine = _create_engine(store=store)
            effective = await loop.run_in_executor(
                None,
                engine.get_current_effective,
            )
            effective_id = effective.id if effective else None

            # specs.md §7.4: same standalone-entry-point lock-gate as the
            # CLI's `gc run` -- refuse instead of running lock-free.
            lock = GlobalConfigLock(str(store.state_path))
            try:
                await loop.run_in_executor(
                    None,
                    lambda: lock.acquire(operation="gc_run", source="xinas_menu"),
                )
            except LockError as exc:
                view.set_content(
                    f"{_RED}Cannot run GC: a configuration change is in progress "
                    f"({exc}){_NC}"
                )
                return

            try:
                purged = await loop.run_in_executor(
                    None,
                    lambda: gc.run(current_effective_id=effective_id),
                )
            finally:
                await loop.run_in_executor(None, lock.release)
        except Exception as exc:
            view.set_content(f"{_RED}Garbage collection failed: {exc}{_NC}")
            return
```

(The TUI change is not independently unit-tested here — Textual screen methods in this codebase require the full `App`/`textual` test harness, and this is 9 files' worth of pre-existing local-environment gap per project memory, covered by CI. It mirrors the CLI's exact `GlobalConfigLock` acquire/refuse pattern verified by `test_cli_gc_run_refuses_when_lock_held` above; flagged honestly in Self-Review below as the one deliberate coverage gap.)

- [ ] **Step 7: Run the tests to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_gc_concurrency.py -q`
Expected: `3 passed` (verified directly against a patched scratch copy: the restore's target snapshot survives and the live file is correctly written with `TARGET-EXPORTS`; the CLI returns exit code 1 with stderr `Error: cannot run GC while a configuration change is in progress: Configuration lock held by another process: pid=..., operation=raid_create, ...`).

- [ ] **Step 8: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass — no existing test calls `create_snapshot()` positionally past `diff_summary` (new param is keyword-only-by-convention with a default), and no existing test exercises `_cmd_gc_run`/`_run_gc` under a held lock.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/engine.py xinas_history/runner.py xinas_history/__main__.py xinas_menu/screens/config_history.py tests/test_gc_concurrency.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/engine.py xinas_history/runner.py xinas_history/__main__.py xinas_menu/screens/config_history.py tests/test_gc_concurrency.py`
Expected: `All checks passed!` for both.

Run: `/tmp/xinas-pytest-venv/bin/pyright xinas_history/engine.py xinas_history/runner.py xinas_history/__main__.py xinas_menu/screens/config_history.py`
Expected: `0 errors, 0 warnings, 0 informations` (or pre-existing baseline warnings only, per `reportUnusedCoroutine = "warning"`).

- [ ] **Step 9: Commit**

```bash
git add xinas_history/engine.py xinas_history/runner.py xinas_history/__main__.py xinas_menu/screens/config_history.py tests/test_gc_concurrency.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): GC must not run lock-free or delete an in-flight restore's source

Standalone GC entry points (CLI `gc run`, TUI "Run GC") ran with no lock at
all -- they now acquire GlobalConfigLock and refuse when another operation
holds it (specs.md §7.4). The inline GC pass fired by SnapshotEngine.
create_snapshot() cannot acquire the same lock (it already runs inside a
transaction holding it) -- it is now protected per-call via a new
gc_protect_ids param, which execute_restore_snapshot() uses to protect the
snapshot it is restoring FROM during its own pre-restore ephemeral creation.
Reproduced directly: without this fix, restoring from a snapshot that is
also purge-eligible under the configured retention policy silently deletes
it and still reports success (read_system_file() on a missing snapshot
returns None, so the write loop no-ops).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
---

## Task 6: Ephemeral pre-change snapshot lifecycle (pending → terminal)

Closes **F-engine-150**. `engine.py:152` hardcodes `status=SnapshotStatus.APPLIED.value` for every snapshot, including ephemeral pre-change snapshots (verified: `create_snapshot("api", "share_create", snapshot_type="ephemeral")` returns `status="applied"` immediately at creation, today). `gc.py`'s `cleanup_stale_ephemeral()` (already correct, no change needed) only auto-deletes `status == PENDING`; everything else is marked `FAILED` and kept — but since nothing ever sets `PENDING`, that delete branch is dead code. Per specs.md §1 ("Snapshot Status Lifecycle"), a pre-change ephemeral must be created `PENDING` and the runner must move it to a terminal status (`applied`/`rolled_back`/`failed`) once the operation it precedes resolves, on **every** path: forward-apply success, successful auto-rollback (already handled — existing `_auto_rollback` code already sets `ROLLED_BACK` on its success path), rollback-itself-fails (currently **not** handled — the snapshot silently keeps whatever hardcoded status it got at creation), and the S11 targeted-restore path's own pre-restore ephemeral (currently **never** marked terminal on either its success or failure path).

**Files:**
- Modify: `xinas_history/engine.py` (manifest `status=` assignment)
- Modify: `xinas_history/runner.py` (`_auto_rollback`, `execute`'s success branch, `execute_restore_snapshot`)
- Test: `tests/test_ephemeral_retention.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_ephemeral_retention.py`:

```python
"""T3 / F-engine-150: ephemeral pre-change snapshots must be created
status=pending and moved to a terminal status (applied/rolled_back/failed)
by the runner once the operation they precede resolves -- otherwise GC's
cleanup_stale_ephemeral() (gc.py, already correct) and count/age retention
never reclaim them (specs.md §1 "Snapshot Status Lifecycle", §7.3).
"""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.gc import GarbageCollector, RetentionPolicy
from xinas_history.models import Checksums, Manifest, SnapshotStatus, SnapshotType
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"EPHEMERAL-LIVE"}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")


class _FakePostApplyValidator:
    """Always-pass stand-in -- isolates the ephemeral-lifecycle behavior
    under test from the real PostApplyValidator's systemctl subprocess
    calls (which are environment-dependent; Task 7 gives it real teeth)."""

    async def validate(self, **kwargs):
        from xinas_history.models import ValidationResult

        return ValidationResult(passed=True)


def _build_runner(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    runner = TransactionalRunner(engine)
    runner._post_apply = _FakePostApplyValidator()  # type: ignore[assignment]
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {"etc_exports": str(live_dir / "exports")}  # type: ignore[attr-defined]

    async def _fake_run(argv):
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]
    return runner, store, engine


def test_ephemeral_snapshot_created_pending(tmp_path):
    """The RED-defining test for this task: immediately after creation,
    before any resolution, an ephemeral's status must be pending, not the
    old hardcoded applied."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    manifest = asyncio.run(
        engine.create_snapshot(
            source="api",
            operation="share_create",
            snapshot_type=SnapshotType.EPHEMERAL.value,
        )
    )
    assert manifest.status == SnapshotStatus.PENDING.value


def test_pre_change_ephemeral_marked_applied_after_successful_apply(tmp_path):
    """Confirms the end-to-end contract holds on the success path. NOTE:
    this specific assertion is NOT independently red against old code --
    the old hardcoded default happens to already read "applied" here too,
    coincidentally. It is kept as a non-regression / contract-pinning
    check; test_ephemeral_snapshot_created_pending and
    test_pre_change_ephemeral_marked_failed_when_rollback_also_fails below
    are this task's genuine RED tests."""
    runner, store, engine = _build_runner(tmp_path)

    async def _broken_live() -> Checksums:
        return Checksums(etc_exports="sha256:BROKEN")

    runner._collect_current_checksums = _broken_live  # type: ignore[attr-defined]

    async def _apply_ok() -> bool:
        return True

    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
        )
    )
    assert result.success is True
    pre_manifest = store.read_manifest(result.pre_change_snapshot_id)
    assert pre_manifest is not None
    assert pre_manifest.status == SnapshotStatus.APPLIED.value


def test_pre_change_ephemeral_marked_failed_when_rollback_also_fails(tmp_path):
    """RED-defining: when BOTH the forward apply AND the auto-rollback
    fail, the pre-change ephemeral must end up status=failed (specs.md §1:
    "failed... the snapshot is retained for forensic review"). Old code
    never marks this branch at all, leaving the hardcoded status=applied
    in place -- misleadingly implying the operation succeeded."""
    runner, store, engine = _build_runner(tmp_path)

    async def _broken_live() -> Checksums:
        return Checksums(etc_exports="sha256:BROKEN")

    runner._collect_current_checksums = _broken_live  # type: ignore[attr-defined]

    async def _fail_run(argv):
        return False, "boom"

    runner._run_command = _fail_run  # type: ignore[attr-defined]

    async def _apply_fails() -> bool:
        return False

    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_fails,
            skip_preflight=True,
        )
    )
    assert result.success is False
    assert result.rollback_success is False
    pre_manifest = store.read_manifest(result.pre_change_snapshot_id)
    assert pre_manifest is not None
    assert pre_manifest.status == SnapshotStatus.FAILED.value


def test_cleanup_stale_ephemeral_deletes_pending(tmp_path):
    """gc.py's cleanup_stale_ephemeral() is already correct; this confirms
    it actually fires now that PENDING is a reachable status."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000000000Z-share-create"
    store.write_snapshot(
        snapshot_id=snap_id,
        manifest=Manifest(
            id=snap_id,
            timestamp="2026-01-01T00:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            status=SnapshotStatus.PENDING.value,
            type=SnapshotType.EPHEMERAL.value,
        ),
        config_files={},
        runtime_files={},
    )
    gc = GarbageCollector(store, RetentionPolicy())
    cleaned = gc.cleanup_stale_ephemeral()
    assert snap_id in cleaned
    assert store.read_manifest(snap_id) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_ephemeral_retention.py -q`
Expected: `2 failed, 3 passed` —
- `test_ephemeral_snapshot_created_pending` fails: `assert 'applied' == 'pending'`.
- `test_pre_change_ephemeral_marked_failed_when_rollback_also_fails` fails: `assert 'applied' == 'failed'` (old code never marks this branch).
- `test_pre_change_ephemeral_marked_applied_after_successful_apply`, `test_cleanup_stale_ephemeral_deletes_pending` already pass today (see the docstring note on the former; the latter only needed a reachable `PENDING` status to prove it works, and this specific test constructs one directly on disk).

- [ ] **Step 3: Implement the fix — `engine.py` (status assignment)**

Replace the `status=` line inside the `Manifest(...)` construction (Task 4 has already changed the `timestamp=` line above it in the same call — this diff shows the current state after Task 4):

```python
        manifest = Manifest(
            id=snapshot_id,
            timestamp=datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            user=_get_user(),
            source=source,
            preset=preset,
            operation=operation,
            rollback_class=rollback_class,
            status=SnapshotStatus.APPLIED.value,
            type=snapshot_type,
```

with:

```python
        manifest = Manifest(
            id=snapshot_id,
            timestamp=datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            user=_get_user(),
            source=source,
            preset=preset,
            operation=operation,
            rollback_class=rollback_class,
            # specs.md §1 "Snapshot Status Lifecycle": an ephemeral
            # pre-change snapshot starts pending -- the runner moves it to
            # a terminal status once the operation it precedes resolves
            # (see runner.py _mark_pre_change_terminal). Baseline and
            # rollback_eligible snapshots are only ever created AFTER
            # their operation has already succeeded, so applied is correct
            # for them at creation time.
            status=(
                SnapshotStatus.PENDING.value
                if snapshot_type == SnapshotType.EPHEMERAL.value
                else SnapshotStatus.APPLIED.value
            ),
            type=snapshot_type,
```

- [ ] **Step 4: Implement the fix — `runner.py` (`_mark_pre_change_terminal` helper + `_auto_rollback`)**

Add a new helper method to `TransactionalRunner` (near `_auto_rollback`):

```python
    def _mark_pre_change_terminal(
        self, snapshot_id: str, manifest: Manifest, status: SnapshotStatus
    ) -> None:
        """Best-effort: move a pre-change ephemeral snapshot to a terminal
        status once the operation it precedes has resolved (specs.md §1
        "Snapshot Status Lifecycle") so GC / cleanup_stale_ephemeral
        (§7.3) can reclaim it instead of leaving it pending forever."""
        try:
            manifest.status = status.value
            self._store.update_manifest(snapshot_id, manifest)
        except Exception:
            pass  # Non-fatal — the rollback/failure outcome already stands.
```

Then replace `_auto_rollback` (the full method body) — current:

```python
        self._lock.update_journal(phase="rolling_back")

        try:
            pre_manifest = self._store.read_manifest(pre_change_id)
            if pre_manifest is None:
                msg = f"Pre-change snapshot {pre_change_id} not found"
                logger.error("Auto-rollback failed: %s", msg)
                return False, msg

            # Restore set = captured files whose CURRENT live checksum differs
            # from the pre-change capture (current-vs-target, target =
            # pre-change). NOT files_changed (target-vs-parent), which would
            # miss files the forward op changed.
            captured = self._store.list_system_files(pre_change_id)
            current = (await self._collect_current_checksums()).to_dict()
            pre = pre_manifest.checksums or {}
            restore_set = [n for n in captured if current.get(n) != pre.get(n)]

            if not restore_set:
                logger.info(
                    "Auto-rollback for %s: empty restore set, nothing to restore file-level",
                    failed_operation,
                )
                return True, None

            rb_ok = await self._restore_rollback(pre_change_id, restore_set)
            if not rb_ok:
                msg = "File-level rollback failed"
                logger.error("Auto-rollback failed: %s", msg)
                return False, msg

            logger.info("Auto-rollback succeeded for %s", failed_operation)
            # Mark the pre-change snapshot as used for rollback (non-fatal).
            try:
                pre_manifest.status = SnapshotStatus.ROLLED_BACK.value
                self._store.update_manifest(pre_change_id, pre_manifest)
            except Exception:
                pass  # Non-fatal — the rollback itself worked.
            return True, None

        except Exception as exc:
            msg = f"Auto-rollback exception: {exc}"
            logger.exception(msg)
            return False, msg
```

with:

```python
        self._lock.update_journal(phase="rolling_back")

        try:
            pre_manifest = self._store.read_manifest(pre_change_id)
            if pre_manifest is None:
                msg = f"Pre-change snapshot {pre_change_id} not found"
                logger.error("Auto-rollback failed: %s", msg)
                return False, msg

            # Restore set = captured files whose CURRENT live checksum differs
            # from the pre-change capture (current-vs-target, target =
            # pre-change). NOT files_changed (target-vs-parent), which would
            # miss files the forward op changed.
            captured = self._store.list_system_files(pre_change_id)
            current = (await self._collect_current_checksums()).to_dict()
            pre = pre_manifest.checksums or {}
            restore_set = [n for n in captured if current.get(n) != pre.get(n)]

            if not restore_set:
                logger.info(
                    "Auto-rollback for %s: empty restore set, nothing to restore file-level",
                    failed_operation,
                )
                self._mark_pre_change_terminal(
                    pre_change_id, pre_manifest, SnapshotStatus.ROLLED_BACK
                )
                return True, None

            rb_ok = await self._restore_rollback(pre_change_id, restore_set)
            if not rb_ok:
                msg = "File-level rollback failed"
                logger.error("Auto-rollback failed: %s", msg)
                # specs.md §1: forward op AND rollback both failed -- this
                # pre-change ephemeral must reach a terminal status too
                # (failed, retained for forensic review), not silently
                # keep whatever status it was created with.
                self._mark_pre_change_terminal(pre_change_id, pre_manifest, SnapshotStatus.FAILED)
                return False, msg

            logger.info("Auto-rollback succeeded for %s", failed_operation)
            self._mark_pre_change_terminal(pre_change_id, pre_manifest, SnapshotStatus.ROLLED_BACK)
            return True, None

        except Exception as exc:
            msg = f"Auto-rollback exception: {exc}"
            logger.exception(msg)
            with contextlib.suppress(Exception):
                pre_manifest = self._store.read_manifest(pre_change_id)
                if pre_manifest is not None:
                    self._mark_pre_change_terminal(
                        pre_change_id, pre_manifest, SnapshotStatus.FAILED
                    )
            return False, msg
```

- [ ] **Step 5: Implement the fix — `runner.py` (`execute`'s success branch marks its pre-change ephemeral)**

Replace (inside `execute`'s success path, right after `applied_manifest` is created):

```python
                    try:
                        applied_manifest = await self._engine.create_snapshot(
                            source=source,
                            operation=operation,
                            preset=preset,
                            snapshot_type=SnapshotType.ROLLBACK_ELIGIBLE.value,
                            extra_vars=extra_vars,
                            diff_summary=diff_summary,
                        )
                        # Mark as applied (engine already sets status=applied).
                        result.snapshot_id = applied_manifest.id
                        result.success = True
                        self._lock.update_journal(
                            phase="completed",
                            target_snapshot=applied_manifest.id,
                            step_completed="snapshot_applied",
                        )
                        result.steps.append("snapshot_applied")

                        # Run garbage collection (non-fatal).
```

with:

```python
                    try:
                        applied_manifest = await self._engine.create_snapshot(
                            source=source,
                            operation=operation,
                            preset=preset,
                            snapshot_type=SnapshotType.ROLLBACK_ELIGIBLE.value,
                            extra_vars=extra_vars,
                            diff_summary=diff_summary,
                        )
                        # Mark as applied (engine already sets status=applied).
                        result.snapshot_id = applied_manifest.id
                        result.success = True
                        self._lock.update_journal(
                            phase="completed",
                            target_snapshot=applied_manifest.id,
                            step_completed="snapshot_applied",
                        )
                        result.steps.append("snapshot_applied")

                        # specs.md §1: the pre-change ephemeral's operation
                        # completed successfully and was never used for a
                        # rollback -- move it to a terminal status too, so
                        # GC / cleanup_stale_ephemeral (§7.3) can reclaim it.
                        if result.pre_change_snapshot_id:
                            pre_manifest = self._store.read_manifest(
                                result.pre_change_snapshot_id
                            )
                            if pre_manifest is not None:
                                self._mark_pre_change_terminal(
                                    result.pre_change_snapshot_id,
                                    pre_manifest,
                                    SnapshotStatus.APPLIED,
                                )

                        # Run garbage collection (non-fatal).
```

- [ ] **Step 6: Implement the fix — `runner.py` (`execute_restore_snapshot` marks its own pre-restore ephemeral)**

Replace (the tail of `execute_restore_snapshot`, current state after Task 5's `gc_protect_ids` addition to the `create_snapshot` call above this block):

```python
            ok = await self._reconverge(change_set)
            if ok:
                ok = await self._validate_restore()

            if not ok:
                rb_ok = await self._restore_rollback(pre.id, change_set)
                result.rollback_performed = True
                result.rollback_success = rb_ok
                result.error = "restore validation failed; rolled back to pre-change state"
                return result

            result.success = True
            result.steps.append("restore_applied")
            result.output = (
                "recovery applied — desired state unchanged; re-apply or adopt to make it "
                "durable, or the next apply will overwrite it"
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.exception("Restore of %s failed", snapshot_id)
            result.error = f"restore failed: {exc}"
            return result
        finally:
            self._lock.release()
```

with:

```python
            ok = await self._reconverge(change_set)
            if ok:
                ok = await self._validate_restore()

            if not ok:
                rb_ok = await self._restore_rollback(pre.id, change_set)
                result.rollback_performed = True
                result.rollback_success = rb_ok
                result.error = "restore validation failed; rolled back to pre-change state"
                self._mark_pre_change_terminal(
                    pre.id,
                    pre,
                    SnapshotStatus.ROLLED_BACK if rb_ok else SnapshotStatus.FAILED,
                )
                return result

            result.success = True
            result.steps.append("restore_applied")
            result.output = (
                "recovery applied — desired state unchanged; re-apply or adopt to make it "
                "durable, or the next apply will overwrite it"
            )
            self._mark_pre_change_terminal(pre.id, pre, SnapshotStatus.APPLIED)
            return result
        except Exception as exc:  # noqa: BLE001
            logger.exception("Restore of %s failed", snapshot_id)
            result.error = f"restore failed: {exc}"
            if result.pre_change_snapshot_id:
                with contextlib.suppress(Exception):
                    pre_manifest = self._store.read_manifest(result.pre_change_snapshot_id)
                    if pre_manifest is not None:
                        self._mark_pre_change_terminal(
                            result.pre_change_snapshot_id, pre_manifest, SnapshotStatus.FAILED
                        )
            return result
        finally:
            self._lock.release()
```

(`pre` may be undefined if `create_snapshot` itself raised before assigning it — the except block therefore guards on `result.pre_change_snapshot_id`, which is only set the line after `pre.id` succeeds, not on `pre` directly.)

- [ ] **Step 7: Run the tests to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_ephemeral_retention.py -q`
Expected: `5 passed`

- [ ] **Step 8: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass, including `tests/test_auto_rollback_file_level.py` (its assertion `store.read_manifest(pre_id).status == SnapshotStatus.ROLLED_BACK.value` on the successful-rollback path still holds — that path already worked and is unchanged) and `tests/test_execute_restore_snapshot.py`.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/engine.py xinas_history/runner.py tests/test_ephemeral_retention.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/engine.py xinas_history/runner.py tests/test_ephemeral_retention.py`
Expected: `All checks passed!` for both.

- [ ] **Step 9: Commit**

```bash
git add xinas_history/engine.py xinas_history/runner.py tests/test_ephemeral_retention.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): ephemeral pre-change snapshots start pending, resolve to terminal

engine.py hardcoded status=applied for every snapshot type, including
ephemeral pre-change snapshots -- so GC's cleanup_stale_ephemeral() (already
correct) never found a pending snapshot to reclaim (specs.md §1). Ephemeral
snapshots now start pending; the runner moves them to a terminal status
(applied/rolled_back/failed) on every path an operation can resolve through:
successful apply, successful auto-rollback (already handled), rollback ALSO
failing (previously left silently unmarked), and the S11 targeted-restore
path's own pre-restore ephemeral (previously never marked on either outcome).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Real post-apply validation + real post-restore validation

Closes **F-runner-257**. Two related gaps, both in `runner.py` (not `validator.py` — `PostApplyValidator.validate()` already accepts `expected_state`; it is simply never called with one, confirmed by reading `validator.py` in full and grepping for its only call site):

1. `execute()`'s post-apply validation (~lines 248-266) builds a `target_manifest` from `get_current_effective()` (a real `Manifest`, but never referenced inside `PostApplyValidator.validate()`'s body — dead in the sense the finding calls out, but harmless with its one call site, so removing the parameter is left out of scope here to keep this fix minimal) and never passes `expected_state`. With `expected_state=None`, `validate()` degrades `state = {}`, so `check_raid_state`/`check_mount_state`/`check_export_state` all short-circuit to `[]` (verified directly) and only `check_service_active`'s blanket `nfs-server`/`xiraid` liveness check can ever produce a blocker — for ANY operation type.
2. `execute_restore_snapshot`'s `_validate_restore()` is an always-`True` stub (per its own docstring). specs.md §13.2 requires it to actually check that the reconverge step produced the expected state, not trust a zero exit code.

**Files:**
- Modify: `xinas_history/runner.py` (`execute`/`execute_ansible` signatures + post-apply validate call; `_validate_restore` real implementation; its one call site)
- Modify: `tests/test_execute_restore_snapshot.py` (lockstep: `_validate_restore` fake signatures in 2 existing tests; new restore-validation test; strengthen the netplan assertion — see Task 8, same file, separate edit)
- Test: `tests/test_post_apply_validation.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing tests (new file, post-apply half)**

Create `tests/test_post_apply_validation.py`:

```python
"""T4 (F-runner-257): post-apply validation must receive the operation's
expected post-change state (specs.md §13.1), and runner.execute() must
actually thread it through to PostApplyValidator -- not just that the
validator CAN use expected_state if given one (it already could; the bug is
that nothing ever passed it).
"""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest, ValidationResult
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore
from xinas_history.validator import PostApplyValidator


class _FakeInspector:
    """Reports one RAID array, 'data', at level 6."""

    async def raid_show(self, extended: bool = True):
        return True, {"data": {"level": "6"}}, ""


def test_post_apply_validator_catches_raid_level_mismatch():
    validator = PostApplyValidator(_FakeInspector())
    target = Manifest(id="x", timestamp="t", user="root", source="api")
    result = asyncio.run(
        validator.validate(
            target_manifest=target,
            expected_state={"raid_arrays": {"data": {"level": "5"}}},
        )
    )
    assert result.passed is False
    assert any("level mismatch" in b for b in result.blockers)


def test_post_apply_validator_passes_when_state_matches():
    validator = PostApplyValidator(_FakeInspector())
    target = Manifest(id="x", timestamp="t", user="root", source="api")
    result = asyncio.run(
        validator.validate(
            target_manifest=target,
            expected_state={"raid_arrays": {"data": {"level": "6"}}},
        )
    )
    assert result.passed is True


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"EPHEMERAL-LIVE"}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")


class _RecordingValidator:
    """Records the expected_state runner.execute() calls it with, so this
    test proves the RUNNER threads the param through -- not just that the
    validator can use one if handed one directly (the test above)."""

    def __init__(self) -> None:
        self.captured: dict | None = None

    async def validate(self, target_manifest, expected_state=None):
        self.captured = expected_state
        return ValidationResult(passed=True)


def test_execute_threads_expected_state_to_post_apply_validator(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    runner = TransactionalRunner(engine)
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {"etc_exports": str(live_dir / "exports")}  # type: ignore[attr-defined]

    async def _fake_run(argv):
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]

    async def _live_checksums():
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live_checksums  # type: ignore[attr-defined]

    recorder = _RecordingValidator()
    runner._post_apply = recorder  # type: ignore[assignment]

    async def _apply_ok() -> bool:
        return True

    expected = {"exports": [{"path": "/mnt/data"}]}
    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
            expected_state=expected,
        )
    )
    assert result.success is True
    assert recorder.captured == expected
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_post_apply_validation.py -q`
Expected: `2 passed, 1 failed` — the two direct `PostApplyValidator` tests already pass today (the validator itself is correct; confirmed directly: with a fake inspector reporting RAID level 6, `expected_state={"raid_arrays": {"data": {"level": "5"}}}` already yields `passed=False` with blocker `"RAID array 'data' level mismatch: expected 5, got 6"`). `test_execute_threads_expected_state_to_post_apply_validator` fails with `TypeError: execute() got an unexpected keyword argument 'expected_state'` — `execute()` does not accept this parameter today.

- [ ] **Step 3: Implement the fix — `runner.py` (`execute` accepts and threads `expected_state`)**

Replace the `execute()` signature (lines 134-144):

```python
    async def execute(
        self,
        operation: str,
        source: str,
        apply_fn: Callable[[], Awaitable[bool]],
        preset: str = "",
        extra_vars: dict | None = None,
        target_resources: list[str] | None = None,
        diff_summary: str | None = None,
        skip_preflight: bool = False,
    ) -> RunResult:
```

with:

```python
    async def execute(
        self,
        operation: str,
        source: str,
        apply_fn: Callable[[], Awaitable[bool]],
        preset: str = "",
        extra_vars: dict | None = None,
        target_resources: list[str] | None = None,
        diff_summary: str | None = None,
        skip_preflight: bool = False,
        expected_state: dict | None = None,
    ) -> RunResult:
```

Add to the docstring's `Args:` block:

```
            expected_state: The operation's expected post-change runtime
                state (specs.md §13.1) -- e.g.
                ``{"raid_arrays": {"data": {"level": "5"}}}`` for a
                ``raid_modify``, or ``{"exports": [{"path": "/mnt/data"}]}``
                for a ``share_create``. Passed straight to
                PostApplyValidator.validate so post-apply validation checks
                the resources THIS operation changed, not just blanket
                service liveness. ``None`` degrades to the liveness-only
                checks (pre-existing behavior) -- callers that know what
                they changed SHOULD pass it.
```

Then replace the post-apply validate call (~lines 262-266):

```python
                    post_result = await self._post_apply.validate(
                        target_manifest=target_manifest,
                    )
```

with:

```python
                    post_result = await self._post_apply.validate(
                        target_manifest=target_manifest,
                        expected_state=expected_state,
                    )
```

- [ ] **Step 4: Thread `expected_state` through `execute_ansible` too**

Replace the `execute_ansible` signature (lines 385-396):

```python
    async def execute_ansible(
        self,
        operation: str,
        source: str,
        playbook: str = "playbooks/site.yml",
        extra_vars: dict | None = None,
        tags: list[str] | None = None,
        skip_tags: list[str] | None = None,
        preset: str = "",
        target_resources: list[str] | None = None,
        diff_summary: str | None = None,
        progress_cb: Callable[[str], None] | None = None,
    ) -> RunResult:
```

with:

```python
    async def execute_ansible(
        self,
        operation: str,
        source: str,
        playbook: str = "playbooks/site.yml",
        extra_vars: dict | None = None,
        tags: list[str] | None = None,
        skip_tags: list[str] | None = None,
        preset: str = "",
        target_resources: list[str] | None = None,
        diff_summary: str | None = None,
        progress_cb: Callable[[str], None] | None = None,
        expected_state: dict | None = None,
    ) -> RunResult:
```

And replace the inner `execute(...)` call (lines 418-426):

```python
        run_result = await self.execute(
            operation=operation,
            source=source,
            apply_fn=_apply,
            preset=preset,
            extra_vars=extra_vars,
            target_resources=target_resources,
            diff_summary=diff_summary,
        )
```

with:

```python
        run_result = await self.execute(
            operation=operation,
            source=source,
            apply_fn=_apply,
            preset=preset,
            extra_vars=extra_vars,
            target_resources=target_resources,
            diff_summary=diff_summary,
            expected_state=expected_state,
        )
```

(Backward compatible: existing callers that do not pass `expected_state` keep today's liveness-only validation behavior — nothing silently breaks.)

- [ ] **Step 5: Implement the fix — `runner.py` (real `_validate_restore`)**

Replace the stub:

```python
    async def _validate_restore(self) -> bool:
        """Post-restore validation. Best-effort True in this slice (deep link/
        service validation is a follow-on); tests force False to exercise the
        file-level rollback."""
        return True
```

with:

```python
    async def _validate_restore(
        self,
        restore_set: list[str],
        delete_set: list[str],
        target_checksums: dict,
    ) -> bool:
        """Post-restore validation (specs.md §13.2): confirm the reconverge
        step actually produced the expected state for the restored files --
        re-checksum the LIVE managed files AFTER reconverging and compare
        against the target snapshot's checksums, rather than trusting a
        zero exit code from the reconverge commands (a reconverge command
        can exit 0 while leaving the system in a state that does not match
        what was restored)."""
        current = (await self._collect_current_checksums()).to_dict()
        for name in restore_set:
            if current.get(name) != target_checksums.get(name):
                logger.warning(
                    "Post-restore validation: %s checksum mismatch after "
                    "reconverge (expected %s, got %s)",
                    name,
                    target_checksums.get(name),
                    current.get(name),
                )
                return False
        for name in delete_set:
            if current.get(name):
                logger.warning(
                    "Post-restore validation: %s still present after delete",
                    name,
                )
                return False
        return True
```

Then update its one call site inside `execute_restore_snapshot`:

```python
            ok = await self._reconverge(change_set)
            if ok:
                ok = await self._validate_restore()
```

to:

```python
            ok = await self._reconverge(change_set)
            if ok:
                ok = await self._validate_restore(
                    restore_set=restore_set,
                    delete_set=delete_set,
                    target_checksums=target_checksums,
                )
```

(`restore_set`, `delete_set`, and `target_checksums` are already local variables in this method, computed earlier — see the existing code around `restore_set = [n for n in captured if ...]`.)

- [ ] **Step 6: Lockstep fix — `tests/test_execute_restore_snapshot.py` (existing fakes' signatures)**

Two existing tests monkeypatch `runner._validate_restore` with a zero-argument fake; `execute_restore_snapshot` now calls it with three keyword arguments, so both break unless updated. In **both** `test_restore_validation_fail_does_file_level_rollback` and `test_rollback_recreates_deleted_file`, replace:

```python
    async def _fail() -> bool:
        return False

    runner._validate_restore = _fail  # type: ignore[attr-defined]
```

with:

```python
    async def _fail(**kwargs) -> bool:
        return False

    runner._validate_restore = _fail  # type: ignore[attr-defined]
```

(Both occurrences are otherwise identical 4-line blocks; update each in place within its own test function.)

- [ ] **Step 7: Add a real post-restore-validation regression test to the same file**

Append to `tests/test_execute_restore_snapshot.py`:

```python
def test_restore_validation_catches_reconverge_that_lied(tmp_path):
    """Reconverge commands all exit 0, but the live re-checksum taken AFTER
    reconverging still does not match the target -- the real post-restore
    validator (specs.md §13.2) must catch this and roll back; the old
    always-True stub would have reported success."""
    runner, store, target_id, live_dir, commands = _build(
        tmp_path,
        target_system={"etc_exports": b"TARGET-EXPORTS"},
        target_checksums={"etc_exports": "sha256:TARGET"},
    )

    # Live checksum NEVER updates to TARGET, no matter how many times it is
    # collected -- simulates a reconverge that exits 0 without converging.
    async def _live_checksums() -> Checksums:
        return Checksums(etc_exports="sha256:STILL-STALE")

    runner._collect_current_checksums = _live_checksums  # type: ignore[attr-defined]

    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))

    assert result.success is False
    assert result.rollback_performed is True
    assert "validation failed" in (result.error or "")
```

(Reuses the file's existing `_build()` helper and its already-imported `Checksums`/`asyncio` — no new imports needed.)

- [ ] **Step 8: Run the tests to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_post_apply_validation.py tests/test_execute_restore_snapshot.py -q`
Expected: `4 passed` (Task 7's new file) `+` all of `test_execute_restore_snapshot.py`'s tests passed (verified: writing `TARGET-EXPORTS` to disk while `_collect_current_checksums` is pinned to always return `"sha256:STILL-STALE"` makes the new `_validate_restore` correctly detect the mismatch and trigger rollback).

- [ ] **Step 9: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/runner.py tests/test_post_apply_validation.py tests/test_execute_restore_snapshot.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/runner.py tests/test_post_apply_validation.py tests/test_execute_restore_snapshot.py`
Expected: `All checks passed!` for both.

Run: `/tmp/xinas-pytest-venv/bin/pyright xinas_history/runner.py`
Expected: `0 errors, 0 warnings, 0 informations`.

- [ ] **Step 10: Commit**

```bash
git add xinas_history/runner.py tests/test_post_apply_validation.py tests/test_execute_restore_snapshot.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): real post-apply and post-restore validation

execute() built a target_manifest for PostApplyValidator but never passed
expected_state, so every check except the blanket nfs-server/xiraid
liveness probe silently short-circuited to no-op for every operation type
(specs.md §13.1). execute()/execute_ansible() now accept and thread
expected_state through. Separately, execute_restore_snapshot()'s
_validate_restore() was an always-True stub; it now re-checksums the live
managed files AFTER reconverging and compares against the target snapshot,
catching a reconverge command that exits 0 without actually converging
(specs.md §13.2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Netplan reconverge flush parity with `net_controllers` (WS4.3)

Closes **F-runner-519 (HIGH)**. `TransactionalRunner._reconverge_commands`'s netplan branch runs `for t in $(seq 100 199); do ip rule del table $t ...; done` — this deletes **at most one** matching rule per table (the first `ip rule del table $t` call removes one rule; if a table has two rules pointing at it, the second survives) and **never** runs `ip route flush table $t` at all. The authoritative sequence — `collection/roles/net_controllers/tasks/main.yml:126-146` (Ansible's `net_controllers` role, which the plain `netplan apply` in the installer/day-2 path always runs behind) — enumerates and deletes **every** matching rule per table via `ip rule show | grep "lookup $table"`, then explicitly flushes the routing table. Reached from both `_restore_rollback` (auto-rollback) and `execute_restore_snapshot`'s forward path.

**Files:**
- Modify: `xinas_history/runner.py` (`_reconverge_commands`, netplan branch only — the mlx IP-flush block is untouched, out of scope for this finding)
- Modify: `tests/test_execute_restore_snapshot.py` (strengthen `test_reconverge_commands_netplan_includes_flush_and_apply`, which today only asserts substring shape)
- Test: `tests/test_netplan_reconverge_flush_parity.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change — the *Ansible* authoritative sequence this mirrors is unchanged; only the Python-side reconverge command mirroring it is touched).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_netplan_reconverge_flush_parity.py`:

```python
"""T5 (F-runner-519, WS4.3): the S11 restore path's netplan reconverge
flush must match the authoritative sequence in
collection/roles/net_controllers/tasks/main.yml:126-146 -- drain EVERY PBR
rule per table (100-199), not just one, and flush routes per table. The old
sequence ran `ip rule del table $t` once per table, which deletes at most
one matching rule and never touches the routing table itself.
"""

from __future__ import annotations

from xinas_history.runner import TransactionalRunner


def test_netplan_flush_drains_rules_and_flushes_routes_per_table():
    cmds = TransactionalRunner._reconverge_commands(["netplan"])
    flush_cmds = [c for c in cmds if c[0] == "sh" and "ip rule show" in c[2]]
    assert len(flush_cmds) == 1
    script = flush_cmds[0][2]

    # Enumerates every matching rule per table (not a single fixed delete).
    assert "ip rule show | grep" in script
    assert "ip rule del $spec" in script
    # ... and flushes the routing table itself -- the part the old
    # sequence never did at all.
    assert 'ip route flush table "$table"' in script
    # The route flush must be INSIDE the per-table loop (between the inner
    # while-loop's "done" and the outer for-loop's "done"), so it runs once
    # per discovered table, not as a one-shot call outside the loop.
    first_done = script.index("done")
    last_done = script.rindex("done")
    route_flush_pos = script.index('ip route flush table "$table"')
    assert first_done < route_flush_pos < last_done


def test_netplan_flush_precedes_ip_flush_and_apply():
    cmds = TransactionalRunner._reconverge_commands(["netplan"])
    assert ["netplan", "apply"] in cmds
    assert cmds.index(["netplan", "apply"]) == len(cmds) - 1
    rule_flush_idx = next(i for i, c in enumerate(cmds) if "ip rule show" in c[2])
    ip_flush_idx = next(i for i, c in enumerate(cmds) if "ip addr flush" in c[2])
    assert rule_flush_idx < ip_flush_idx < cmds.index(["netplan", "apply"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_netplan_reconverge_flush_parity.py -q`
Expected: `1 failed, 1 passed` — `test_netplan_flush_drains_rules_and_flushes_routes_per_table` fails at `assert "ip rule del $spec" in script` (today's script contains `"ip rule del table $t"`, never `$spec`, and never `ip route flush table`). `test_netplan_flush_precedes_ip_flush_and_apply` already passes today (ordering was already correct; only the flush command's own content is the bug).

- [ ] **Step 3: Implement the fix**

In `xinas_history/runner.py`, inside `_reconverge_commands`, replace the netplan PBR-flush command (the first of the two `cmds.append([...])` calls inside `if "netplan" in names:`):

```python
        if "netplan" in names:
            cmds.append(
                [
                    "sh",
                    "-c",
                    "for t in $(seq 100 199); do ip rule del table $t 2>/dev/null || true; done; true",
                ]
            )
            cmds.append(
                [
                    "sh",
                    "-c",
                    "for i in $(ls /sys/class/net); do case $i in mlx*|ibp*) "
                    "ip addr flush dev $i 2>/dev/null || true ;; esac; done; true",
                ]
            )
            cmds.append(["netplan", "apply"])
```

with:

```python
        if "netplan" in names:
            cmds.append(
                [
                    "sh",
                    "-c",
                    (
                        r"for table in $(ip rule show | grep -oP 'lookup \K(1[0-9]{2})'); do "
                        'ip rule show | grep "lookup $table" | while IFS=: read -r _ spec; do '
                        "ip rule del $spec 2>/dev/null || true; done; "
                        'ip route flush table "$table" 2>/dev/null || true; done; true'
                    ),
                ]
            )
            cmds.append(
                [
                    "sh",
                    "-c",
                    "for i in $(ls /sys/class/net); do case $i in mlx*|ibp*) "
                    "ip addr flush dev $i 2>/dev/null || true ;; esac; done; true",
                ]
            )
            cmds.append(["netplan", "apply"])
```

(The mlx IP-flush block below it is unchanged — the finding is specifically about the PBR-rule/route flush, and this diff does not touch that block. Shell syntax verified directly with `sh -n`; the Python string literal's byte-for-byte output was verified to match; `ruff format` verified to leave this exact structure unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_netplan_reconverge_flush_parity.py -q`
Expected: `2 passed`

- [ ] **Step 5: Strengthen the existing weak assertion in `tests/test_execute_restore_snapshot.py`**

Replace:

```python
def test_reconverge_commands_netplan_includes_flush_and_apply():
    cmds = TransactionalRunner._reconverge_commands(["netplan"])
    assert ["netplan", "apply"] in cmds
    # PBR-flush + IP-flush precede the apply (the documented sequence).
    assert any("ip rule del table" in " ".join(c) for c in cmds)
    assert cmds.index(["netplan", "apply"]) == len(cmds) - 1
```

with:

```python
def test_reconverge_commands_netplan_includes_flush_and_apply():
    cmds = TransactionalRunner._reconverge_commands(["netplan"])
    assert ["netplan", "apply"] in cmds
    # PBR-flush + IP-flush precede the apply (the documented sequence).
    # Must drain EVERY rule per table via `ip rule del $spec` (not the old
    # single fixed `ip rule del table $t`) AND flush the routing table
    # itself -- see tests/test_netplan_reconverge_flush_parity.py for the
    # full per-table-drain assertions.
    assert any("ip rule del $spec" in " ".join(c) for c in cmds)
    assert any('ip route flush table "$table"' in " ".join(c) for c in cmds)
    assert cmds.index(["netplan", "apply"]) == len(cmds) - 1
```

- [ ] **Step 6: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/runner.py tests/test_netplan_reconverge_flush_parity.py tests/test_execute_restore_snapshot.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/runner.py tests/test_netplan_reconverge_flush_parity.py tests/test_execute_restore_snapshot.py`
Expected: `All checks passed!` for both.

- [ ] **Step 7: Commit**

```bash
git add xinas_history/runner.py tests/test_netplan_reconverge_flush_parity.py tests/test_execute_restore_snapshot.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): netplan reconverge flush drains every PBR rule + routes

_reconverge_commands's netplan branch ran `ip rule del table $t` once per
table (100-199) -- deleting at most one matching rule per table -- and never
ran `ip route flush table $t` at all. Mirrors the authoritative sequence in
collection/roles/net_controllers/tasks/main.yml:126-146 instead: enumerate
and delete every matching rule per table via `ip rule show | grep`, then
flush the routing table. Strengthened the existing test, which only
asserted substring shape and would not have caught this.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Lock stale-recovery TOCTOU + EPERM-means-alive

Closes **F-lock-305**. Two bugs in `xinas_history/lock.py`, both confirmed by reading the code and by directly reproducing the flock semantics they depend on (`flock(LOCK_EX | LOCK_NB)` on the same file from a second fd — even from the same process — fails immediately with `BlockingIOError`, verified directly):

1. `recover_stale_lock()` clears `lock.meta`/`journal.yml` without ever holding the `flock` (its own comment admits this: `"Clear the stale lock files (but NOT the flock file descriptor since we don't hold it)"`). This is a TOCTOU race: between `check_stale_lock()` deciding the old holder's PID is dead and `recover_stale_lock()` clearing the files, a **different, live** process's `acquire()` can win the flock, write its own fresh `lock.meta`/`journal.yml`, and then have that fresh metadata deleted out from under it by this "recovery" pass — specs.md §6.5 requires holding the flock across the clear so this window cannot open.
2. `check_stale_lock()`'s liveness check catches `(OSError, ValueError)` as a single "process is gone" branch. `os.kill(pid, 0)` raising `PermissionError` (`EPERM` — the process exists but is owned by another user) is folded into the same branch as `ProcessLookupError` (`ESRCH` — the process is truly gone), even though both are `OSError` subclasses that must be told apart: `EPERM` means **alive**, not stale.

**Files:**
- Modify: `xinas_history/lock.py` (`check_stale_lock`, `recover_stale_lock`)
- Test: `tests/test_lock_stale_recovery.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_lock_stale_recovery.py`:

```python
"""T6 (F-lock-305): stale-lock recovery must hold the flock across the
clear (specs.md §6.5 TOCTOU guard), and the liveness check must treat
EPERM as "alive", not "stale" -- both currently OSError subclasses folded
into one branch.
"""

from __future__ import annotations

import xinas_history.lock as lock_module
from xinas_history.lock import GlobalConfigLock


def test_check_stale_lock_eperm_means_alive_not_stale(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "lock.meta").write_text('{"pid": 42, "operation": "raid_create"}')

    def _fake_kill(pid, sig):
        raise PermissionError("owned by another user")

    monkeypatch.setattr(lock_module.os, "kill", _fake_kill)

    lock = GlobalConfigLock(str(state_dir))
    assert lock.check_stale_lock() is None


def test_check_stale_lock_esrch_means_stale(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "lock.meta").write_text('{"pid": 42, "operation": "raid_create"}')

    def _fake_kill(pid, sig):
        raise ProcessLookupError("no such process")

    monkeypatch.setattr(lock_module.os, "kill", _fake_kill)

    lock = GlobalConfigLock(str(state_dir))
    info = lock.check_stale_lock()
    assert info is not None
    assert info["pid"] == 42


def test_recover_stale_lock_clears_files_when_truly_stale(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "lock.meta").write_text('{"pid": 999999, "operation": "raid_create"}')
    (state_dir / "journal.yml").write_text("phase: executing\n")

    lock = GlobalConfigLock(str(state_dir))
    report = lock.recover_stale_lock()

    assert report["recovered"] is True
    assert not (state_dir / "lock.meta").exists()
    assert not (state_dir / "journal.yml").exists()


def test_recover_stale_lock_does_not_clobber_a_freshly_acquired_lock(tmp_path):
    """specs.md §6.5 TOCTOU guard: if another process's acquire() wins the
    flock in the window between "we decided the old holder is dead" and
    "we clear the files", recovery must NOT delete that fresh holder's
    lock.meta/journal.yml."""
    state_dir = tmp_path / "state"
    # Simulate a dead holder's leftover metadata (no flock held by anyone
    # yet -- as if the process crashed and the kernel released its flock
    # on exit, which is the real-world precondition for this scenario).
    state_dir.mkdir(parents=True)
    (state_dir / "lock.meta").write_text('{"pid": 999999, "operation": "raid_create"}')
    (state_dir / "journal.yml").write_text("phase: executing\n")

    # A second, live process wins the race and acquires the REAL lock
    # first, writing its OWN fresh metadata.
    new_holder = GlobalConfigLock(str(state_dir))
    new_holder.acquire(operation="fs_create", source="api")
    try:
        stale_lock = GlobalConfigLock(str(state_dir))
        report = stale_lock.recover_stale_lock()

        assert report["recovered"] is False
        # The fresh holder's metadata must be untouched.
        info = new_holder.get_lock_info()
        assert info is not None
        assert info["operation"] == "fs_create"
        journal = new_holder.get_journal()
        assert journal is not None
        assert journal["operation"] == "fs_create"
    finally:
        new_holder.release()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_lock_stale_recovery.py -q`
Expected: `2 failed, 2 passed` —
- `test_check_stale_lock_eperm_means_alive_not_stale` fails: `assert <dict> is None` (today's `except (OSError, ValueError): return info` treats the `PermissionError` the same as a dead process).
- `test_recover_stale_lock_does_not_clobber_a_freshly_acquired_lock` fails at its first assertion, `assert report["recovered"] is False`: today's `recover_stale_lock()` hardcodes `report["recovered"] = True` at the top and never revisits it, so this is `assert True is False`. (Even if that assertion were removed, the next one would also fail — today's method unconditionally calls `_clear_lock_files()`, wiping the fresh holder's `lock.meta`/`journal.yml`, so `new_holder.get_lock_info()` would return `None`.)
- `test_check_stale_lock_esrch_means_stale` and `test_recover_stale_lock_clears_files_when_truly_stale` already pass today (old code already treats `ProcessLookupError` as stale, and already clears files unconditionally when nothing else holds the flock).

- [ ] **Step 3: Implement the fix — `check_stale_lock` (EPERM vs. ESRCH)**

Replace:

```python
    def check_stale_lock(self) -> dict | None:
        """Check for a stale lock from a crashed process.

        Returns lock info dict if a stale lock is found, None otherwise.
        A lock is stale if the PID in lock.meta is no longer running.
        """
        info = self.get_lock_info()
        if info is None:
            return None

        pid = info.get("pid")
        if pid is None:
            return None

        try:
            os.kill(int(pid), 0)
            # Process still alive — not stale.
            return None
        except (OSError, ValueError):
            # Process gone — stale.
            return info
```

with:

```python
    def check_stale_lock(self) -> dict | None:
        """Check for a stale lock from a crashed process.

        Returns lock info dict if a stale lock is found, None otherwise.
        A lock is stale only when the PID in lock.meta no longer exists
        (ProcessLookupError / ESRCH). A PID that exists but is owned by
        another user (PermissionError / EPERM) means the process is
        alive -- NOT stale -- even though both are OSError subclasses
        (specs.md §6.5).
        """
        info = self.get_lock_info()
        if info is None:
            return None

        pid = info.get("pid")
        if pid is None:
            return None

        try:
            os.kill(int(pid), 0)
            # Process still alive — not stale.
            return None
        except ProcessLookupError:
            # Process gone — genuinely stale.
            return info
        except PermissionError:
            # Process exists but is owned by another user — alive, NOT stale.
            return None
        except ValueError:
            # Malformed PID in lock.meta — cannot verify liveness; do not
            # assume stale from a parsing failure alone.
            return None
```

- [ ] **Step 4: Implement the fix — `recover_stale_lock` (hold the flock across the clear)**

Replace the tail of `recover_stale_lock` (from the `else:` branch of the phase-classification through the end of the method):

```python
        else:
            report["action"] = "clear: unknown phase, lock files removed"

        # Clear the stale lock files (but NOT the flock file descriptor
        # since we don't hold it).
        self._clear_lock_files()

        return report
```

with:

```python
        else:
            report["action"] = "clear: unknown phase, lock files removed"

        # specs.md §6.5: clearing lock.meta/journal.yml MUST happen while
        # holding the flock that detected the stale lock, so a second
        # process's acquire() (which grabs the flock, writes its OWN fresh
        # lock.meta/journal.yml) can never have that fresh metadata deleted
        # out from under it by this recovery pass. If we cannot get the
        # flock, someone else legitimately holds it now — leave the files
        # alone entirely.
        self._state_dir.mkdir(parents=True, exist_ok=True)
        lock_path = self._state_dir / self.LOCK_FILE
        fd = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            report["recovered"] = False
            report["action"] = "skipped: lock is now held by another live process"
            return report

        try:
            self._clear_lock_files()
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            with contextlib.suppress(OSError):
                os.close(fd)

        return report
```

(`fcntl`, `os`, and `contextlib` are already imported at the top of `lock.py` — no new imports needed.)

- [ ] **Step 5: Run the tests to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_lock_stale_recovery.py -q`
Expected: `4 passed`

- [ ] **Step 6: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass — no existing test exercises `recover_stale_lock()` under a concurrently-held flock, and `check_stale_lock()`'s `ProcessLookupError`/genuinely-dead-PID path is unaffected.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/lock.py tests/test_lock_stale_recovery.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/lock.py tests/test_lock_stale_recovery.py`
Expected: `All checks passed!` for both.

- [ ] **Step 7: Commit**

```bash
git add xinas_history/lock.py tests/test_lock_stale_recovery.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): lock stale-recovery TOCTOU + EPERM-means-alive

recover_stale_lock() cleared lock.meta/journal.yml without ever holding the
flock, opening a window where a second process's fresh acquire() could have
its own just-written metadata deleted out from under it (specs.md §6.5). It
now acquires the flock itself before clearing, and skips clearing entirely
if another live process already holds it. Separately, check_stale_lock()
folded PermissionError (EPERM -- process alive, owned by another user) into
the same branch as ProcessLookupError (ESRCH -- process genuinely gone);
EPERM is now correctly treated as "not stale".

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Mount-unit drift on checksum + enabled state (WS4)

Closes **F-drift-458**. `DriftDetector._check_mount_units` decides drift almost entirely from `_get_live_mount_state`'s live `ActiveState`/`SubState` (via `systemctl show`); the unit-file content checksum it computes (`current_cksum`) is only ever used as a fallback when the live-state query itself fails, never compared against a historical baseline. There is, in fact, no historical baseline to compare against today: the collector (`collector.py::_collect_mounts_sync`) never records a unit-file checksum or enabled-state at snapshot-creation time — only `{unit, active, sub, description}`. specs.md §9.4 requires the decision to be unit-file checksum + enabled state, with live active/sub reported as supplementary detail only, never the sole basis, so this task extends both the collector (to actually capture a baseline) and the detector (to decide on it).

**Files:**
- Modify: `xinas_history/collector.py` (`RuntimeCollector._collect_mounts_sync` — capture `checksum` + `enabled` per unit)
- Modify: `xinas_history/drift.py` (`_get_live_mount_state` — add `enabled` via `UnitFileState`; `_check_mount_units` — decide on checksum/enabled first, active/sub as supplementary fallback only)
- Test: `tests/test_mount_unit_drift.py` (new)

**Requires-Rebuild:** NO (pure `.py` library change — the new `mounts.json` fields are additive; snapshots taken before this change simply have no `checksum`/`enabled` fields, and the detector treats that as "no baseline to compare" rather than a false positive).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_mount_unit_drift.py`:

```python
"""T7 (F-drift-458): systemd mount-unit drift must be decided by unit-file
checksum + enabled state (specs.md §9.4), not merely live ActiveState/
SubState -- a changed unit file that has not been re-activated yet must
still register as drift.
"""

from __future__ import annotations

import hashlib
import json

from xinas_history.drift import DriftDetector
from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore

_UNIT_BYTES = b"REAL-UNIT-FILE-CONTENT"
_UNIT_CKSUM = f"sha256:{hashlib.sha256(_UNIT_BYTES).hexdigest()}"
_CHANGED_BYTES = b"CHANGED-UNIT-FILE-CONTENT"


def _write_snapshot_with_mount(store, snapshot_id, *, checksum, enabled, active="active", sub="mounted"):
    mounts_payload = json.dumps(
        {
            "units": [
                {
                    "unit": "mnt-data.mount",
                    "active": active,
                    "sub": sub,
                    "description": "Data mount",
                    "checksum": checksum,
                    "enabled": enabled,
                }
            ]
        }
    ).encode()
    store.write_snapshot(
        snapshot_id=snapshot_id,
        manifest=Manifest(
            id=snapshot_id, timestamp="2026-07-11T00:00:00Z", user="root", source="api"
        ),
        config_files={},
        runtime_files={"mounts.json": mounts_payload},
    )


def _same_live_state(unit_name):
    return {"unit": unit_name, "active": "active", "sub": "mounted", "description": "Data mount"}


def test_unit_file_checksum_change_is_drift_even_when_active_sub_unchanged(tmp_path, monkeypatch):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000Z-install"
    _write_snapshot_with_mount(store, snap_id, checksum=_UNIT_CKSUM, enabled="enabled")

    detector = DriftDetector(store=store, repo_root=str(tmp_path))

    # Live active/sub state is UNCHANGED from the snapshot -- the old
    # decision logic would call this "no drift". Enabled state is also
    # unchanged; only the unit file's content differs.
    monkeypatch.setattr(
        DriftDetector, "_get_live_mount_state", staticmethod(lambda unit_name: {**_same_live_state(unit_name), "enabled": "enabled"})
    )
    monkeypatch.setattr(DriftDetector, "_read_file_bytes", staticmethod(lambda path: _CHANGED_BYTES))

    entries = detector._check_mount_units(snap_id, store.read_manifest(snap_id))
    assert len(entries) == 1
    assert "content changed" in entries[0].detail
    assert entries[0].artifact_class == "service"


def test_no_drift_when_checksum_enabled_and_state_all_match(tmp_path, monkeypatch):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000Z-install"
    _write_snapshot_with_mount(store, snap_id, checksum=_UNIT_CKSUM, enabled="enabled")

    detector = DriftDetector(store=store, repo_root=str(tmp_path))
    monkeypatch.setattr(
        DriftDetector, "_get_live_mount_state", staticmethod(lambda unit_name: {**_same_live_state(unit_name), "enabled": "enabled"})
    )
    monkeypatch.setattr(DriftDetector, "_read_file_bytes", staticmethod(lambda path: _UNIT_BYTES))

    entries = detector._check_mount_units(snap_id, store.read_manifest(snap_id))
    assert entries == []


def test_enabled_state_change_is_drift_even_when_checksum_and_state_match(tmp_path, monkeypatch):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000Z-install"
    _write_snapshot_with_mount(store, snap_id, checksum=_UNIT_CKSUM, enabled="enabled")

    detector = DriftDetector(store=store, repo_root=str(tmp_path))
    monkeypatch.setattr(
        DriftDetector, "_get_live_mount_state", staticmethod(lambda unit_name: {**_same_live_state(unit_name), "enabled": "disabled"})
    )
    monkeypatch.setattr(DriftDetector, "_read_file_bytes", staticmethod(lambda path: _UNIT_BYTES))

    entries = detector._check_mount_units(snap_id, store.read_manifest(snap_id))
    assert len(entries) == 1
    assert "enabled state changed" in entries[0].detail


def test_pre_existing_snapshot_with_no_baseline_falls_back_to_active_sub(tmp_path, monkeypatch):
    """A snapshot taken before this fix has no checksum/enabled fields at
    all -- nothing to compare, so this unit falls back to the prior
    active/sub-only behavior rather than a false positive."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000Z-install"
    _write_snapshot_with_mount(store, snap_id, checksum="", enabled="")

    detector = DriftDetector(store=store, repo_root=str(tmp_path))
    monkeypatch.setattr(
        DriftDetector, "_get_live_mount_state", staticmethod(lambda unit_name: {**_same_live_state(unit_name), "enabled": "enabled"})
    )
    monkeypatch.setattr(DriftDetector, "_read_file_bytes", staticmethod(lambda path: _CHANGED_BYTES))

    entries = detector._check_mount_units(snap_id, store.read_manifest(snap_id))
    assert entries == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_mount_unit_drift.py -q`
Expected: `2 failed, 2 passed` —
- `test_unit_file_checksum_change_is_drift_even_when_active_sub_unchanged` fails: `assert 1 == 0` on `len(entries)` (today's code compares live active/sub against the snapshot's recorded active/sub, finds them equal, and `continue`s — the changed unit-file content is never checked at all).
- `test_enabled_state_change_is_drift_even_when_checksum_and_state_match` fails the same way (`enabled` is not read from `mounts.json` anywhere in today's code).
- `test_no_drift_when_checksum_enabled_and_state_all_match` and `test_pre_existing_snapshot_with_no_baseline_falls_back_to_active_sub` already pass today (both scenarios happen to already read "no drift" under the old active/sub-only logic, coincidentally).

- [ ] **Step 3: Implement the fix — `collector.py` (capture checksum + enabled)**

In `xinas_history/collector.py`, replace `_collect_mounts_sync` (lines 222-266):

```python
    @staticmethod
    def _collect_mounts_sync() -> dict:
        """Synchronous mount unit collection."""
        try:
            result = subprocess.run(
                [
                    "systemctl",
                    "list-units",
                    "*.mount",
                    "--output=json",
                    "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return {"error": f"systemctl rc={result.returncode}", "units": []}

            all_units = json.loads(result.stdout) if result.stdout.strip() else []

            # Filter for xiNAS-managed mount units:
            # those backed by unit files in /etc/systemd/system/
            xinas_mounts = []
            for unit in all_units:
                unit_name = unit.get("unit", "")
                if not unit_name.endswith(".mount"):
                    continue
                # Check if unit file is in /etc/systemd/system/ (xiNAS-managed)
                unit_file_path = f"/etc/systemd/system/{unit_name}"
                if os.path.isfile(unit_file_path):
                    xinas_mounts.append(
                        {
                            "unit": unit_name,
                            "active": unit.get("active", ""),
                            "sub": unit.get("sub", ""),
                            "description": unit.get("description", ""),
                        }
                    )

            return {"units": xinas_mounts}
        except subprocess.TimeoutExpired:
            return {"error": "systemctl timeout", "units": []}
        except (json.JSONDecodeError, OSError) as exc:
            return {"error": str(exc), "units": []}
```

with:

```python
    @staticmethod
    def _collect_mounts_sync() -> dict:
        """Synchronous mount unit collection."""
        try:
            result = subprocess.run(
                [
                    "systemctl",
                    "list-units",
                    "*.mount",
                    "--output=json",
                    "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return {"error": f"systemctl rc={result.returncode}", "units": []}

            all_units = json.loads(result.stdout) if result.stdout.strip() else []

            # Filter for xiNAS-managed mount units:
            # those backed by unit files in /etc/systemd/system/
            xinas_mounts = []
            for unit in all_units:
                unit_name = unit.get("unit", "")
                if not unit_name.endswith(".mount"):
                    continue
                # Check if unit file is in /etc/systemd/system/ (xiNAS-managed)
                unit_file_path = f"/etc/systemd/system/{unit_name}"
                if os.path.isfile(unit_file_path):
                    xinas_mounts.append(
                        {
                            "unit": unit_name,
                            "active": unit.get("active", ""),
                            "sub": unit.get("sub", ""),
                            "description": unit.get("description", ""),
                            # specs.md §9.4: captured so drift.py can decide
                            # on unit-file content + enabled state, not just
                            # live active/sub.
                            "checksum": RuntimeCollector._sha256_file(unit_file_path),
                            "enabled": RuntimeCollector._is_enabled(unit_name),
                        }
                    )

            return {"units": xinas_mounts}
        except subprocess.TimeoutExpired:
            return {"error": "systemctl timeout", "units": []}
        except (json.JSONDecodeError, OSError) as exc:
            return {"error": str(exc), "units": []}

    @staticmethod
    def _is_enabled(unit_name: str) -> str:
        """`systemctl is-enabled <unit>` output (e.g. "enabled", "disabled",
        "static"). Empty string if the check fails -- callers must treat
        that as "unknown", not a specific state."""
        try:
            result = subprocess.run(
                ["systemctl", "is-enabled", unit_name],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip()
        except (subprocess.TimeoutExpired, OSError):
            return ""
```

(`RuntimeCollector._sha256_file` already exists in this file, used the same way by `_collect_exports_sync`.)

- [ ] **Step 4: Implement the fix — `drift.py` (`_get_live_mount_state` adds `enabled`)**

Replace `_get_live_mount_state` (lines 557-595):

```python
    @staticmethod
    def _get_live_mount_state(unit_name: str) -> dict | None:
        """Query systemd for the current state of a mount unit.

        Returns a dict with ``unit``, ``active``, ``sub``, ``description``
        keys to mirror the snapshot format, or ``None`` on failure.
        """
        import subprocess

        try:
            result = subprocess.run(
                [
                    "systemctl",
                    "show",
                    unit_name,
                    "--property=ActiveState,SubState,Description",
                    "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return None

            props: dict[str, str] = {}
            for line in result.stdout.strip().splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    props[key.strip()] = value.strip()

            return {
                "unit": unit_name,
                "active": props.get("ActiveState", ""),
                "sub": props.get("SubState", ""),
                "description": props.get("Description", ""),
            }
        except (subprocess.TimeoutExpired, OSError):
            return None
```

with:

```python
    @staticmethod
    def _get_live_mount_state(unit_name: str) -> dict | None:
        """Query systemd for the current state of a mount unit.

        Returns a dict with ``unit``, ``active``, ``sub``, ``description``,
        and ``enabled`` (systemd's ``UnitFileState`` -- "enabled",
        "disabled", "static", etc., mirroring plain ``systemctl
        is-enabled``, fetched in the same call rather than a second
        subprocess) keys, or ``None`` on failure.
        """
        import subprocess

        try:
            result = subprocess.run(
                [
                    "systemctl",
                    "show",
                    unit_name,
                    "--property=ActiveState,SubState,Description,UnitFileState",
                    "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return None

            props: dict[str, str] = {}
            for line in result.stdout.strip().splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    props[key.strip()] = value.strip()

            return {
                "unit": unit_name,
                "active": props.get("ActiveState", ""),
                "sub": props.get("SubState", ""),
                "description": props.get("Description", ""),
                "enabled": props.get("UnitFileState", ""),
            }
        except (subprocess.TimeoutExpired, OSError):
            return None
```

- [ ] **Step 5: Implement the fix — `drift.py` (`_check_mount_units` decision logic)**

Replace the entire `_check_mount_units` method (lines 380-486) with:

```python
    def _check_mount_units(
        self,
        snapshot_id: str,
        manifest,
    ) -> list[DriftEntry]:
        """Check xiNAS-managed systemd mount units for drift.

        Decision (specs.md §9.4): unit-file content checksum + enabled
        state, compared against what was recorded in the snapshot. Live
        ActiveState/SubState is supplementary detail only -- a changed unit
        file or enabled state registers as drift even when the unit is
        still active/mounted exactly as before.
        """
        entries: list[DriftEntry] = []

        snapshot_mounts = self._read_snapshot_runtime(
            snapshot_id,
            manifest,
            "mounts.json",
        )
        if snapshot_mounts is None:
            return entries

        try:
            mounts_data = json.loads(snapshot_mounts)
        except (json.JSONDecodeError, ValueError):
            logger.warning(
                "Could not parse mounts.json from snapshot %s",
                snapshot_id,
            )
            return entries

        units = mounts_data.get("units", [])
        if not units:
            return entries

        for unit_info in units:
            unit_name = unit_info.get("unit", "")
            if not unit_name:
                continue

            unit_file = f"/etc/systemd/system/{unit_name}"
            current_bytes = self._read_file_bytes(unit_file)
            current_cksum = self._sha256(current_bytes) if current_bytes is not None else ""
            live_state = self._get_live_mount_state(unit_name)

            if not current_cksum and not live_state:
                entries.append(
                    self._mount_drift_entry(
                        unit_file,
                        unit_info.get("checksum", ""),
                        current_cksum,
                        f"{unit_name}: mount unit removed from system",
                    )
                )
                continue

            # Pre-existing snapshots recorded no checksum/enabled fields at
            # all -- nothing to compare, so this unit falls back to no
            # content/enabled-based finding (there is no baseline to check
            # against) rather than a false positive.
            previous_cksum = unit_info.get("checksum", "")
            previous_enabled = unit_info.get("enabled", "")
            has_baseline = bool(previous_cksum) or bool(previous_enabled)

            current_enabled = live_state.get("enabled", "") if live_state else ""
            content_changed = bool(previous_cksum) and previous_cksum != current_cksum
            enabled_changed = bool(previous_enabled) and previous_enabled != current_enabled

            if has_baseline and (content_changed or enabled_changed):
                bits = []
                if content_changed:
                    bits.append("unit file content changed on disk")
                if enabled_changed:
                    bits.append(
                        f"enabled state changed from {previous_enabled} to {current_enabled}"
                    )
                entries.append(
                    self._mount_drift_entry(
                        unit_file,
                        previous_cksum,
                        current_cksum,
                        f"{unit_name}: " + "; ".join(bits),
                    )
                )
                continue

            # Live active/sub state: supplementary only -- reported ONLY
            # when content/enabled already matched (or there is no
            # baseline to check), preserving the pre-§9.4 behavior as the
            # fallback tier, never the sole basis when a baseline exists.
            if live_state:
                snap_active = unit_info.get("active", "")
                snap_sub = unit_info.get("sub", "")
                live_active = live_state.get("active", "")
                live_sub = live_state.get("sub", "")
                if snap_active != live_active or snap_sub != live_sub:
                    entries.append(
                        self._mount_drift_entry(
                            unit_file,
                            previous_cksum,
                            current_cksum,
                            f"{unit_name}: state changed from {snap_active}/{snap_sub} "
                            f"to {live_active}/{live_sub}",
                            is_semantic=True,
                        )
                    )

        return entries

    def _mount_drift_entry(
        self,
        unit_file: str,
        previous_cksum: str,
        current_cksum: str,
        detail: str,
        is_semantic: bool = False,
    ) -> DriftEntry:
        policy = self._get_policy("systemd_mount")
        safety = self._determine_safety_impact(unit_file, policy)
        return DriftEntry(
            artifact=unit_file,
            artifact_class="service",
            previous_checksum=previous_cksum,
            current_checksum=current_cksum,
            is_semantic=is_semantic,
            safety_impact=safety,
            policy=policy.value,
            detail=detail,
        )
```

- [ ] **Step 6: Run the tests to verify green**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_mount_unit_drift.py -q`
Expected: `4 passed`

- [ ] **Step 7: Run the full regression suite + lint**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass — no existing test asserts on `mounts.json`'s exact field set or `_check_mount_units`'s old active/sub-only decision.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_history/collector.py xinas_history/drift.py tests/test_mount_unit_drift.py && /tmp/xinas-pytest-venv/bin/ruff format --check xinas_history/collector.py xinas_history/drift.py tests/test_mount_unit_drift.py`
Expected: `All checks passed!` for both.

Run: `/tmp/xinas-pytest-venv/bin/pyright xinas_history/collector.py xinas_history/drift.py`
Expected: `0 errors, 0 warnings, 0 informations`.

- [ ] **Step 8: Commit**

```bash
git add xinas_history/collector.py xinas_history/drift.py tests/test_mount_unit_drift.py
git commit -m "$(cat <<'EOF'
fix(xinas_history): mount-unit drift decided by checksum + enabled state

_check_mount_units decided drift almost entirely on live ActiveState/
SubState; the unit-file checksum it computed was only ever used as a
fallback, and there was no recorded historical checksum/enabled baseline to
compare against in the first place (specs.md §9.4). The collector now
captures a unit-file checksum and `systemctl is-enabled` state per managed
mount unit at snapshot time; the detector decides on those first, with live
active/sub reported as supplementary detail only -- a changed unit file
that has not been re-activated yet now registers as drift instead of being
masked by a liveness check that happens to still match.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Bookkeeping (tick WS4.1–WS4.4 + status line) + full gate

Ticks the master tracker and runs the complete verification gate across everything Tasks 1-10 touched. Folds in what the original decomposition called a separate "T8" (WS4.4 — spec/CLI reconciliation): that reconciliation is pure documentation and was **already fully landed in commit `3b90da2`** (which added specs.md §11.10 "Removed from this spec (never implemented)" and reconciled `requirements.md:58`'s retention language with the implemented GC policy) before this plan's Task 1 started — there is no remaining code or doc change for WS4.4 beyond ticking its checkbox here, so giving it its own task would produce an empty diff. This is a deliberate deviation from the given decomposition, stated with reason per the brief's "adjust with reason" instruction.

**Files:**
- Modify: `docs/plans/2026-07-07-codebase-review-remediation-plan.md` (tick WS4.1–WS4.4, add a status line)

**Requires-Rebuild:** NO (docs-only change).

- [ ] **Step 1: Tick WS4.1–WS4.4**

In `docs/plans/2026-07-07-codebase-review-remediation-plan.md`, replace:

```markdown
- [ ] **WS4.1** Write `docs/plans/2026-MM-DD-xinas-history-hardening-plan.md`
  covering the table above with TDD tasks (each fix has an obvious failing
  test: traversal id, tmp-dir listing, GC-during-restore, classifier default,
  ID collision, lock TOCTOU).
- [ ] **WS4.2** Quick safe fixes that need no design: reject snapshot ids not
  matching `^[A-Za-z0-9._-]+$` in `store.py`; filter `.tmp-*` in
  `list_snapshots`; flip classifier default to `DESTROYING_DATA` (fail safe);
  replace `utcnow()` with `datetime.now(timezone.utc)`; add a monotonic
  suffix/UUID to snapshot IDs.
- [ ] **WS4.3** The netplan reconverge flush (`runner.py:519`) must reuse or
  mirror the one authoritative flush implementation (see WS7 note on
  spec-network-management ownership) — loop `while ip rule del` per table
  100-199 and flush mlx IPs, same as `net_controllers`.
- [ ] **WS4.4** Sync `docs/config-history/specs.md` §11 with the real CLI
  (`snapshot rollback`, `drift check`, `lock status|clear` documented but not
  implemented; `snapshot restore`/`reset-to-baseline` exist) and
  `requirements.md:58` retention language with the implemented GC policy —
  or implement the missing subcommands (decision needed).
```

with:

```markdown
- [x] **WS4.1** Write `docs/plans/2026-MM-DD-xinas-history-hardening-plan.md`
  covering the table above with TDD tasks (each fix has an obvious failing
  test: traversal id, tmp-dir listing, GC-during-restore, classifier default,
  ID collision, lock TOCTOU).
- [x] **WS4.2** Quick safe fixes that need no design: reject snapshot ids not
  matching `^[A-Za-z0-9._-]+$` in `store.py`; filter `.tmp-*` in
  `list_snapshots`; flip classifier default to `DESTROYING_DATA` (fail safe);
  replace `utcnow()` with `datetime.now(timezone.utc)`; add a monotonic
  suffix/UUID to snapshot IDs.
- [x] **WS4.3** The netplan reconverge flush (`runner.py:519`) must reuse or
  mirror the one authoritative flush implementation (see WS7 note on
  spec-network-management ownership) — loop `while ip rule del` per table
  100-199 and flush mlx IPs, same as `net_controllers`.
- [x] **WS4.4** Sync `docs/config-history/specs.md` §11 with the real CLI
  (`snapshot rollback`, `drift check`, `lock status|clear` documented but not
  implemented; `snapshot restore`/`reset-to-baseline` exist) and
  `requirements.md:58` retention language with the implemented GC policy —
  or implement the missing subcommands (decision needed).
```

(Text left verbatim — WS4.1's mention of "ID collision" and WS4.2's "add a monotonic suffix/UUID to snapshot IDs" describe scope from the original authoring date; both were already fixed upstream before this plan started, per the re-baseline note earlier in the same document. Only the checkboxes are flipped here.)

- [ ] **Step 2: Add a status line**

Immediately below the WS4 section's `**Owning spec:**` line and above its defect table, insert (matching the WS3 section's status-line style immediately above it in the same document):

```markdown
> **Status 2026-07-11:** LANDED on `ws4-xinas-history-hardening`
> (`docs/plans/2026-07-11-ws4-xinas-history-hardening-plan.md`, T1–T11). All
> 9 live findings closed: GC concurrency (standalone entry points lock-gated,
> in-flight restore's source snapshot protected), ephemeral pre-change
> lifecycle (pending → terminal on every resolution path), real post-apply
> and post-restore validation, netplan reconverge flush parity with
> `net_controllers`, lock stale-recovery TOCTOU fix (flock held across the
> clear, EPERM ≠ stale), classifier/runner/engine fail-safe to
> `destroying_data`, store id allowlist + `.tmp-*` listing filter, mount-unit
> drift on checksum + enabled state, and `datetime.utcnow()` →
> `datetime.now(timezone.utc)` across all 6 sites. The snapshot-ID-collision
> finding from the original table was already fixed upstream before this
> plan started and was not re-done.
```

- [ ] **Step 3: Run the full gate**

Run: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`
Expected: all pass, zero `DeprecationWarning` lines.

Run: `/tmp/xinas-pytest-venv/bin/ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper`
Expected: `All checks passed!`

Run: `/tmp/xinas-pytest-venv/bin/ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper`
Expected: `All checks passed!` (or list of already-formatted files).

Run: `/tmp/xinas-pytest-venv/bin/pyright xinas_history/classifier.py xinas_history/runner.py xinas_history/engine.py xinas_history/store.py xinas_history/lock.py xinas_history/drift.py xinas_history/models.py xinas_history/collector.py xinas_history/__main__.py xinas_menu/screens/config_history.py`
Expected: `0 errors, 0 warnings, 0 informations` (the full set of files touched across Tasks 1-10; narrower than CI's whole-directory run per this task's scope, matching the given decomposition's "pyright on touched files").

Run: `npx --yes markdownlint-cli2 'docs/**/*.md'`
Expected: `Summary: 0 error(s)` (covers this plan file and the remediation-plan edit).

`ansible-lint collection/roles/`: **skipped** — no file under `collection/roles/` is touched by any task in this plan (the `xinas_history` Ansible role's task/template files are untouched; only the Python package it deploys changed).

Run: `gitleaks detect --source . --config .gitleaks.toml --log-opts "origin/main..HEAD"`
Expected: `no leaks found` (verified this exact command against the tree before starting; it scanned `1 commits` at that point — it will scan the 11 new commits from this plan plus the pre-existing WS4 spec commit once all tasks land).

- [ ] **Step 4: Commit**

```bash
git add docs/plans/2026-07-07-codebase-review-remediation-plan.md
git commit -m "$(cat <<'EOF'
docs(plans): WS4 landed — tick WS4.1-WS4.4, add status line

All 9 live xinas_history hardening findings closed on
ws4-xinas-history-hardening (T1-T11): GC concurrency, ephemeral retention,
real post-apply/post-restore validation, netplan flush parity, lock TOCTOU,
mount-unit drift, classifier fail-safe, store id/tmp-dir integrity, and
datetime.utcnow() deprecation. WS4.4 (spec/CLI reconciliation) was already
satisfied by commit 3b90da2 before this plan started.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Spec coverage

Every normative "MUST"/binding rule in `docs/config-history/specs.md` and `docs/config-history/requirements.md` that this plan's findings touch, mapped to a task:

| Spec clause | Requirement | Task |
|---|---|---|
| specs.md §1, "Snapshot ID and Store-Path Safety" | id allowlist `^[A-Za-z0-9._-]+$`, reject `..`/absolute | Task 2 |
| specs.md §1, "Snapshot ID and Store-Path Safety" | `list_snapshots` skips `.tmp-*` staging dirs | Task 3 |
| specs.md §1, field constraints | `timestamp` tz-aware, serialized with `Z` suffix | Task 4 |
| specs.md §1, "Snapshot Status Lifecycle" | ephemeral starts `pending`, moves to terminal on resolution | Task 6 |
| specs.md §4.7, "Unknown-Operation Fail-Safe" | unrecognized operation → `destroying_data`, every fallback site | Task 1 |
| specs.md §6.4/§6.5, stale lock recovery | flock held across the clear; EPERM ≠ stale | Task 9 |
| specs.md §7.1-§7.3, retention/ephemeral reclaim | ephemeral reclaimed via lifecycle, not fixed count | Task 6 |
| specs.md §7.4, GC concurrency | no lock-free deletion; in-flight restore's source protected | Task 5 |
| specs.md §9.4, mount-unit drift decision | checksum + enabled state, not just active/sub | Task 10 |
| specs.md §13.1, post-apply validation contract | validator receives expected post-change state | Task 7 |
| specs.md §13.2, post-restore validation contract | real check, not an always-True stub | Task 7 |
| requirements.md §18.2, GC purge rules | never lock-free; never deletes in-flight restore's source | Task 5 |
| requirements.md §20, concurrency and locking | locks survive restarts, never silently discarded | Task 9 (recovery correctness) |

**Gaps identified and how they were handled, not silently dropped:**
- The snapshot-ID-collision item from the *original remediation-plan table* (not a live `specs.md`/`requirements.md` MUST — that document already reflects the fix) is explicitly out of scope per the brief; confirmed still fixed (`tests/test_snapshot_id_unique.py` passes) and not re-touched except for its Task 4 mock lockstep.
- specs.md §11.10 and the CLI/retention doc-reconciliation this table's WS4.4 line originally called for is **already done** (commit `3b90da2`) — ticked in Task 11 with no code task, reasoned explicitly there rather than silently omitted.
- The TUI `_run_gc` fix (Task 5, Step 6) has no independent automated test — Textual screen methods in this codebase need the full `App`/`textual` harness, a pre-existing 9-file local-environment gap (project memory), covered by CI's `textual` install. It mirrors the CLI fix's exact `GlobalConfigLock` pattern, which the CLI-level test does exercise. This is the one deliberate coverage gap in the plan; flagged here rather than glossed over.

### Placeholder scan

Searched this document for "TBD", "TODO", "add appropriate error handling", "similar to Task N" (without inlined code), and any step that describes a change without showing it. None found — every code-changing step shows the exact current text and its exact replacement; every test-writing step shows the complete test file or complete function being added.

### Naming / type consistency

- `SnapshotStatus` values used consistently as the enum's `.value` string form (`"pending"`, `"applied"`, `"rolled_back"`, `"failed"`) across Task 6's `runner.py` changes and Task 6/existing `gc.py` — matches `models.py`'s `SnapshotStatus` enum exactly; `PARTIAL` remains unused, as it is today (not introduced or referenced by any task).
- `GlobalConfigLock`'s public surface (`acquire(operation, source, ...)`, `release()`, `get_lock_info()`, `get_journal()`, `check_stale_lock()`, `recover_stale_lock()`) is used identically by Task 5 (CLI/TUI standalone entry points) and Task 9 (the class's own internals) — no new methods invented, no signature drift.
- `RetentionPolicy(max_snapshots=..., max_age_days=...)` and `GarbageCollector.run(current_effective_id=..., in_progress_ids=...)` keyword names are used identically across Task 5's `engine.py`/`runner.py`/`__main__.py`/`config_history.py` changes and Task 5/6's test files — matches `gc.py`'s existing dataclass/method exactly, no renaming.
- `Manifest.checksums`/`.status`/`.type` field names used consistently as plain dict-backed attributes (never re-typed) across Tasks 5-7 and 9-10's test fixtures, matching `models.py`.
- The one new cross-file parameter, `gc_protect_ids` (Task 5, `engine.create_snapshot`), and the one new cross-file parameter, `expected_state` (Task 7, `execute`/`execute_ansible`), are each introduced once and threaded through their one call site with the identical name at every hop — no aliasing.

### Deviations from the given decomposition (stated with reason)

1. **T8 folded into T11** (this plan's Task 11), not given its own task: WS4.4's spec/CLI reconciliation was already fully landed by commit `3b90da2` before this plan's Task 1 started. A standalone task for it would be an empty diff; folding its single checkbox-tick into the bookkeeping task avoids that.
2. **Task 1 fixes a third site beyond the two the remediation-plan table names** (`classifier.py:150-151`, `runner.py:169`): while reading `engine.py`'s `create_snapshot`, the identical `except ValueError: rollback_class = RollbackClass.NON_DISRUPTIVE.value` fallback was found at lines 117-123, directly reachable via `python3 -m xinas_history snapshot create --operation <anything>` (a free-form argparse string). specs.md §4.7 explicitly generalizes to "any caller-side fallback... including but not limited to" the two named sites, so it is in scope and was fixed rather than left as a known-identical gap.
3. **Test-file boundary for Task 7's post-restore-validation test**: placed in the existing `tests/test_execute_restore_snapshot.py` (extending it, reusing its `_build()` fixture) rather than the new `tests/test_post_apply_validation.py`, since it directly extends `execute_restore_snapshot`'s existing behavioral suite; `test_post_apply_validation.py` stays focused on `PostApplyValidator` + the `execute()`-threads-the-parameter proof.
4. **`test_pre_change_ephemeral_marked_applied_after_successful_apply` (Task 6) is not independently RED**, and the task's own docstring says so: old code's hardcoded `status=applied` default coincidentally already produces the value this test asserts on the plain-success path. It is kept as an end-to-end contract confirmation; Task 6's two genuinely RED tests are `test_ephemeral_snapshot_created_pending` and `test_pre_change_ephemeral_marked_failed_when_rollback_also_fails`, both independently verified by direct reproduction.
