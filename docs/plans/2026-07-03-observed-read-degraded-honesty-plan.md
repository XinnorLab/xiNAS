# Observed-read degraded honesty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the observed-read list routes (`GET /api/v1/arrays|disks|filesystems`) and the RAID/Filesystem TUI screens distinguish "backend unavailable" from "genuinely none" by surfacing a `DEGRADED_BACKEND_UNAVAILABLE` warning when the backing collector is errored.

**Architecture:** A pure API helper reads the already-tracked per-collector health map (`HeartbeatTracker.currentSnapshot().collectors[kind]`); the three storage list routes attach the warning via `sendOk`'s existing `warnings` arg. A pure Python helper extracts the warning from the envelope; the RAID and Filesystem screens fetch the full envelope (`control.get`, not `control.result`) and render a banner that replaces the misleading empty-state.

**Tech Stack:** TypeScript (Express API, vitest, biome) in `xiNAS-MCP/`; Python (Textual TUI, pytest) in `xinas_menu/`.

**Spec:** [docs/plans/2026-07-03-observed-read-degraded-honesty-design.md](2026-07-03-observed-read-degraded-honesty-design.md); contracts in [s8-clients-spec §5.1](../control-path/s8-clients-spec.md), [raid-management-spec §3.1](../Storage/raid-management-spec.md), [fs-shares-management-spec §3.2](../Storage/fs-shares-management-spec.md).

**Delivery note:** every commit that touches `xiNAS-MCP/src` (Tasks 1–2) must carry the trailer `Requires-Rebuild: xinas_node_build, xinas_api` (the API is served from compiled `dist/`; the default update neither rebuilds nor restarts it). The Python commits (Tasks 3–5) need no trailer.

**Working dir:** all commands run from the worktree root `/Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/happy-knuth-84c624`. API commands are prefixed `cd xiNAS-MCP && …`.

---

## File Structure

| File | Responsibility |
|---|---|
| `xiNAS-MCP/src/api/handlers/collector-health.ts` | **Create.** Pure helper `degradedCollectorWarnings(ctx, kind)`. |
| `xiNAS-MCP/src/__tests__/api/collector-health.test.ts` | **Create.** Unit tests for the helper. |
| `xiNAS-MCP/src/api/routes/storage.ts` | **Modify.** Wire the helper into `GET /arrays`, `/disks`, `/filesystems`. |
| `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts` | **Modify.** Route tests for the degraded warning. |
| `xinas_menu/api/degraded.py` | **Create.** Pure helper `degraded_banner(envelope)`. |
| `tests/test_degraded.py` | **Create.** Unit tests for the helper. |
| `xinas_menu/screens/raid.py` | **Modify.** `_format_raid_overview(..., banner=None)` + `_show_quick`/`_show_extended` wiring. |
| `tests/test_raid_overview.py` | **Create.** Formatter tests. |
| `xinas_menu/screens/filesystem.py` | **Modify.** Extract `_format_filesystems(rows, banner)`; add `_list_filesystems_with_status`; rewire `_show_filesystems`. |
| `tests/test_fs_overview.py` | **Create.** Formatter tests. |

---

## Task 1: API helper `degradedCollectorWarnings`

**Files:**
- Create: `xiNAS-MCP/src/api/handlers/collector-health.ts`
- Test: `xiNAS-MCP/src/__tests__/api/collector-health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/collector-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { degradedCollectorWarnings } from '../../api/handlers/collector-health.js';
import type { ApiContext } from '../../api/context.js';

function ctxWith(collectors: Record<string, string> | undefined): ApiContext {
  const tracker =
    collectors === undefined
      ? undefined
      : ({ currentSnapshot: () => ({ collectors }) } as unknown as ApiContext['tracker']);
  return { tracker } as ApiContext;
}

describe('degradedCollectorWarnings', () => {
  it('warns when the collector is errored', () => {
    const w = degradedCollectorWarnings(
      ctxWith({ XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: boom' }),
      'XiraidArray',
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.code).toBe('DEGRADED_BACKEND_UNAVAILABLE');
    expect(w[0]?.message).toContain('XiraidArray');
  });

  it('is silent for running / stubbed / other-kind / no tracker', () => {
    expect(degradedCollectorWarnings(ctxWith({ XiraidArray: 'running' }), 'XiraidArray')).toEqual(
      [],
    );
    expect(degradedCollectorWarnings(ctxWith({ XiraidArray: 'stubbed' }), 'XiraidArray')).toEqual(
      [],
    );
    expect(degradedCollectorWarnings(ctxWith({ Disk: 'error: x' }), 'XiraidArray')).toEqual([]);
    expect(degradedCollectorWarnings(ctxWith(undefined), 'XiraidArray')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/collector-health.test.ts`
