# S12 — Durable desired-state adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a targeted `config.rollback` optionally adopt the restored config as the new desired state (`adopt: true`), so a restore survives the next apply instead of being overwritten — by capturing the in-scope desired rows into KV per snapshot and re-asserting them as `desired_mutations` on adopt.

**Architecture:** Adoption is a desired-state rollback (the twin of S11's file restore). Capture is fully API-side: the `terminal`-success progress handler writes the in-scope desired rows to `/xinas/v1/snapshot-desired/{snapshot_after}`. Adopt reads that payload at plan time and emits `desired_mutations` (per-domain-gated, revision-pinned) that the existing apply txn applies atomically. Zero agent/Python change. Implements ADR-0015 / `docs/control-path/s12-durable-adoption-spec.md`.

**Tech Stack:** TypeScript (`xiNAS-MCP`, Node ESM `.js` import suffixes, vitest, biome), Python Textual TUI (`xinas_menu`, pytest), OpenAPI (`api-v1.yaml`, spectral).

---

## Conventions (read before starting)

- **TDD:** every code task writes the failing test first, runs it red, implements minimally, runs it green, commits.
- **ESM suffixes:** intra-package TS imports use `.js` (e.g. `from './snapshot-desired.js'`).
- **exactOptionalPropertyTypes:** never assign explicit `undefined` to an optional field — spread conditionally (`...(x !== undefined ? { x } : {})`).
- **Commands** (run from `xiNAS-MCP/` unless noted): `npm test` (vitest), `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:contracts`. Python (repo root, venv `/tmp/xinas-pytest-venv`): `… -m pytest tests/ -q`, `ruff check`, `ruff format --check`, `pyright`.
- **Commits:** per task; end the message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage explicit paths, never `git add -A`. No `Requires-Rebuild` trailer (TS/Python/docs only, no Ansible re-run).

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `docs/control-path/api-v1.yaml` | `config.rollback` request `adopt`; `ConfigSnapshot.adoptable` | T0 |
| `xiNAS-MCP/src/api/tasks/snapshot-desired.ts` (new) | `SNAPSHOT_DESIRED_PREFIX`, `ADOPT_KINDS`, `snapshotDesiredKey()`, the `SnapshotDesiredPayload` type, `captureSnapshotDesired(kv, snapshotId)`, `readSnapshotDesired(kv, snapshotId)` | T1 |
| `xiNAS-MCP/src/api/tasks/progress.ts` | `terminal`-success capture hook (skip `config.rollback`, synchronous before `releaseLeases`) | T2 |
| `xiNAS-MCP/src/api/routes/config-history.ts` | `adoptable` read-enrichment; pass `adopt` through the rollback route | T3, T7 |
| `xiNAS-MCP/src/api/plan/providers/config-rollback.ts` | `adopt` branch in `targetedPlan`: per-domain mutations + revision pins + blockers | T4 |
| `xiNAS-MCP/src/api/mcp/catalog.ts` | `config_history.rollback` description note | T7 |
| `xinas_menu/screens/snapshot_detail.py` | "make durable (adopt)" Restore path | T7 |
| `xiNAS-MCP/src/__tests__/api/snapshot-desired.test.ts` (new) | capture/read unit | T1 |
| `xiNAS-MCP/src/__tests__/api/task-progress-capture.test.ts` (new) | hook + timing unit | T2 |
| `xiNAS-MCP/src/__tests__/api/config-rollback-adopt.test.ts` (new) | provider unit | T4 |
| `xiNAS-MCP/src/__tests__/e2e/durable-adoption.test.ts` (new) | e2e | T8 |
| `docs/control-path/hardware-smoke-runbook.md` | §5f adopt smoke | T8 |

---

### Task 0: Contracts (api-v1 + cross-refs)

**Files:**
- Modify: `docs/control-path/api-v1.yaml` (the `config.rollback` request schema + `ConfigSnapshot` schema)

- [ ] **Step 1: Add `adopt` to the rollback request + `adoptable` to ConfigSnapshot.** Find the rollback request body schema (the `spec` for `/config-history/rollback`) and add under its `spec` properties:

```yaml
adopt:
  type: boolean
  default: false
  description: >-
    Adopt the restored config as the new desired state (durable). Targeted
    restores only; replaces desired within the captured domains. ADR-0015.
```

Find the `ConfigSnapshot` schema and add to its properties:

```yaml
adoptable:
  type: boolean
  description: >-
    True when the snapshot carries a captured desired-state payload (S12) and
    can be restored with adopt:true. Independent of `restorable`.
```

- [ ] **Step 2: Validate OpenAPI.**

Run (from repo root): `npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml`
Expected: `0 errors` (pre-existing `operation-description` warnings are fine).

- [ ] **Step 3: Commit.**

```bash
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
docs(api-v1): S12 T0 — config.rollback adopt + ConfigSnapshot.adoptable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Capture payload module (`snapshot-desired.ts`)

**Files:**
- Create: `xiNAS-MCP/src/api/tasks/snapshot-desired.ts`
- Test: `xiNAS-MCP/src/__tests__/api/snapshot-desired.test.ts`

The module owns the KV layout + capture/read. `kv` is the `KvStore` (`src/state/store.ts`): `list<T>({prefix})` → `{value,revision}[]`, `get<T>(key)` → `{value,revision}|null`, `put(key,value)`, `delete(key)`.

- [ ] **Step 1: Write the failing test.**

```typescript
// xiNAS-MCP/src/__tests__/api/snapshot-desired.test.ts
import { describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';
import {
  ADOPT_KINDS,
  captureSnapshotDesired,
  readSnapshotDesired,
  snapshotDesiredKey,
} from '../../api/tasks/snapshot-desired.js';

async function memKv() {
  const s = await openStateStore({ databasePath: ':memory:', auditJsonlPath: ':memory:', nodeId: 'n1' });
  return s;
}

describe('snapshot-desired capture/read', () => {
  it('captures only the in-scope desired kinds, keyed by snapshot id', async () => {
    const s = await memKv();
    s.kv.put('/xinas/v1/desired/Share/exp1', { kind: 'Share', id: 'exp1', spec: { path: '/e1' } });
    s.kv.put('/xinas/v1/desired/NetworkInterface/mlx0', { kind: 'NetworkInterface', id: 'mlx0', spec: { addresses: ['10.0.0.1/24'] } });
    s.kv.put('/xinas/v1/desired/Pool/p1', { kind: 'Pool', id: 'p1', spec: {} }); // out of scope

    captureSnapshotDesired(s.kv, 'snap-1');

    const payload = readSnapshotDesired(s.kv, 'snap-1');
    expect(payload).not.toBeNull();
    expect(Object.keys(payload!.kinds).sort()).toEqual([...ADOPT_KINDS].sort());
    expect(payload!.kinds.Share).toEqual([{ id: 'exp1', spec: { path: '/e1' } }]);
    expect(payload!.kinds.NetworkInterface).toEqual([{ id: 'mlx0', spec: { addresses: ['10.0.0.1/24'] } }]);
    expect(payload!.snapshot_id).toBe('snap-1');
    await s.close();
  });

  it('readSnapshotDesired returns null when no payload exists', async () => {
    const s = await memKv();
    expect(readSnapshotDesired(s.kv, 'ghost')).toBeNull();
    expect(snapshotDesiredKey('x')).toBe('/xinas/v1/snapshot-desired/x');
    await s.close();
  });
});
```

- [ ] **Step 2: Run red.** `npm test -- snapshot-desired` → FAIL (module missing).

- [ ] **Step 3: Implement `snapshot-desired.ts`.**

```typescript
// xiNAS-MCP/src/api/tasks/snapshot-desired.ts
import type { KvStore } from '../../state/store.js';

/** The desired kinds S12 captures + adopts (the kinds S11 restore renders to). */
export const ADOPT_KINDS = ['Share', 'ExportGroup', 'NfsProfile', 'NetworkInterface'] as const;
export type AdoptKind = (typeof ADOPT_KINDS)[number];

export const SNAPSHOT_DESIRED_PREFIX = '/xinas/v1/snapshot-desired/';
export const snapshotDesiredKey = (snapshotId: string): string =>
  `${SNAPSHOT_DESIRED_PREFIX}${snapshotId}`;

export interface CapturedRow {
  id: string;
  spec: unknown;
}
export interface SnapshotDesiredPayload {
  snapshot_id: string;
  kinds: Record<AdoptKind, CapturedRow[]>;
}

interface DesiredRowValue {
  id?: string;
  spec?: unknown;
}

/** Read the in-scope desired rows from KV and persist them as a single payload
 *  keyed by `snapshotId`. Synchronous; the caller guarantees timing (§3.2). */
export function captureSnapshotDesired(kv: KvStore, snapshotId: string): void {
  const kinds = {} as Record<AdoptKind, CapturedRow[]>;
  for (const kind of ADOPT_KINDS) {
    const rows = kv.list<DesiredRowValue>({ prefix: `/xinas/v1/desired/${kind}/` });
    kinds[kind] = rows.map((r) => ({ id: r.value.id ?? '', spec: r.value.spec ?? {} }));
  }
  const payload: SnapshotDesiredPayload = { snapshot_id: snapshotId, kinds };
  kv.put(snapshotDesiredKey(snapshotId), payload);
}

export function readSnapshotDesired(kv: KvStore, snapshotId: string): SnapshotDesiredPayload | null {
  const row = kv.get<SnapshotDesiredPayload>(snapshotDesiredKey(snapshotId));
  return row !== null ? row.value : null;
}
```

- [ ] **Step 4: Run green.** `npm test -- snapshot-desired` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**

```bash
git add xiNAS-MCP/src/api/tasks/snapshot-desired.ts xiNAS-MCP/src/__tests__/api/snapshot-desired.test.ts
git commit -m "$(cat <<'EOF'
feat(api): S12 T1 — snapshot-desired capture/read payload (ADR-0015)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Capture hook in the terminal handler

**Files:**
- Modify: `xiNAS-MCP/src/api/tasks/progress.ts` (the `terminal` case + the `deps` it uses; read the file to locate where `releaseLeases`/`revertDesired` are built and passed)
- Test: `xiNAS-MCP/src/__tests__/api/task-progress-capture.test.ts`

The hook calls `captureSnapshotDesired(kv, event.snapshot_id)` on `finalState === 'success'`, when `operation_kind !== 'config.rollback'`, **before** `deps.releaseLeases()`. Wire `captureDesired` into the same `deps` object that already carries `revertDesired`/`releaseLeases` so the engine injects the real KV (and tests can stub it).

- [ ] **Step 1: Write the failing test** (drives the deps contract + the skip + timing).

```typescript
// xiNAS-MCP/src/__tests__/api/task-progress-capture.test.ts
import { describe, expect, it, vi } from 'vitest';
import { applyEvent } from '../../api/tasks/progress.js'; // export it if not already

function deps(over = {}) {
  return {
    heartbeat: vi.fn(),
    releaseLeases: vi.fn(),
    revertDesired: vi.fn(),
    captureDesired: vi.fn(),
    operationKindOf: () => 'nfs.create',
    ...over,
  };
}

describe('terminal capture hook', () => {
  it('captures desired on success of a non-rollback op, BEFORE releaseLeases', () => {
    const calls: string[] = [];
    const d = deps({
      captureDesired: vi.fn(() => calls.push('capture')),
      releaseLeases: vi.fn(() => calls.push('release')),
    });
    const store = makeFakeStore(); // minimal: transition() no-op
    applyEvent(store, 't1', '/tmp', { task_id: 't1', sequence: 5, event_type: 'terminal', status: 'success', snapshot_id: 'snap-9' }, d);
    expect(d.captureDesired).toHaveBeenCalledWith('snap-9');
    expect(calls).toEqual(['capture', 'release']); // capture precedes drain
  });

  it('does NOT capture on failure', () => {
    const d = deps();
    applyEvent(makeFakeStore(), 't1', '/tmp', { task_id: 't1', sequence: 5, event_type: 'terminal', status: 'failed', error_code: 'EXECUTOR_FAILED' }, d);
    expect(d.captureDesired).not.toHaveBeenCalled();
  });

  it('does NOT capture for config.rollback ops', () => {
    const d = deps({ operationKindOf: () => 'config.rollback' });
    applyEvent(makeFakeStore(), 't1', '/tmp', { task_id: 't1', sequence: 5, event_type: 'terminal', status: 'success', snapshot_id: 'snap-9' }, d);
    expect(d.captureDesired).not.toHaveBeenCalled();
  });
});

// makeFakeStore: return an object with the methods applyEvent calls in the
// terminal branch (transition, upsertStage as needed) as vi.fn()s. Read
// progress.ts to mirror the exact calls; keep it minimal.
```

- [ ] **Step 2: Run red.** `npm test -- task-progress-capture` → FAIL.

- [ ] **Step 3: Implement.** In `progress.ts`, extend the `deps` type with `captureDesired(snapshotId: string): void` and `operationKindOf(taskId: string): string | undefined` (read the task's `operation_kind`; the store already has the row). In the `terminal` case, after `store.transition(taskId, patch)` and **before** `deps.releaseLeases()`:

```typescript
if (finalState === 'success' && event.snapshot_id !== undefined &&
    deps.operationKindOf(taskId) !== 'config.rollback') {
  try {
    deps.captureDesired(event.snapshot_id);
  } catch (err) {
    // best-effort: a capture failure must not fail the task (snapshot just
    // isn't adoptable). Log via the existing logger if one is in scope.
  }
}
```

Then wire the real `captureDesired: (id) => captureSnapshotDesired(ctx.state.kv, id)` and `operationKindOf` where the engine constructs `deps` (alongside `revertDesired`). Export `applyEvent` if the test needs it.

- [ ] **Step 4: Run green.** `npm test -- task-progress-capture` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**

```bash
git add xiNAS-MCP/src/api/tasks/progress.ts xiNAS-MCP/src/__tests__/api/task-progress-capture.test.ts
git commit -m "$(cat <<'EOF'
feat(api): S12 T2 — capture desired in terminal-success handler (ADR-0015)

Synchronous before releaseLeases; skips config.rollback ops.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `adoptable` read-enrichment

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/config-history.ts` (the snapshot list/show projection — read it to find where each `ConfigSnapshot` is projected for the read response)
- Test: add to `xiNAS-MCP/src/__tests__/api/` (the existing config-history read test, or a new `config-history-adoptable.test.ts`)

- [ ] **Step 1: Write the failing test.** A snapshot with a `snapshot-desired/{id}` payload projects `adoptable: true`; one without → `adoptable: false`; assert it is independent of `restorable`.

```typescript
// in the config-history read test
it('projects adoptable from snapshot-desired payload presence', async () => {
  // seed observed ConfigSnapshot rows snap-a (restorable, not adoptable) and
  // snap-b; put /xinas/v1/snapshot-desired/snap-b. GET the list.
  // expect snap-a.adoptable === false, snap-b.adoptable === true.
});
```

- [ ] **Step 2: Run red** → FAIL (field absent).

- [ ] **Step 3: Implement.** In the projection, set `adoptable: ctx.state.kv.get(snapshotDesiredKey(id)) !== null` (import from `../tasks/snapshot-desired.js`). Keep it a cheap per-row `get`.

- [ ] **Step 4: Run green** + `npm run typecheck`.

- [ ] **Step 5: Commit** (`feat(api): S12 T3 — ConfigSnapshot.adoptable read-enrichment`).

---

### Task 4: Provider adopt branch

**Files:**
- Modify: `xiNAS-MCP/src/api/plan/providers/config-rollback.ts`
- Test: `xiNAS-MCP/src/__tests__/api/config-rollback-adopt.test.ts`

`PlanContext.kv` is the read-only KV (`list`/`get` with `{value,revision}`). `PlanResult` already supports `affected_resources: {kind,id,revision?}[]` and `desired_mutations?: ({key,value}|{key,delete})[]`.

- [ ] **Step 1: Write the failing test** (the four sub-checks from spec §6).

```typescript
// xiNAS-MCP/src/__tests__/api/config-rollback-adopt.test.ts
import { describe, expect, it } from 'vitest';
import { configRollbackProvider } from '../../api/plan/providers/config-rollback.js';
import { snapshotDesiredKey } from '../../api/tasks/snapshot-desired.js';

function ctxWith(rows: Record<string, { value: unknown; revision: number }>) {
  return {
    kv: {
      list: ({ prefix }: { prefix: string }) =>
        Object.entries(rows).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
      get: (k: string) => rows[k] ?? null,
    },
  } as any;
}

const SNAP = 'snap-1';
function adoptableCtx() {
  return ctxWith({
    [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: { value: { id: SNAP, status: { restorable: true, files_changed: ['exports'] } }, revision: 7 },
    '/xinas/v1/desired/Share/expA': { value: { kind: 'Share', id: 'expA', spec: { path: '/a' } }, revision: 3 },
    '/xinas/v1/desired/Share/expB': { value: { kind: 'Share', id: 'expB', spec: { path: '/b' } }, revision: 4 },
    [snapshotDesiredKey(SNAP)]: { value: { snapshot_id: SNAP, kinds: { Share: [{ id: 'expA', spec: { path: '/a' } }], ExportGroup: [], NfsProfile: [], NetworkInterface: [] } }, revision: 1 },
  });
}

describe('config.rollback adopt branch', () => {
  it('per-domain: puts captured Share, deletes orphan Share, leaves untouched domains alone', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), { to: SNAP, reason: 'r', adopt: true });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expA', value: { kind: 'Share', id: 'expA', spec: { path: '/a' } } });
    expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expB', delete: true }); // orphan
    // NetworkInterface domain empty in payload → no NetworkInterface mutations
    expect(m.some((x) => x.key.includes('/NetworkInterface/'))).toBe(false);
  });

  it('revision pins: existing rows current rev, orphan delete current rev', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), { to: SNAP, reason: 'r', adopt: true });
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expA', revision: 3 });
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expB', revision: 4 });
  });

  it('blocks not_adoptable when no payload', async () => {
    const ctx = ctxWith({ [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: { value: { id: SNAP, status: { restorable: true } }, revision: 7 } });
    const plan = await configRollbackProvider.preflight(ctx, { to: SNAP, reason: 'r', adopt: true });
    expect(plan.blockers.map((b) => b.code)).toContain('not_adoptable');
  });

  it('INVALID_ARGUMENT for baseline + adopt', async () => {
    await expect(configRollbackProvider.preflight(adoptableCtx(), { to: 'baseline', reason: 'r', adopt: true }))
      .rejects.toThrow(/baseline/i);
  });

  it('adopt:false is the S11 plan (no desired_mutations)', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), { to: SNAP, reason: 'r' });
    expect(plan.desired_mutations ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement.** In `config-rollback.ts`:
  - `preflight`: parse `adopt` (`const adopt = (rawSpec as {adopt?: unknown}).adopt === true;`). If `adopt && spec.to === 'baseline'` → `throw new ApiException('INVALID_ARGUMENT', 'config.rollback: adopt is not valid for baseline reset')`. Pass `adopt` into `targetedPlan`.
  - `targetedPlan(spec: { to; reason; adopt?: boolean }, ctx)`: after building the S11 result, when `adopt === true`, compute the adopt overlay and merge it into the returned `affected_resources`, `blockers`, `desired_mutations`, `diff`:

```typescript
// DOMAINS: primary kind → the kinds replaced when that domain is adopted.
const DOMAINS: { primary: string; kinds: string[] }[] = [
  { primary: 'Share', kinds: ['Share', 'ExportGroup', 'NfsProfile'] },
  { primary: 'NetworkInterface', kinds: ['NetworkInterface'] },
];

function adoptOverlay(to: string, ctx: PlanContext): {
  mutations: ({ key: string; value: unknown } | { key: string; delete: true })[];
  pinned: { kind: string; id: string; revision: number }[];
  blocker?: { code: string; message: string };
} {
  const payloadRow = ctx.kv.get<{ kinds: Record<string, { id: string; spec: unknown }[]> }>(
    snapshotDesiredKey(to),
  );
  if (payloadRow === null) {
    return { mutations: [], pinned: [], blocker: { code: 'not_adoptable',
      message: `snapshot '${to}' has no captured desired-state payload (pre-S12 or a non-mutating/rollback op) — cannot adopt` } };
  }
  const payload = payloadRow.value.kinds;
  const mutations: ({ key: string; value: unknown } | { key: string; delete: true })[] = [];
  const pinned: { kind: string; id: string; revision: number }[] = [];
  for (const { primary, kinds } of DOMAINS) {
    if ((payload[primary] ?? []).length === 0) continue; // domain not captured → untouched
    for (const kind of kinds) {
      const captured = payload[kind] ?? [];
      const capturedIds = new Set(captured.map((r) => r.id));
      const current = ctx.kv.list<{ id?: string }>({ prefix: `/xinas/v1/desired/${kind}/` });
      const currentById = new Map(current.map((r) => [r.value.id ?? '', r.revision]));
      // puts (current rev for existing, 0 for absent-create)
      for (const row of captured) {
        mutations.push({ key: `/xinas/v1/desired/${kind}/${row.id}`, value: { kind, id: row.id, spec: row.spec } });
        pinned.push({ kind, id: row.id, revision: currentById.get(row.id) ?? 0 });
      }
      // orphan deletes (current rev)
      for (const [id, rev] of currentById) {
        if (!capturedIds.has(id)) {
          mutations.push({ key: `/xinas/v1/desired/${kind}/${id}`, delete: true });
          pinned.push({ kind, id, revision: rev });
        }
      }
    }
  }
  return { mutations, pinned };
}
```

Merge into the S11 `targetedPlan` return (only when `adopt`): append `overlay.blocker` to `blockers` if present; else set `desired_mutations: overlay.mutations`, append `overlay.pinned` to `affected_resources`, and add `adopt: true` + the mutation summary to `diff`. Keep `risk_level: 'destructive'`, the dangerous blocker, the `observed_freshness_ref`, and the `ConfigHistory/default` lease unchanged. Set `enriched_spec.adopt = adopt`.

- [ ] **Step 4: Run green** (`npm test -- config-rollback-adopt`) + `npm run typecheck` + `npm run test:contracts`.

- [ ] **Step 5: Commit** (`feat(api): S12 T4 — config.rollback adopt branch (per-domain mutations + revision pins)`).

---

### Task 5: Apply wiring + revert verification

**Files:**
- Test only: `xiNAS-MCP/src/__tests__/api/` (an apply-engine integration test; mirror the existing apply/desired_mutations tests)

No new production code — the apply txn ([engine.ts:462-479](xiNAS-MCP/src/api/tasks/engine.ts)) already applies `desired_mutations` with prior-value `desired_rollback`, guarded by `affected_resources` revisions ([engine.ts:397](xiNAS-MCP/src/api/tasks/engine.ts)). This task PROVES the adopt plan flows through correctly.

- [ ] **Step 1: Write the test.** Drive a plan with adopt `desired_mutations` + pinned `affected_resources` through `apply`: (a) puts/deletes land in KV; (b) a concurrent desired bump on a pinned row → `PRECONDITION_FAILED` `stale`; (c) a terminal-failed task reverts the desired writes via `revertDesired`.

- [ ] **Step 2: Run red** (if any assertion fails against current behavior, it reveals a gap; otherwise it green-confirms the contract — keep the test as a guard).

- [ ] **Step 3:** No impl expected. If a gap surfaces (e.g. the pin path needs the `revision:0` create case), fix it minimally here.

- [ ] **Step 4: Run green.**

- [ ] **Step 5: Commit** (`test(api): S12 T5 — adopt desired_mutations apply + revert + stale guard`).

---

### Task 6: GC reconcile for orphan payloads

**Files:**
- Modify: the config-history/observed reconcile sweep (read `xiNAS-MCP/src/api/` for where observed `ConfigSnapshot` rows are reconciled/pruned; add the parallel prune of `snapshot-desired/*`)
- Test: alongside the reconcile test, or `xiNAS-MCP/src/__tests__/api/snapshot-desired-gc.test.ts`

- [ ] **Step 1: Write the failing test.** Given `snapshot-desired/{a}` and `{b}` but only observed `ConfigSnapshot/a`, the sweep deletes `snapshot-desired/{b}` and keeps `{a}`.

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement.** In the sweep, list `SNAPSHOT_DESIRED_PREFIX`, and for each key whose `{id}` has no `/xinas/v1/observed/ConfigSnapshot/{id}`, `kv.delete` it. Run on the same cadence as the existing observed reconcile.

- [ ] **Step 4: Run green** + `npm run typecheck`.

- [ ] **Step 5: Commit** (`feat(api): S12 T6 — GC orphan snapshot-desired payloads`).

---

### Task 7: Clients (catalog + TUI)

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/catalog.ts` (rollback description)
- Modify: `xiNAS-MCP/src/api/routes/config-history.ts` (ensure the rollback route forwards `adopt` from the request `spec` into the plan — verify it passes the whole `spec` through; S11 already does)
- Modify: `xinas_menu/screens/snapshot_detail.py` (adopt path)
- Test: `tests/test_config_history_restore.py` (extend) or a new `tests/test_snapshot_adopt.py`

- [ ] **Step 1 (catalog):** update the `config_history.rollback` description to note `adopt` (durable). Keep `requires_mcp_apply: true`. If `mcp-catalog.test.ts` pins the description, update it.

- [ ] **Step 2 (TUI test, red):** assert the Restore "make durable" path posts `{to, reason, adopt: true}` + `dangerous` via the control client (mirror `test_config_history_restore.py`'s `plan_apply_wait` body assertion); and that a non-`adoptable` snapshot does not offer the adopt option (`_snapshot_adoptable(engine, id)` gate, mirroring `_snapshot_restorable`).

- [ ] **Step 3 (TUI impl):** add the adopt menu item / second confirm naming that desired rows may be DELETED; gate on `adoptable`; call `plan_apply_wait('POST', '/api/v1/config-history/rollback', {to, reason, adopt: True}, dangerous=True, ...)` via `TaskWaitDialog`.

- [ ] **Step 4: Run green** — `npm test -- mcp-catalog` (if touched) + `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_snapshot_adopt.py -q` + `ruff check`/`ruff format --check`/`pyright xinas_menu`.

- [ ] **Step 5: Commit** (`feat(tui): S12 T7 — adopt (make durable) Restore path + catalog note`).

---

### Task 8: e2e + runbook + full gate

**Files:**
- Create: `xiNAS-MCP/src/__tests__/e2e/durable-adoption.test.ts` (mirror `targeted-rollback.test.ts`'s harness)
- Modify: `docs/control-path/hardware-smoke-runbook.md` (§5f)

- [ ] **Step 1: Write the e2e.** Real api+agent over UNIX sockets (fixture probe + the python3 shim that answers `snapshot create`/`snapshot restore` success). Scenario: create Share A (its success snapshot S captures desired) → create Share B → `plan` rollback `{to:S, adopt:true}` (expect the `dangerous` advisory + the adopt mutations in the diff) → `apply` with `dangerous:true` → task success → assert desired `Share/B` deleted, `Share/A` present. Plus: a pre-S12 snapshot (no payload) → `not_adoptable`; `{to:'baseline', adopt:true}` → 4xx INVALID_ARGUMENT. (Rebuild `dist/` first — e2e runs built output: `npm run build`.)

- [ ] **Step 2: Run the e2e.** `npm run build && npx vitest run --config vitest.e2e.config.ts durable-adoption` → PASS.

- [ ] **Step 3: Runbook §5f.** Add an on-node adopt smoke: snapshot, mutate, restore `--adopt`, confirm `drift` clean afterward for the captured domain.

- [ ] **Step 4: FULL GATE.** From `xiNAS-MCP/`: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run test:contracts`. From repo root: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`, `ruff check xinas_menu xinas_history`, `ruff format --check xinas_menu xinas_history`, `pyright xinas_menu xinas_history`, `npx --yes markdownlint-cli2 'docs/**/*.md'`, spectral on `api-v1.yaml`, and `gitleaks git --config .gitleaks.toml --log-opts="main..HEAD" .`. All green.

- [ ] **Step 5: Commit** (`test(e2e): S12 T8 — durable adoption end-to-end + runbook §5f`).

---

## Self-Review

- **Spec coverage:** T0 contracts; T1 payload §3.1; T2 capture hook §3.2; T3 adoptable §4.1; T4 provider §4.2 (per-domain #1, full-set #2, pins #3, blockers, baseline guard); T5 apply/revert §4.3; T6 GC §3.3; T7 clients §5; T8 e2e+gate §6. All spec sections mapped.
- **Type consistency:** `ADOPT_KINDS`, `snapshotDesiredKey`, `readSnapshotDesired`, `SnapshotDesiredPayload.kinds` used identically across T1/T2/T3/T4/T6. `captureDesired`/`operationKindOf` deps names match between T2 test and impl.
- **Open exec notes:** T2 requires exporting `applyEvent` (or testing via the handler) and locating the `deps` construction — read `progress.ts` + its caller first. T3/T6 require reading `config-history.ts` + the reconcile sweep for exact insertion points. These are integration points, not new contracts — the contracts (payload, mutations, pins, gating) are fully specified above.
