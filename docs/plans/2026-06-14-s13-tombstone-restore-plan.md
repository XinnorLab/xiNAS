# S13 — Tombstone absent-file restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A targeted `config.rollback` restores the ABSENCE of a managed file — deleting files that exist now but were absent at snapshot time — and, under `adopt`, deletes the corresponding removed-domain desired rows, so drift goes fully clean.

**Architecture:** Tombstones come from an explicit `Manifest.absent_files` recorded at snapshot creation (THE HINGE — never inferred from a missing checksum key at read). The Python runner computes a `delete_set` alongside the S11 `write_set`, deletes + reconverges the union, and recreates deletes on rollback from the pre-change ephemeral. `absent_files` projects Python→TS onto the observed `ConfigSnapshot`; the TS adopt provider relaxes its per-domain gate to delete the **primary kind only** (`Share`/`NetworkInterface`) when the backing logical file is absent. Implements ADR-0017 / `docs/control-path/s13-tombstone-restore-spec.md`.

**Tech Stack:** Python config-history (`xinas_history/`, pytest, ruff, pyright), TypeScript control-path (`xiNAS-MCP/`, vitest, biome), OpenAPI (`api-v1.yaml`, spectral).

---

## Conventions (read before starting)

- **TDD:** failing test first → red → minimal impl → green → commit.
- **Python:** venv `/tmp/xinas-pytest-venv`. Tests: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`. Lint: `/tmp/xinas-pytest-venv/bin/ruff check xinas_menu xinas_history`; `… ruff format --check …`; pyright: `/tmp/xinas-pytest-venv/bin/pyright --pythonpath /tmp/xinas-pytest-venv/bin/python xinas_menu xinas_history`.
- **TS** (from `xiNAS-MCP/`): `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:contracts`. ESM `.js` import suffixes; exactOptionalPropertyTypes (conditional spreads, never explicit `undefined`).
- **Commits:** per task; end the message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage explicit paths, never `git add -A`.
- **Requires-Rebuild:** none expected — `xinas_history` runs from the repo checkout (refreshed by the update flow's `git pull`), matching S9–S12 config-history changes. Confirm before T9; do NOT add the trailer for code-only changes.
- **The hinge:** tombstones derive ONLY from `Manifest.absent_files` (explicit, creation-time). Never infer absence from a missing checksum key. Pre-S13 snapshots have no `absent_files` → no tombstones → exact S11 behavior.

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `docs/control-path/api-v1.yaml` | `ConfigSnapshot.absent_files` | T0 |
| `xinas_history/collector.py` | `ConfigCollector.collect_absent_system_files()` | T1 |
| `xinas_history/models.py` | `Manifest.absent_files` field + to_dict/from_dict | T2 |
| `xinas_history/engine.py` | `create_snapshot` records `absent_files` | T2 |
| `xinas_history/runner.py` | `delete_set`, `_delete_system_file`, reconverge union, restorable guard (T3); rollback union (T4) | T3, T4 |
| `xinas_history/__main__.py` | `snapshot list` json: widen `restorable` (absent_files counts) | T5 |
| `xiNAS-MCP/src/agent/task/xinas-history-bridge.ts` | project `absent_files` + widened `restorable` | T5 |
| `xiNAS-MCP/src/api/plan/providers/config-rollback.ts` | `adoptOverlay` tombstone deletes (primary-kind only) | T6 |
| `xinas_menu/screens/snapshot_detail.py` | show `absent_files` (read-only) | T8 |
| `tests/test_*` , `xiNAS-MCP/src/__tests__/*` | unit + e2e | each |
| `docs/control-path/hardware-smoke-runbook.md` | §5g | T9 |

---

### Task 0: Contracts (api-v1 + commit docs)

**Files:** Modify `docs/control-path/api-v1.yaml`.

- [ ] **Step 1:** In the `ConfigSnapshot` schema (search `adoptable` — S12 added it there), add:

```yaml
absent_files:
  type: array
  items: { type: string }
  description: >-
    Managed logical files (CHECKSUM_TARGETS names) absent at snapshot capture
    (S13 tombstone set). Empty/omitted for pre-S13 snapshots. ADR-0017.
```

- [ ] **Step 2:** Validate. From repo root: `npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml` → expect `0 errors` (pre-existing warnings OK). Also `npx --yes markdownlint-cli2 'docs/control-path/adr/0017-tombstone-absent-file-restore.md' 'docs/control-path/s13-tombstone-restore-spec.md' 'docs/plans/2026-06-14-s13-tombstone-restore-plan.md'` → 0 errors.

- [ ] **Step 3:** Commit api-v1 + the three S13 design docs (NOT `docs/.DS_Store`):

```bash
git add docs/control-path/api-v1.yaml docs/control-path/adr/0017-tombstone-absent-file-restore.md docs/control-path/s13-tombstone-restore-spec.md docs/plans/2026-06-14-s13-tombstone-restore-plan.md
git commit -m "$(cat <<'EOF'
docs(control-path): S13 T0 — ADR-0017 + spec + plan + api-v1 (ConfigSnapshot.absent_files)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Collector — `collect_absent_system_files`

**Files:** Modify `xinas_history/collector.py`; Test `tests/test_collect_absent_system_files.py` (new).

`SYSTEM_FILE_PATHS` (= `CHECKSUM_TARGETS`) is the managed set: `{etc_exports:/etc/exports, nfs_conf, idmapd_conf, netplan, nfsd_conf, nfs_kernel_server_defaults, lockd_conf, nfs_common_defaults}`. `collect_system_files()` already walks them and skips unreadable ones — the absent set is its complement.

- [ ] **Step 1: failing test.**

```python
# tests/test_collect_absent_system_files.py
from pathlib import Path
from xinas_history.collector import ConfigCollector, SYSTEM_FILE_PATHS

def test_collect_absent_system_files(tmp_path, monkeypatch):
    # Point two managed names at present files, leave the rest absent.
    present = {"etc_exports": tmp_path / "exports", "netplan": tmp_path / "99.yaml"}
    present["etc_exports"].write_text("X")
    present["netplan"].write_text("Y")
    paths = {name: str(present.get(name, tmp_path / f"missing-{name}")) for name in SYSTEM_FILE_PATHS}
    monkeypatch.setattr("xinas_history.collector.SYSTEM_FILE_PATHS", paths)

    absent = ConfigCollector().collect_absent_system_files()
    assert "etc_exports" not in absent and "netplan" not in absent
    assert "nfs_conf" in absent and "idmapd_conf" in absent
    assert set(absent).issubset(set(SYSTEM_FILE_PATHS))
```
(Adapt the `ConfigCollector()` construction + monkeypatch target to the real module — read `collector.py` for the constructor and whether `SYSTEM_FILE_PATHS` is module-level.)

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_collect_absent_system_files.py -q` → FAIL (no method).

- [ ] **Step 3: implement** in `collector.py`:

```python
def collect_absent_system_files(self) -> list[str]:
    """S13 (ADR-0017): the managed logical names ABSENT now — the complement of
    collect_system_files over SYSTEM_FILE_PATHS. Recorded at snapshot creation
    as the explicit tombstone set; never inferred from missing checksums later."""
    return [name for name, path in SYSTEM_FILE_PATHS.items() if not Path(path).exists()]
```
(Match the existing file-read idiom; if `collect_system_files` uses `read_bytes()`/OSError, mirror that detection rather than `exists()` if there's a reason — but `exists()` is the clean signal here.)

- [ ] **Step 4: green** + `ruff check`/`ruff format --check`/`pyright` on `xinas_history`.

- [ ] **Step 5: commit** (`feat(history): S13 T1 — collect_absent_system_files (ADR-0017)`).

---

### Task 2: Manifest field + create_snapshot wiring

**Files:** Modify `xinas_history/models.py` (Manifest); `xinas_history/engine.py` (create_snapshot); Test `tests/test_absent_files_manifest.py` (new).

`Manifest` (models.py:159) has `files_changed: list[str] = field(default_factory=list)` (line 186), persisted in `to_dict` (line 218-219, only when non-empty) and read in `from_dict` (line 261). Mirror it for `absent_files`. `engine.create_snapshot` (engine.py:132-169) collects `system_files` (133), builds the Manifest (`files_changed=files_changed` at 159), `write_snapshot(..., system_files=...)` (163-169).

- [ ] **Step 1: failing test.**

```python
# tests/test_absent_files_manifest.py
from xinas_history.models import Manifest

def test_absent_files_roundtrip():
    m = Manifest(id="s1", timestamp="t", user="root", source="api", absent_files=["etc_exports"])
    d = m.to_dict()
    assert d["absent_files"] == ["etc_exports"]
    assert Manifest.from_dict(d).absent_files == ["etc_exports"]

def test_absent_files_omitted_when_empty():
    assert "absent_files" not in Manifest(id="s1", timestamp="t", user="root", source="api").to_dict()
    assert Manifest.from_dict({"id": "s1", "timestamp": "t"}).absent_files == []
```

- [ ] **Step 2: red** → FAIL (no field / TypeError).

- [ ] **Step 3: implement.**
  - models.py Manifest: add `absent_files: list[str] = field(default_factory=list)` (next to `files_changed`); in `to_dict` add `if self.absent_files: result["absent_files"] = list(self.absent_files)`; in `from_dict` add `absent_files=list(data.get("absent_files", []))`.
  - engine.py `create_snapshot`: near the `system_files = self._config_collector.collect_system_files()` line add `absent_files = self._config_collector.collect_absent_system_files()`, and pass `absent_files=absent_files` to the `Manifest(...)` constructor.

- [ ] **Step 4: green** (`pytest tests/test_absent_files_manifest.py -q`) + an integration assert: a `create_snapshot` taken with a managed file absent has `manifest.absent_files` containing its name (mirror an existing engine create test; if engine tests stub the collector, stub `collect_absent_system_files` too). Run `ruff`/`pyright`.

- [ ] **Step 5: commit** (`feat(history): S13 T2 — Manifest.absent_files recorded at create (ADR-0017)`).

---

### Task 3: Runner — delete_set + restorable guard

**Files:** Modify `xinas_history/runner.py` (`execute_restore_snapshot`, add `_delete_system_file`); Test `tests/test_execute_restore_snapshot.py` (extend).

In `execute_restore_snapshot` (runner.py): `captured = list_system_files`; `if not captured → no_restorable_payload`; `restore_set = [n for n in captured if current_checksums.get(n) != target_checksums.get(n)]`; `if not restore_set → success no-op`; then lock → pre-change ephemeral → write restore_set → `_reconverge(restore_set)` → validate → rollback. `_collect_current_checksums().to_dict()` gives current presence (truthy = present). `target.absent_files` is the explicit tombstone set (T2).

- [ ] **Step 1: failing test** (extend the existing `_build` harness in `tests/test_execute_restore_snapshot.py` — read it; it seeds `target_system`, `target_checksums`, a fake `_collect_current_checksums`, and records reconverge `commands`). Add a `target_absent` arg to `_build` that sets `manifest.absent_files`.

```python
def test_restore_deletes_absent_target_file(tmp_path):
    runner, store, target_id, live_dir, commands = _build(
        tmp_path,
        target_system={},                 # nothing captured
        target_checksums={},              # etc_exports absent at target
        target_absent=["etc_exports"],    # explicit tombstone
        current_checksums={"etc_exports": "sha256:LIVE"},  # present now
    )
    (live_dir / "exports").write_bytes(b"LIVE")
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.success is True
    assert not (live_dir / "exports").exists()        # deleted
    assert ["exportfs", "-ra"] in commands            # reconverged

def test_restore_restorable_on_absent_files_only(tmp_path):
    # no system payload but a tombstone → restorable (not no_restorable_payload)
    runner, store, target_id, live_dir, commands = _build(
        tmp_path, target_system={}, target_checksums={},
        target_absent=["etc_exports"], current_checksums={"etc_exports": "sha256:LIVE"},
    )
    (live_dir / "exports").write_bytes(b"LIVE")
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.error != "no_restorable_payload"

def test_restore_absent_and_already_absent_is_noop(tmp_path):
    runner, store, target_id, live_dir, commands = _build(
        tmp_path, target_system={}, target_checksums={},
        target_absent=["etc_exports"], current_checksums={},  # also absent now
    )
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.success is True and "noop" in "".join(result.steps)
```

- [ ] **Step 2: red** → FAIL (file not deleted / no_restorable_payload).

- [ ] **Step 3: implement** in `runner.py`:
  - Add `_delete_system_file`:
    ```python
    def _delete_system_file(self, name: str) -> None:
        path = self._system_file_paths.get(name)
        if path is None:
            return
        Path(path).unlink(missing_ok=True)
    ```
  - In `execute_restore_snapshot`:
    - widen the guard: `if not captured and not (target.absent_files or []): result.error = "no_restorable_payload"; return result`.
    - after `restore_set = [...]`, add:
      ```python
      delete_set = [n for n in (target.absent_files or []) if current_checksums.get(n)]
      change_set = restore_set + delete_set
      if not change_set:
          result.success = True
          result.output = "already at target; no changes"
          result.steps.append("noop_already_current")
          return result
      ```
    - after writing the restore_set files, delete: `for name in delete_set: self._delete_system_file(name)`; `result.steps.append("files_deleted")` (only if delete_set).
    - reconverge over the union: `ok = await self._reconverge(change_set)`.
    - the rollback call becomes `await self._restore_rollback(pre.id, change_set)` (T4 widens the helper; passing the union here is forward-compatible — a delete name's bytes come from the ephemeral).

- [ ] **Step 4: green** (`pytest tests/test_execute_restore_snapshot.py -q`, all incl. the S11 tests) + `ruff`/`pyright`.

- [ ] **Step 5: commit** (`feat(history): S13 T3 — restore delete_set for tombstoned files (ADR-0017)`).

---

### Task 4: Runner — rollback recreates deletes

**Files:** Modify `xinas_history/runner.py` (`_restore_rollback`); Test `tests/test_execute_restore_snapshot.py` (extend).

`_restore_rollback(pre_change_id, restore_set)` writes the pre-change ephemeral's bytes back for each name + reconverges. Since the pre-change ephemeral captured every live file BEFORE the delete, a deleted file's bytes are recoverable; passing the union (T3) means `read_system_file(pre, name)` returns the deleted file's bytes → `_write_system_file` recreates it.

- [ ] **Step 1: failing test.**

```python
def test_rollback_recreates_deleted_file(tmp_path):
    runner, store, target_id, live_dir, commands = _build(
        tmp_path, target_system={}, target_checksums={},
        target_absent=["etc_exports"], current_checksums={"etc_exports": "sha256:LIVE"},
    )
    (live_dir / "exports").write_bytes(b"LIVE-BYTES")  # pre-change ephemeral captures this
    async def _fail(): return False
    runner._validate_restore = _fail  # type: ignore[attr-defined]
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.success is False and result.rollback_performed is True
    assert (live_dir / "exports").read_bytes() == b"LIVE-BYTES"   # recreated
```
(Confirm the `_build` harness wires the pre-change ephemeral to capture `live_dir` — mirror the existing `test_restore_validation_fail_does_file_level_rollback`, which already asserts `EPHEMERAL-LIVE` bytes; reuse its ephemeral seam.)

- [ ] **Step 2: red** → FAIL (file stays deleted).

- [ ] **Step 3: implement.** `_restore_rollback` already loops `for name in restore_set: content = read_system_file(pre, name); if content is not None: _write_system_file(name, content)`. T3 now passes the union as `restore_set`, so a deleted name's pre-change bytes are written back — **likely already correct**. If the existing loop only handled writes and a deleted-then-recreated path needs the file path to exist, confirm `_write_system_file` creates it (it does — `Path(path).write_bytes`). Add nothing if green; if the rollback signature/param name needs widening for clarity rename to `change_set`. Reconverge over the union.

- [ ] **Step 4: green** + `ruff`/`pyright`.

- [ ] **Step 5: commit** (`feat(history): S13 T4 — file-level rollback recreates tombstoned deletes (ADR-0017)`).

---

### Task 5: CLI `restorable` widen + bridge projection

**Files:** Modify `xinas_history/__main__.py` (`_cmd_snapshot_list`); `xiNAS-MCP/src/agent/task/xinas-history-bridge.ts` (`projectSnapshot` + types); Test: extend a bridge projection test + a CLI test.

`_cmd_snapshot_list` json path: `entry = m.to_dict(); entry["restorable"] = bool(list_system_files(m.id))`. `m.to_dict()` already carries `absent_files` (T2). Two changes: widen `restorable`; the bridge carries `absent_files`.

- [ ] **Step 1 (CLI, py): failing test** — a snapshot with no system payload but `absent_files` lists `restorable: true` in `snapshot list --format json`. (Mirror the existing list-json test; if none, drive `_cmd_snapshot_list` with a captured stdout.) Implement:
  ```python
  entry["restorable"] = bool(engine._store.list_system_files(m.id)) or bool(m.absent_files)
  ```
  (`absent_files` itself rides via `m.to_dict()` — no extra line needed for it in list.)

- [ ] **Step 2 (bridge, TS): failing test** — in the bridge projection test, a manifest with `absent_files` projects it onto the `ConfigSnapshot` status, and `restorable` reflects the widened value. Read `xinas-history-bridge.ts`: `ProjectedSnapshot`/`HistoryManifest` types + `projectSnapshot`. Add `absent_files?: string[]` to the manifest/projection types and carry it through (mirror how `files_changed`/`restorable` flow). The widened `restorable` comes from the CLI `list` value — the bridge passes it through, so no recompute needed bridge-side; just ensure `absent_files` is mapped onto the projected `ConfigSnapshot` `status`.

- [ ] **Step 3: implement** both; ensure `.js` import suffixes + exactOptionalPropertyTypes conditional spread for `absent_files`.

- [ ] **Step 4: green** — `pytest` (CLI test); `cd xiNAS-MCP && npm test -- xinas-history-bridge` (or the projection test name) + `npm run typecheck`; `ruff`/`pyright` for python.

- [ ] **Step 5: commit** (`feat(history): S13 T5 — project absent_files + widen restorable (ADR-0017)`).

---

### Task 6: Provider — adopt tombstone deletes (primary-kind only)

**Files:** Modify `xiNAS-MCP/src/api/plan/providers/config-rollback.ts` (`adoptOverlay` + the observed-row type); Test `xiNAS-MCP/src/__tests__/api/config-rollback-adopt.test.ts` (extend).

`adoptOverlay` (config-rollback.ts) iterates `ADOPT_DOMAINS = [{primary:'Share', kinds:[...]}, {primary:'NetworkInterface', kinds:[...]}]`; today it `continue`s when `captured[primary]` is empty. The provider reads the observed `ConfigSnapshot` row (which now carries `absent_files` from T5). Add `DOMAIN_FILE = { Share: 'etc_exports', NetworkInterface: 'netplan' }`.

- [ ] **Step 1: failing test** (extend the adopt test; `adoptableCtx()` seeds the observed ConfigSnapshot row — add `status.absent_files` to it, and a current desired `Share` + `NetworkInterface` row).

```typescript
it('tombstone: primary empty + etc_exports absent → deletes current Share ONLY', async () => {
  // payload has NO Share rows; observed ConfigSnapshot status.absent_files = ['etc_exports'];
  // current desired has Share/expA (rev 3), ExportGroup/default (rev 1), NetworkInterface/eth0 (rev 9)
  const plan = await configRollbackProvider.preflight(tombstoneCtx(), { to: SNAP, reason: 'r', adopt: true });
  const m = plan.desired_mutations ?? [];
  expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expA', delete: true });
  expect(m).not.toContainEqual(expect.objectContaining({ key: '/xinas/v1/desired/ExportGroup/default' })); // singleton kept
  expect(m.some(x => x.key.includes('/NetworkInterface/'))).toBe(false); // netplan NOT absent → untouched
  expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expA', revision: 3 });
});

it('tombstone: primary empty but file NOT in absent_files → skips (no deletes)', async () => {
  // same but status.absent_files = [] → S12 behavior (skip)
  const plan = await configRollbackProvider.preflight(noTombstoneCtx(), { to: SNAP, reason: 'r', adopt: true });
  expect((plan.desired_mutations ?? []).some(x => x.key.includes('/Share/'))).toBe(false);
});
```

- [ ] **Step 2: red** → FAIL.

- [ ] **Step 3: implement.** Add the observed-row type field (`status.absent_files?: string[]`), read `absentFiles = row.value.status?.absent_files ?? []`. In `adoptOverlay`, replace the empty-primary `continue` with:

```typescript
const DOMAIN_FILE: Record<string, string> = { Share: 'etc_exports', NetworkInterface: 'netplan' };
// ...inside the domain loop, when captured[primary] is empty:
const backing = DOMAIN_FILE[primary];
if (backing && absentFiles.includes(backing)) {
  // tombstone: delete current desired rows of the PRIMARY kind only (not the
  // ExportGroup/NfsProfile singletons — they don't render export entries and
  // there's always a default).
  const current = ctx.kv.list<{ id?: string }>({ prefix: `/xinas/v1/desired/${primary}/` });
  for (const r of current) {
    const id = r.value.id ?? '';
    mutations.push({ key: `/xinas/v1/desired/${primary}/${id}`, delete: true });
    pinned.push({ kind: primary, id, revision: r.revision });
  }
}
// else: continue (skip — S12 behavior)
```
Thread `absentFiles` into `adoptOverlay` (pass the observed row or the array). Keep revision pins, the `dangerous` gate, and `not_adoptable` (payload-absent) exactly as S12.

- [ ] **Step 4: green** (`npm test -- config-rollback-adopt` + `npm test -- config-rollback` for the S12 regressions) + `npm run typecheck` + `npm run test:contracts`.

- [ ] **Step 5: commit** (`feat(api): S13 T6 — adopt tombstone deletes (primary-kind only) (ADR-0017)`).

---

### Task 7: Apply wiring check (TS test-only)

**Files:** Test `xiNAS-MCP/src/__tests__/api/` (extend the S12 `adopt-apply.test.ts`).

No production code — prove the tombstone desired-deletes flow through the apply txn (delete lands in KV, reverts on failure), mirroring S12 T5.

- [ ] **Step 1:** add a test driving an adopt plan whose `desired_mutations` is a tombstone delete (`{key:'/xinas/v1/desired/Share/expA', delete:true}`) with a revision-pinned `affected_resources`, through `apply` → KV no longer has `expA`; a terminal-failed task reverts it (re-creates `expA` from `desired_rollback`).
- [ ] **Step 2: red/green** (likely green-confirm — the engine path is generic). If a gap surfaces, STOP and report (don't paper over).
- [ ] **Step 3: commit** (`test(api): S13 T7 — tombstone desired-delete apply + revert`).

---

### Task 8: TUI surfaces absent_files (light)

**Files:** Modify `xinas_menu/screens/snapshot_detail.py`; Test `tests/test_config_history_restore.py` or `tests/test_snapshot_adopt.py` (extend).

- [ ] **Step 1:** the snapshot-detail read shows `absent_files` (from the API `ConfigSnapshot` row) when non-empty — a read-only line in the detail view (no new action; restore/adopt already wired in S11/S12). Add a tiny helper/assertion that the detail rendering includes the absent_files when present.
- [ ] **Step 2: red/green** — `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_snapshot_adopt.py -q`; `ruff`/`pyright xinas_menu`.
- [ ] **Step 3: commit** (`feat(tui): S13 T8 — show snapshot absent_files (ADR-0017)`).

---

### Task 9: e2e + runbook §5g + full gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/tombstone-restore.test.ts`; Modify `docs/control-path/hardware-smoke-runbook.md`.

- [ ] **Step 1: e2e.** Mirror `xiNAS-MCP/src/__tests__/e2e/durable-adoption.test.ts` (real api+agent, fixture probe, python3 shim, `openStateStore` seeding). Seed: an observed `ConfigSnapshot snap-tomb` (via `config-snapshots.json` fixture so the collector re-emit keeps it) whose `absent_files=['etc_exports']`; a snapshot-desired payload (S12) with NO Share rows; current desired `Share/expA`. Scenarios: (1) adopt `{to:'snap-tomb', adopt:true, dangerous}` → success; assert desired `Share/expA` deleted; (2) a snapshot WITHOUT `absent_files` (pre-S13) + empty payload → adopt skips Share (no delete). Note the file-level delete itself is runner-side and covered by the python unit tests (the e2e fixture python3 shim returns success for `snapshot restore`), so the e2e asserts the DESIRED-row tombstone path; document that. Build dist first: `npm run build`. Run: `npx vitest run --config vitest.e2e.config.ts tombstone-restore`.

- [ ] **Step 2: runbook §5g.** Add an on-node smoke (after §5f): snapshot with NFS off (so `absent_files` includes `etc_exports`) → create a share → restore that snapshot with `adopt` → confirm `/etc/exports` removed AND `drift.nfs-exports` clean (vs S11 which would leave the file).

- [ ] **Step 3: FULL GATE.** From `xiNAS-MCP/`: `npm run typecheck`, `npm run lint 2>&1 | tail -3`, `npm run format:check 2>&1 | tail -3`, `npm test`, `npm run test:contracts`. From repo root: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`, `ruff check xinas_menu xinas_history`, `ruff format --check xinas_menu xinas_history`, `pyright xinas_menu xinas_history`, `npx --yes markdownlint-cli2 'docs/**/*.md'`, spectral on api-v1.yaml, `gitleaks git --config .gitleaks.toml --log-opts="main..HEAD" .`. All green (pre-existing biome WARNINGS ok; ERRORS/test-failures not).