Expected: FAIL — cannot resolve `../../api/handlers/collector-health.js`.

- [ ] **Step 3: Write minimal implementation**

Create `xiNAS-MCP/src/api/handlers/collector-health.ts`:

```ts
/**
 * s8-clients-spec §5.1 — observed-read degraded honesty.
 *
 * An observed-read list route returns [] when its backing collector is
 * errored; silent, that is indistinguishable from "genuinely none". This
 * helper produces a DEGRADED_BACKEND_UNAVAILABLE warning off the captured
 * per-collector health map (the same map the node degrades on): an errored
 * collector serializes as `error: <reason>`; `running` / `stubbed` are
 * healthy. No tracker (read-only contexts) → no warning.
 */

import type { ApiContext } from '../context.js';
import type { Warning } from '../envelope.js';

export function degradedCollectorWarnings(ctx: ApiContext, kind: string): Warning[] {
  const health = ctx.tracker?.currentSnapshot().collectors[kind];
  if (typeof health === 'string' && health.startsWith('error')) {
    return [
      {
        code: 'DEGRADED_BACKEND_UNAVAILABLE',
        message: `${kind} observation is degraded (${health}); the list may be empty or stale.`,
      },
    ];
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/collector-health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/handlers/collector-health.ts xiNAS-MCP/src/__tests__/api/collector-health.test.ts
git commit -m "feat(api): degradedCollectorWarnings helper for observed reads

Requires-Rebuild: xinas_node_build, xinas_api
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire the three storage list routes

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/storage.ts`
- Test: `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts`, add inside `describe('storage routes', …)` (after the existing `GET /arrays returns the list` test):

```ts
it('GET /arrays warns when the XiraidArray collector is errored', async () => {
  setup.ctx.tracker!.recordHeartbeatSuccess(new Date(), {
    collectors: { XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: boom' },
  });
  const res = await request(setup.app).get('/api/v1/arrays').set('Authorization', ADMIN_TOKEN);
  expect(res.status).toBe(200);
  const codes = res.body.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain('DEGRADED_BACKEND_UNAVAILABLE');
});

it('GET /arrays has no degraded warning when the collector is healthy', async () => {
  setup.ctx.tracker!.recordHeartbeatSuccess(new Date(), { collectors: { XiraidArray: 'running' } });
  seedArray(setup.state, 'a1');
  const res = await request(setup.app).get('/api/v1/arrays').set('Authorization', ADMIN_TOKEN);
  const codes = res.body.warnings.map((w: { code: string }) => w.code);
  expect(codes).not.toContain('DEGRADED_BACKEND_UNAVAILABLE');
});

it('GET /disks warns when the Disk collector is errored', async () => {
  setup.ctx.tracker!.recordHeartbeatSuccess(new Date(), {
    collectors: { Disk: 'error: PROBE_UNAVAILABLE' },
  });
  const res = await request(setup.app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);
  const codes = res.body.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain('DEGRADED_BACKEND_UNAVAILABLE');
});

it('GET /filesystems warns when the Filesystem collector is errored', async () => {
  setup.ctx.tracker!.recordHeartbeatSuccess(new Date(), {
    collectors: { Filesystem: 'error: MOUNT_READ_FAILED' },
  });
  const res = await request(setup.app).get('/api/v1/filesystems').set('Authorization', ADMIN_TOKEN);
  const codes = res.body.warnings.map((w: { code: string }) => w.code);
  expect(codes).toContain('DEGRADED_BACKEND_UNAVAILABLE');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-storage.test.ts`
Expected: FAIL — the three positive tests fail (no `DEGRADED_BACKEND_UNAVAILABLE` in `warnings`).

- [ ] **Step 3: Write the implementation**

In `xiNAS-MCP/src/api/routes/storage.ts`, add the import after the existing `../handlers/reads.js` import block:

```ts
import { degradedCollectorWarnings } from '../handlers/collector-health.js';
```

Change the `GET /arrays` handler's `sendOk` call to pass the warning as the 5th arg:

```ts
  r.get('/arrays', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/XiraidArray/',
    );
    sendOk(
      req,
      res,
      unwrapResources(rows),
      rows.map((x) => x.revision),
      degradedCollectorWarnings(ctx, 'XiraidArray'),
    );
  });
```

Change `GET /disks` the same way — its `sendOk` already builds `values`, so append the 5th arg:

```ts
    sendOk(
      req,
      res,
      values,
      rows.map((x) => x.revision),
      degradedCollectorWarnings(ctx, 'Disk'),
    );
```

Change `GET /filesystems` the same way:

```ts
  r.get('/filesystems', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Filesystem/');
    sendOk(
      req,
      res,
      unwrapResources(rows),
      rows.map((x) => x.revision),
      degradedCollectorWarnings(ctx, 'Filesystem'),
    );
  });
```

Leave the single-item `GET /…/:id` handlers untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-storage.test.ts`
Expected: PASS (all storage-route tests, including the 4 new ones).

- [ ] **Step 5: Format + commit**

Run: `cd xiNAS-MCP && npm run format:check && npm run lint && npm run typecheck`
Expected: all clean. (If `format:check` reports diffs, run `npm run format:write` and re-stage.)

```bash
git add xiNAS-MCP/src/api/routes/storage.ts xiNAS-MCP/src/__tests__/api/routes-storage.test.ts
git commit -m "feat(api): observed-read list routes warn DEGRADED_BACKEND_UNAVAILABLE

GET /arrays|disks|filesystems attach the warning when their backing
collector (XiraidArray|Disk|Filesystem) is errored, so a down/stale
backend is no longer indistinguishable from 'genuinely none'.

Requires-Rebuild: xinas_node_build, xinas_api
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: TUI helper `degraded_banner`

**Files:**
- Create: `xinas_menu/api/degraded.py`
- Test: `tests/test_degraded.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_degraded.py`:

```python
from xinas_menu.api.degraded import degraded_banner


def test_returns_message_when_degraded_warning_present():
    env = {
        "result": [],
        "warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE", "message": "xiRAID down"}],
    }
    assert degraded_banner(env) == "xiRAID down"


def test_none_when_no_degraded_warning():
    assert degraded_banner({"result": [], "warnings": []}) is None
    assert degraded_banner({"result": []}) is None
    assert degraded_banner({"warnings": [{"code": "OTHER", "message": "x"}]}) is None


def test_falls_back_when_message_missing():
    env = {"warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE"}]}
    assert degraded_banner(env) == "Backend unavailable"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_degraded.py -v`
Expected: FAIL — `ModuleNotFoundError: xinas_menu.api.degraded`.

- [ ] **Step 3: Write minimal implementation**

Create `xinas_menu/api/degraded.py`:

```python
"""Shared helper: extract a degraded-backend banner from an API envelope.

The observed-read list routes attach a DEGRADED_BACKEND_UNAVAILABLE warning
when their backing collector is errored (s8-clients-spec §5.1). Screens show
the message as a banner instead of a misleading "(no ... configured)".
"""

from __future__ import annotations

from typing import Any

_DEGRADED_CODE = "DEGRADED_BACKEND_UNAVAILABLE"


def degraded_banner(envelope: dict[str, Any]) -> str | None:
    """Return the degraded-backend message from an envelope's warnings, else None."""
    for warning in envelope.get("warnings") or []:
        if isinstance(warning, dict) and warning.get("code") == _DEGRADED_CODE:
            return str(warning.get("message") or "Backend unavailable")
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_degraded.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add xinas_menu/api/degraded.py tests/test_degraded.py
git commit -m "feat(tui): degraded_banner helper reads DEGRADED_BACKEND_UNAVAILABLE from envelope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: RAID screen banner

**Files:**
- Modify: `xinas_menu/screens/raid.py` (`_format_raid_overview` at line ~1184; `_show_quick` ~358; `_show_extended` ~369)
- Test: `tests/test_raid_overview.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_raid_overview.py`:

```python
from xinas_menu.screens.raid import _format_raid_overview


def test_banner_prepended_and_replaces_empty_state():
    out = _format_raid_overview({}, banner="xiRAID down")
    assert "xiRAID down" in out
    assert "(no RAID arrays configured)" not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_raid_overview({})
    assert "(no RAID arrays configured)" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_raid_overview.py -v`
Expected: FAIL — `_format_raid_overview()` got an unexpected keyword argument `banner`.

- [ ] **Step 3: Implement the formatter change**

In `xinas_menu/screens/raid.py`, change the signature and the empty-state branch of `_format_raid_overview`:

```python
def _format_raid_overview(arrays: dict, extended: bool = False, banner: str | None = None) -> str:
    lines: list[str] = []

    if banner:
        lines.append(f"  {_YLW}⚠ {banner}{_NC}")
        lines.append("")

    title = "RAID ARRAYS — EXTENDED" if extended else "RAID ARRAYS — QUICK OVERVIEW"
    lines.append(_box_sep("="))
    pad = (_W - len(title)) // 2
    lines.append(
        f"{_DIM}|{_NC}{' ' * pad}{_BLD}{_CYN}{title}{_NC}{' ' * (_W - pad - len(title) + 1)}{_DIM}|{_NC}"
    )
    lines.append(_box_sep("="))
    lines.append("")

    if not arrays:
        if banner:
            lines.append(f"  {_YLW}xiRAID backend unavailable — cannot list arrays.{_NC}")
        else:
            lines.append(f"  {_DIM}(no RAID arrays configured){_NC}")
        return "\n".join(lines)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_raid_overview.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the screen to pass the banner**

At the top of `xinas_menu/screens/raid.py`, add to the imports block:

```python
from xinas_menu.api.degraded import degraded_banner
```

Replace the body of `_show_quick`:

```python
    @work(exclusive=True)
    async def _show_quick(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays…")
        try:
            env = await asyncio.to_thread(self.app.control.get, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(
            _format_raid_overview(
                _arrays_from_api(env.get("result")), extended=False, banner=degraded_banner(env)
            )
        )
```

Replace the body of `_show_extended` identically except `extended=True` and the loading string `"Loading RAID arrays (extended)…"`:

```python
    @work(exclusive=True)
    async def _show_extended(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("Loading RAID arrays (extended)…")
        try:
            env = await asyncio.to_thread(self.app.control.get, "/api/v1/arrays")
        except ControlPathError as exc:
            view.set_content(f"Could not load RAID info: {exc}")
            return
        view.set_content(
            _format_raid_overview(
                _arrays_from_api(env.get("result")), extended=True, banner=degraded_banner(env)
            )
        )
```

- [ ] **Step 6: Run the formatter test + full raid-related tests**

Run: `python -m pytest tests/test_raid_overview.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add xinas_menu/screens/raid.py tests/test_raid_overview.py
git commit -m "feat(tui): RAID screen shows degraded banner instead of 'no arrays'

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Filesystem screen banner

**Files:**
- Modify: `xinas_menu/screens/filesystem.py` (`_list_filesystems` ~245; `_show_filesystems` ~253)
- Test: `tests/test_fs_overview.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_fs_overview.py`:

```python
from xinas_menu.screens.filesystem import _format_filesystems


def test_banner_replaces_empty_state():
    out = _format_filesystems([], banner="fs backend down")
    assert "fs backend down" in out
    assert "No XFS filesystems found." not in out
    assert "backend unavailable" in out.lower()


def test_no_banner_keeps_empty_state():
    out = _format_filesystems([])
    assert "No XFS filesystems found." in out


def test_rows_render_with_banner():
    rows = [
        {
            "mountpoint": "/mnt/data",
            "id": "data",
            "mounted": True,
            "backing_device": "/dev/xi_data",
            "options": ["rw"],
            "size_bytes": None,
        }
    ]
    out = _format_filesystems(rows, banner="degraded")
    assert "/mnt/data" in out
    assert "degraded" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_fs_overview.py -v`
Expected: FAIL — `cannot import name '_format_filesystems'`.

- [ ] **Step 3: Extract the pure formatter**

In `xinas_menu/screens/filesystem.py`, add this module-level function (near `_fs_rows_from_api`):

```python
def _format_filesystems(fs_rows: list[dict[str, Any]], banner: str | None = None) -> str:
    """Render the XFS filesystem list; a banner replaces the empty-state."""
    GRN, BLD, DIM, YLW, CYN, NC = (
        "\033[32m",
        "\033[1m",
        "\033[2m",
        "\033[33m",
        "\033[36m",
        "\033[0m",
    )
    lines = [f"{BLD}{CYN}XFS Filesystems{NC}\n"]
    if banner:
        lines.append(f"  {YLW}⚠ {banner}{NC}")
        lines.append("")
    if not fs_rows:
        if banner:
            lines.append(f"  {YLW}xiRAID backend unavailable — cannot list filesystems.{NC}")
        else:
            lines.append(f"  {DIM}No XFS filesystems found.{NC}")
        return "\n".join(lines)
    for fs in fs_rows:
        target = fs["mountpoint"] or fs["id"]
        mounted = f" {YLW}(not mounted){NC}" if not fs["mounted"] else ""
        lines.append(f"  {GRN}{target}{NC}{mounted}")
        lines.append(f"    Device:  {fs['backing_device'] or '?'}")
        lines.append(f"    Options: {DIM}{','.join(fs['options'])}{NC}")
        if fs.get("size_bytes") is not None:
            size = _fmt_size(fs.get("size_bytes"))
            free = _fmt_size(fs.get("free_bytes"))
            lines.append(f"    Size:    {size} total, {free} free")
        lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_fs_overview.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the envelope-returning list helper and rewire the screen**