- [ ] **Step 4: commit** (`test(e2e): S13 T9 — tombstone/adopt end-to-end + runbook §5g`).

---

## Self-Review

- **Spec coverage:** T0 contracts (§8); T1 collector (§3.1); T2 manifest+create (§3.2–3.3); T3 delete_set + restorable guard (§4); T4 rollback union (§5); T5 projection + restorable widen (§6, with the precise `list`-only restorable per the review); T6 provider primary-kind-only tombstone deletes (§7); T7 apply wiring; T8 TUI; T9 e2e+runbook+gate (§9). All §-sections mapped.
- **The hinge** is enforced: tombstones come only from `Manifest.absent_files` (T2, set at create), never inferred — T3 reads `target.absent_files`, never a missing checksum key. Pre-S13 → empty `absent_files` → no deletes (tested in T9 scenario 2 + T6 skip test).
- **Primary-kind-only:** T6 deletes only the `primary` kind; `ExportGroup`/`NfsProfile` excluded (asserted). Consistent with ADR §5 / spec §7.
- **delete_set is execute-time:** T6/T9 assert the DESIRED-row deletes (plan-time); the file delete_set is asserted in the runner python tests (T3) — no test claims the plan lists the realized file delete_set.
- **Type consistency:** `absent_files` (list[str]) is the name across collector→manifest→CLI→bridge→observed row→provider; `DOMAIN_FILE` maps `Share→etc_exports`, `NetworkInterface→netplan`; `_delete_system_file` mirrors `_write_system_file`.
- **Open exec note:** T4 may be a green-confirm (the existing rollback loop likely already recreates from the union T3 passes) — if so, keep the test as the regression guard, no impl change.