In `xinas_menu/screens/filesystem.py`, add the import at the top:

```python
from xinas_menu.api.degraded import degraded_banner
```

Add a sibling to `_list_filesystems` and make `_list_filesystems` delegate to it (keeps the 3 wizard call sites unchanged):

```python
    async def _list_filesystems_with_status(self) -> tuple[list[dict[str, Any]], str | None]:
        """GET /api/v1/filesystems → (adapted rows, degraded banner or None)."""
        env = await asyncio.to_thread(self.app.control.get, "/api/v1/filesystems")
        return _fs_rows_from_api(env.get("result")), degraded_banner(env)

    async def _list_filesystems(self) -> list[dict[str, Any]]:
        """GET /api/v1/filesystems adapted to the screen's row shape."""
        rows, _ = await self._list_filesystems_with_status()
        return rows
```

Replace the body of `_show_filesystems` with:

```python
    @work(exclusive=True)
    async def _show_filesystems(self) -> None:
        """Display managed XFS filesystems (GET /api/v1/filesystems)."""
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content("  Scanning filesystems...")
        try:
            fs_rows, banner = await self._list_filesystems_with_status()
        except ControlPathError as exc:
            view.set_content(f"  \033[2mCould not load filesystems: {exc}\033[0m")
            return
        view.set_content(_format_filesystems(fs_rows, banner))
```

- [ ] **Step 6: Run the formatter test again**

Run: `python -m pytest tests/test_fs_overview.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add xinas_menu/screens/filesystem.py tests/test_fs_overview.py
git commit -m "feat(tui): Filesystem screen shows degraded banner instead of 'no filesystems'

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full verification

- [ ] **Step 1: API suite green (tests + format + lint + typecheck)**

Run: `cd xiNAS-MCP && npx vitest run && npm run format:check && npm run lint && npm run typecheck`
Expected: all pass, no format/lint/type errors.

- [ ] **Step 2: Python suite green**

Run: `python -m pytest tests/test_degraded.py tests/test_raid_overview.py tests/test_fs_overview.py tests/test_control_client.py -v`
Expected: all pass.

Run: `ruff check xinas_menu/api/degraded.py xinas_menu/screens/raid.py xinas_menu/screens/filesystem.py && ruff format --check xinas_menu/api/degraded.py xinas_menu/screens/raid.py xinas_menu/screens/filesystem.py`
Expected: clean.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --fill
```

Ensure the PR body / eventual squash commit retains `Requires-Rebuild: xinas_node_build, xinas_api` (aggregated from the Task 1–2 commits) so an update rebuilds and restarts the API.

---

## Self-review notes

- **Spec coverage:** §5.1 API triad → Tasks 1–2 (all three routes + healthy/errored cases). raid §3.1 → Task 4. fs §3.2 → Task 5. `degraded_banner` shared helper → Task 3.
- **Out of scope (per design):** Physical Drives screen (legacy gRPC `disk_list`), single-item `/…/:id`, wizard operational fetches — untouched by any task.
- **Type consistency:** helper is `degradedCollectorWarnings(ctx, kind) → Warning[]` everywhere; Python `degraded_banner(envelope) → str | None` everywhere; `_format_raid_overview(arrays, extended=False, banner=None)` and `_format_filesystems(fs_rows, banner=None)` signatures match their call sites.
