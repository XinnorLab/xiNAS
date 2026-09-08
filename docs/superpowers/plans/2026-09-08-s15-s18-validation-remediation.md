# S15–S18 validation remediation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open finding of the 2026-09-08 validation report on
`release/3.14` (S-01–S-03, I-01–I-07) so the S15/S16/S17/S18 slices can be
re-accepted: honest event producers, an unambiguous acknowledgement contract,
a RAID Create view that can be typed into and that fails closed, and specs
that claim exactly what the code proves.

**Architecture:** Three independent lanes touch disjoint files. Lane A
(events) makes the S17 producers tri-state — `healthy | unhealthy | unknown`
for RAID, `available | unavailable | unknown` for NFS backing / RDMA — so
missing data keeps the last proven state instead of becoming a domain event,
makes the session debounce survive an api restart, and ties
`timeAccuracy: task` to a real task transition time. Lane B (confirmation)
fixes the acknowledgement precedence table end to end and rewrites the S15
security boundary as two explicit trust models. Lane C (RAID Create App)
adds DOM-free helpers for handoff, pool membership and inventory trust,
preserves focus across re-renders, and adds a real-browser regression suite
(Playwright + Chromium) to the e2e job.

**Tech Stack:** TypeScript (Node 20, `xiNAS-MCP/`), vitest, better-sqlite3,
Vite single-file bundle for the App, Playwright 1.63 (new devDependency),
markdown specs under `docs/control-path/`.

**Spec:** the validation report
`~/.codex/.chatgpt-projects/g-p-6a8c12bda0e881918648865e13ec0334/xiNAS-3.14-S15-S18-validation-report.md`
(the findings), and the live specs it corrects:
`docs/control-path/s15-mcp-mrtr-confirmation-spec.md`,
`docs/control-path/s17-mcp-subscriptions-spec.md`,
`docs/control-path/s18-mcp-raid-create-app-spec.md`.

## Global Constraints

- Branch `fix/s15-s18-validation-findings`, based on `origin/release/3.14`
  at `590db7983e6d03d11b32612faee8a163d18cfbd4` (the report's HEAD). PRs
  target `release/3.14`, merged with `--merge` (never squash).
- **Every commit that changes a non-test file under `xiNAS-MCP/src/` ends
  with the trailer `Requires-Rebuild: xinas_node_build`** (CLAUDE.md
  §Update rebuild markers). Docs-only and test-only commits carry none.
- Commits use Conventional Commits (`fix(events): …`, `docs(control-path): …`)
  and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Path-scoped commits only.** Three lanes share one worktree; never run a
  bare `git commit` or `git add -A`. Stage new files with `git add <file>`,
  then `git commit -m "…" -- <every path of this task>`. If git reports
  `index.lock` exists, wait 2 s and retry once.
- **Node 20 is the verified runtime.** The machine's default Node is 25 and
  CI runs 20; better-sqlite3 worker threads crash on Node ≥ 24 on macOS.
  Prefix every npm/node/npx command with
  `env PATH=/private/tmp/claude-501/-Users-sergeyplatonov-Documents-GitHub-xiNAS/76891c2c-ef43-4ba2-821c-22a4bd47aa67/scratchpad/node20/node_modules/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  (below written as `env PATH=$N20 …`). Run from `xiNAS-MCP/`.
- Spec-first rule: each task edits the owning spec in the same commit as
  the code. English only in every repository artifact.
- Lint/format: `biome` — single quotes, semicolons, trailing commas, width
  100. Run `npm run lint && npm run format:check` before each commit; fix
  formatting with `npm run format:write` (it only touches `src/`).
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on: use
  conditional spreads for optional keys, never `key: undefined`.
- Vitest single-file runs: `npm test -- src/__tests__/<path>.test.ts`.
  Full unit gate: `npm test -- --maxWorkers=2 --minWorkers=1`.
- Lane C's browser test needs the built bundle: `npm run build:ui` (Vite only;
  it does not run `tsc`, so it cannot be broken by Lane A's in-progress
  edits) and, once, `npx playwright install chromium`.

## Lanes and ordering

| Lane | Tasks (in order) | Files owned |
|---|---|---|
| A — events | 1 → 2 → 3 → 4 | `src/api/events/**`, `src/__tests__/api/events/**`, `docs/control-path/s17-mcp-subscriptions-spec.md`, `docs/TODO.md` (one new entry, Task 4) |
| B — confirmation | 5 → 6 | `src/api/mcp/confirmation/**`, `src/api/mcp/catalog.ts`, `src/__tests__/api/mcp/**` (confirmation files), `src/__tests__/api/routes-mcp-confirmations.test.ts`, `src/__tests__/e2e/mcp-tasks-fs-create.test.ts`, `docs/control-path/api-v1.yaml`, `docs/control-path/s15-mcp-mrtr-confirmation-spec.md`, `docs/control-path/s8-clients-spec.md` |
| C — RAID Create App | 7 → 8 → 9 → 10 | `src/mcp-apps/**`, `src/__tests__/mcp-apps/**`, `src/__tests__/api/mcp/mcp-apps-handoff.test.ts` (new), `src/__tests__/e2e/raid-create-view.test.ts` (new), `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `docs/control-path/s18-mcp-raid-create-app-spec.md` |
| Final | 11 → 12 | `CHANGELOG.md`, `CLAUDE.md`, `xiNAS-MCP/.nvmrc`, full gates, PR |

Lanes may run concurrently; tasks inside a lane are sequential.

---

## Task 1: `timeAccuracy: task` only with a task transition time (I-04)

**Files:**
- Modify: `xiNAS-MCP/src/api/events/engine.ts` (`Cause`, `createTaskLookup`, new `correlationFields`)
- Modify: `xiNAS-MCP/src/api/events/envelope.ts` (`buildEvent` invariant)
- Modify: `xiNAS-MCP/src/api/events/producers/raid.ts` (lines 224–236, 248–262)
- Modify: `xiNAS-MCP/src/api/events/producers/storage.ts` (lines 163–171, 179–187, 208–221)
- Test: `xiNAS-MCP/src/__tests__/api/events/envelope.test.ts`, `engine.test.ts`, `producers-raid.test.ts`, `producers-storage.test.ts`
- Spec: `docs/control-path/s17-mcp-subscriptions-spec.md` §6.3 (lines 504–512), §8.2 lifecycle paragraph

**Interfaces:**
- Produces: `Cause = { taskId: string; operationId?: string; occurredAtMs?: number }`;
  `correlationFields(cause: Cause | undefined): Pick<EmitSpec, 'cause' | 'timeAccuracy' | 'occurredAtMs'>` (exported from `engine.ts`); `buildEvent` throws `RangeError` when `timeAccuracy` is `task`/`source` without `occurredAtMs`.

- [ ] **Step 1: Write the failing envelope test**

Append to the `describe('details schemas …')` block's sibling level in `src/__tests__/api/events/envelope.test.ts` (a new `describe`):

```ts
describe('time accuracy (S17 §6.3)', () => {
  const base = {
    feed: 'raid' as const,
    type: 'raid.array.created',
    subject: { kind: 'XiraidArray' as const, id: 'a' },
    source: { kind: 'observed_transition' as const, component: 'XiraidArray' },
    detectedAtMs: 1_700_000_000_000,
    args: { array: 'a' },
  };

  it("refuses timeAccuracy 'task' without a transition time", () => {
    expect(() => buildEvent({ ...base, timeAccuracy: 'task', cause: { taskId: 't' } })).toThrow(
      RangeError,
    );
    expect(() => buildEvent({ ...base, timeAccuracy: 'source' })).toThrow(RangeError);
  });

  it('renders occurredAt from the transition time and leaves it out for observed events', () => {
    const ev = buildEvent({
      ...base,
      timeAccuracy: 'task',
      occurredAtMs: 1_700_000_000_000 - 5000,
      cause: { taskId: 't' },
    });
    expect(ev.timeAccuracy).toBe('task');
    expect(ev.occurredAt).toBe('2023-11-14T22:13:15.000Z');
    expect(buildEvent(base).occurredAt).toBeUndefined();
    expect(buildEvent(base).timeAccuracy).toBe('observed');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/envelope.test.ts`
Expected: FAIL — "refuses timeAccuracy 'task' without a transition time" (no throw).

- [ ] **Step 3: Enforce the invariant in `buildEvent`**

In `src/api/events/envelope.ts`, at the top of `buildEvent` (before `if (spec.details !== undefined)`):

```ts
  // S17 §6.3: only `observed` may carry no occurredAt. `task` means "the
  // task transition's timestamp", `source` means "the vendor's" — a producer
  // that claims either without a time is a bug, not a downgrade.
  if (
    spec.timeAccuracy !== undefined &&
    spec.timeAccuracy !== 'observed' &&
    spec.occurredAtMs === undefined
  ) {
    throw new RangeError(
      `timeAccuracy '${spec.timeAccuracy}' requires occurredAtMs (event type '${spec.type}')`,
    );
  }
```

- [ ] **Step 4: Run the envelope test to see it pass**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/envelope.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing engine tests**

In `src/__tests__/api/events/engine.test.ts` replace the test
`'correlates a task only through the injected lookup'` with these three
(import `correlationFields` and `createTaskLookup` from
`'../../../api/events/engine.js'`, and `Database` from `'better-sqlite3'` /
`runMigrations` from `'../../../state/migrations.js'` if not already imported):

```ts
  it('correlates a task only through the injected lookup; a terminal transition time makes it task-accurate', () => {
    const calls: unknown[] = [];
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          const cause = ctx.correlate(['xiraid.array.create']);
          ctx.emit({
            feed: 'raid',
            type: 'raid.array.created',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
            ...correlationFields(cause),
          });
        }),
      ],
      taskLookup: (kinds, subject) => {
        calls.push([kinds, subject]);
        return { taskId: 't-1', operationId: 'c-1', occurredAtMs: Date.parse(OBSERVED_AT) - 1000 };
      },
    });
    h.batch((e) => e.onSnapshot('XiraidArray', new Set()));
    const events = h.step('XiraidArray', 'a', null, { status: {} });
    expect(calls).toEqual([[['xiraid.array.create'], { kind: 'XiraidArray', id: 'a' }]]);
    expect(events[0]?.cause).toEqual({ taskId: 't-1', operationId: 'c-1' });
    expect(events[0]?.timeAccuracy).toBe('task');
    expect(events[0]?.occurredAt).toBe('2026-09-04T11:59:59.000Z');
  });

  it('a correlation without a transition time keeps the event observed and still names the task', () => {
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          ctx.emit({
            feed: 'raid',
            type: 'raid.array.created',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
            ...correlationFields(ctx.correlate(['xiraid.array.create'])),
          });
        }),
      ],
      taskLookup: () => ({ taskId: 't-2' }),
    });
    h.batch((e) => e.onSnapshot('XiraidArray', new Set()));
    const events = h.step('XiraidArray', 'a', null, { status: {} });
    expect(events[0]?.cause).toEqual({ taskId: 't-2' });
    expect(events[0]?.timeAccuracy).toBe('observed');
    expect(events[0]?.occurredAt).toBeUndefined();
  });

  it('createTaskLookup returns terminal_at for a terminal task and no time for a running one', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
         input_hash, risk_level, affected_resources, created_at, updated_at, terminal_at)
       VALUES (@task_id, @kind, @state, 'p', 'rest', 'r', @correlation_id, 'h', 'non_disruptive',
         @affected, @created_at, @updated_at, @terminal_at)`,
    );
    const now = Date.parse(OBSERVED_AT);
    const affected = JSON.stringify([{ kind: 'XiraidArray', id: 'a' }]);
    insert.run({ task_id: 't-done', kind: 'xiraid.array.create', state: 'success', correlation_id: 'c-done', affected, created_at: now - 60_000, updated_at: now - 30_000, terminal_at: now - 30_000 });
    insert.run({ task_id: 't-run', kind: 'xiraid.array.create', state: 'running', correlation_id: 'c-run', affected: JSON.stringify([{ kind: 'XiraidArray', id: 'b' }]), created_at: now - 10_000, updated_at: now - 5_000, terminal_at: null });
    const lookup = createTaskLookup(db, () => now);
    expect(lookup(['xiraid.array.create'], { kind: 'XiraidArray', id: 'a' })).toEqual({
      taskId: 't-done',
      operationId: 'c-done',
      occurredAtMs: now - 30_000,
    });
    expect(lookup(['xiraid.array.create'], { kind: 'XiraidArray', id: 'b' })).toEqual({
      taskId: 't-run',
      operationId: 'c-run',
    });
    db.close();
  });
```

- [ ] **Step 6: Run the engine tests to see them fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/engine.test.ts`
Expected: FAIL — `correlationFields` is not exported; the terminal lookup lacks `occurredAtMs`.

- [ ] **Step 7: Implement `Cause.occurredAtMs`, `correlationFields`, the lookup**

In `src/api/events/engine.ts`:

```ts
export interface Cause {
  taskId: string;
  operationId?: string;
  /**
   * Epoch ms of the task transition this correlation vouches for: the
   * terminal transition (`tasks.terminal_at`) of a task that has finished.
   * Absent for a task that is still `running` — `updated_at` moves with
   * every progress patch and is not a transition time, and the api never
   * substitutes its own clock (S17 §6.3).
   */
  occurredAtMs?: number;
}
```

After the `Emit` type:

```ts
/**
 * The envelope fields a correlation contributes (S17 §6.3): `cause` always
 * (identifiers only); `timeAccuracy: 'task'` plus `occurredAtMs` only when
 * the lookup vouched for a transition time. Otherwise the event stays
 * `observed` and still names the task.
 */
export function correlationFields(
  cause: Cause | undefined,
): Pick<EmitSpec, 'cause' | 'timeAccuracy' | 'occurredAtMs'> {
  if (cause === undefined) return {};
  const wire = {
    taskId: cause.taskId,
    ...(cause.operationId !== undefined ? { operationId: cause.operationId } : {}),
  };
  return cause.occurredAtMs !== undefined
    ? { cause: wire, timeAccuracy: 'task', occurredAtMs: cause.occurredAtMs }
    : { cause: wire };
}
```

In `createTaskLookup`, change the SELECT to
`SELECT task_id, correlation_id, terminal_at FROM tasks`, the row type to
`{ task_id: string; correlation_id: string; terminal_at: number | null }`, and the
return to:

```ts
    return {
      taskId: row.task_id,
      operationId: row.correlation_id,
      ...(typeof row.terminal_at === 'number' ? { occurredAtMs: row.terminal_at } : {}),
    };
```

- [ ] **Step 8: Use `correlationFields` in the producers**

`src/api/events/producers/raid.ts`: import `correlationFields` from `'../engine.js'`
(it is a value import; keep the `type` import for the others). Replace both
`...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),` (in the
`raid.array.removed` and `raid.array.created` emits) with `...correlationFields(cause),`.

`src/api/events/producers/storage.ts`: same import; replace the two
`...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),` and, in the
`filesystem.mount.failed` emit, replace the two lines
`cause,` / `timeAccuracy: 'task',` with `...correlationFields(cause),`.

- [ ] **Step 9: Update the producer tests that pinned `timeAccuracy: 'task'`**

`src/__tests__/api/events/producers-raid.test.ts`, test
`'carries the creating task as the cause when the lookup finds one'`: make the
lookup return `{ taskId: 't-c', operationId: 'op-c', occurredAtMs: Date.parse(OBSERVED_AT) - 2000 }`
and add:

```ts
      expect(ev[0]?.timeAccuracy).toBe('task');
      expect(ev[0]?.occurredAt).toBe('2026-09-04T11:59:58.000Z');
```

Add a sibling test right after it:

```ts
    it('a still-running creating task is named but leaves the event observed (no invented time)', () => {
      h.close();
      h = makeHarness({
        producers: [raidProducer, poolProducer],
        taskLookup: (kinds) => (kinds.includes('xiraid.array.create') ? { taskId: 't-r' } : null),
      });
      h.snapshot('XiraidArray', []);
      const ev = h.step('XiraidArray', 'a', null, arrayRow(['online']));
      expect(ev[0]?.cause).toEqual({ taskId: 't-r' });
      expect(ev[0]?.timeAccuracy).toBe('observed');
      expect(ev[0]?.occurredAt).toBeUndefined();
    });
```

`src/__tests__/api/events/producers-storage.test.ts`: in the
`filesystem.mount.failed` test (lookup returns `{ taskId: 't-m', operationId: 'op-m' }`)
add `expect(ev[0]?.timeAccuracy).toBe('observed');`; in the definitions test
(`fs.unmanage` → `{ taskId: 't-u' }`) add `expect(ev[0]?.timeAccuracy).toBe('observed');`.

- [ ] **Step 10: Run the four test files, then lint/format**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/`
Expected: PASS (all events suites).
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`
Expected: clean.

- [ ] **Step 11: Update the spec (S17 §6.3, §8.2)**

In `docs/control-path/s17-mcp-subscriptions-spec.md` §6.3 replace the `task`
row with:

```
| `task` (task-correlated events whose task has reached a terminal state) | commit time | the task's terminal transition time (`tasks.terminal_at`) |
```

and add after the table:

```
A correlation with a task that is still `running` names the task in
`cause` but keeps `timeAccuracy: observed` and carries no `occurredAt`:
the row's `updated_at` moves with every progress patch and is not a
transition time, and the api never promotes its own clock to
`occurredAt`. `TaskLookup` therefore returns `occurredAtMs` only from
`terminal_at`; `correlationFields()` (`api/events/engine.ts`) is the one
place that turns a `Cause` into envelope fields, and `buildEvent` refuses
`timeAccuracy: task | source` without `occurredAtMs` (a producer bug is
logged and the event skipped, never downgraded silently).
```

In §8.2 "Array lifecycle", change "`cause.taskId` when a `success`/`running`
xiNAS task … exists in `tasks`" to "`cause.taskId` when a `success`/`running`
xiNAS task … exists in `tasks`; `timeAccuracy: task` only for a `success`
one (§6.3)".

- [ ] **Step 12: Commit**

```bash
git commit -m "fix(events): task-correlated events are task-accurate only with a terminal transition time

A correlated task that is still running contributed timeAccuracy: task
without any occurredAt (report I-04). The lookup now returns the task's
terminal_at when it has one, correlationFields() derives the envelope
fields in one place, and buildEvent refuses task/source accuracy without
a time. Running tasks stay observed and still name the task.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/api/events/engine.ts xiNAS-MCP/src/api/events/envelope.ts xiNAS-MCP/src/api/events/producers/raid.ts xiNAS-MCP/src/api/events/producers/storage.ts xiNAS-MCP/src/__tests__/api/events/envelope.test.ts xiNAS-MCP/src/__tests__/api/events/engine.test.ts xiNAS-MCP/src/__tests__/api/events/producers-raid.test.ts xiNAS-MCP/src/__tests__/api/events/producers-storage.test.ts docs/control-path/s17-mcp-subscriptions-spec.md
```

---

## Task 2: Session debounce survives an api restart (I-03)

**Files:**
- Modify: `xiNAS-MCP/src/api/events/engine.ts` (`BatchInfo.epoch`)
- Modify: `xiNAS-MCP/src/api/events/producers/sessions.ts` (`Candidate.epoch`, confirm rule)
- Test: `xiNAS-MCP/src/__tests__/api/events/producers-sessions.test.ts`
- Spec: S17 §8.0 meta table (`session_candidates` row), §8.5 Sessions paragraph, §14 "api restart" row

**Interfaces:**
- Consumes: `BatchInfo.seq` (existing).
- Produces: `BatchInfo.epoch: string` — a random id per `TransitionEngine` instance; `Candidate = { kind, epoch?: string, seq, view }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/api/events/producers-sessions.test.ts` (add
`import { TransitionEngine } from '../../../api/events/engine.js';` and
`META_KEYS` from `'../../../api/events/meta.js'`):

```ts
  describe('api restart (I-03)', () => {
    /** A second engine over the SAME journal/db, as a restarted api would build. */
    function restarted(): (present: string[] | null) => number {
      const engine = new TransitionEngine(
        {
          journal: h.journal,
          db: h.db,
          controllerId: h.engine.controllerId,
          config: h.engine.config,
          now: () => h.clock.now,
        },
        [sessionsProducer],
      );
      return (present) =>
        h.db.transaction(() => {
          engine.begin({
            observedAt: OBSERVED_AT,
            completeSnapshots: present === null ? ['Filesystem'] : ['NfsSession'],
            kv: h.kv,
          });
          if (present !== null) engine.onSnapshot('NfsSession', new Set(present));
          return engine.commit().count;
        })();
    }

    it('confirms a persisted connect candidate on the first complete snapshot after a restart', () => {
      for (let i = 0; i < 12; i++) h.batch(() => {}); // the old process ran for a while
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      const snapshot = restarted();
      expect(snapshot(null)).toBe(0); // a batch without a session snapshot touches nothing
      expect(snapshot([ID])).toBe(1);
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual(['nfs.session.connected']);
      expect(snapshot([ID])).toBe(0); // confirmed exactly once
      expect(h.journal.metaGet(META_KEYS.sessionCandidates)).toBeNull();
    });

    it('cancels a persisted disconnect candidate when the first snapshot after a restart still shows the session', () => {
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      h.snapshot('NfsSession', [ID]);
      h.step('NfsSession', ID, session(), null, { present: [] });
      const snapshot = restarted();
      expect(snapshot([ID])).toBe(0);
      expect(h.journal.metaGet(META_KEYS.sessionCandidates)).toBeNull();
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual(['nfs.session.connected']);
    });

    it('confirms a persisted disconnect candidate when the first snapshot after a restart lacks the session', () => {
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      h.snapshot('NfsSession', [ID]);
      h.step('NfsSession', ID, session(), null, { present: [] });
      expect(restarted()([])).toBe(1);
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual([
        'nfs.session.connected',
        'nfs.session.disconnected',
      ]);
    });

    it('a candidate persisted before epochs existed is confirmed by the next complete snapshot', () => {
      h.journal.metaSet(META_KEYS.sessionCandidates, {
        [ID]: {
          kind: 'connect',
          seq: 999,
          view: { clientAddr: '10.0.0.1', exportPath: '/srv/data', protoVersion: 'v4.1', lockedFiles: 0 },
        },
      });
      expect(types(h.snapshot('NfsSession', [ID]))).toEqual(['nfs.session.connected']);
    });
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/producers-sessions.test.ts`
Expected: FAIL — the first restart test gets 0 from the second `snapshot([ID])` (the new engine's `seq` is 1 ≤ 13); the pre-epoch test fails likewise.

- [ ] **Step 3: Add the engine epoch**

`src/api/events/engine.ts`: `import { randomUUID } from 'node:crypto';`. In `BatchInfo`:

```ts
  /** Monotonic per engine instance; lets a producer tell "a later batch" apart. */
  seq: number;
  /**
   * Random per engine instance. `seq` restarts from 1 with the process, so
   * "a later batch" is `(epoch === mine && seq > theirs) || epoch !== mine`.
   */
  epoch: string;
```

In `TransitionEngine`: `readonly #epoch = randomUUID();` next to `#seq`, and in
`begin()` add `epoch: this.#epoch,` to `info`.

- [ ] **Step 4: Make the candidate epoch-aware**

`src/api/events/producers/sessions.ts`:

```ts
interface Candidate {
  kind: 'connect' | 'disconnect';
  /** The engine instance that created the candidate; absent on rows persisted before epochs existed. */
  epoch?: string;
  /** That instance's batch sequence; a later batch of the same instance, or any batch of another, confirms. */
  seq: number;
  view: SessionView;
}
```

Both `candidates[id] = { kind: …, seq: ctx.batch.seq, view: … }` sites become
`{ kind: …, epoch: ctx.batch.epoch, seq: ctx.batch.seq, view: … }`. In
`onSessionSnapshot` replace `if (c.seq >= ctx.batch.seq) continue; // same batch…` with:

```ts
    // Same batch of the same engine instance: not a second observation yet.
    // A candidate from another instance (the api restarted) or without an
    // epoch (persisted before epochs existed) is judged by this snapshot.
    if (c.epoch === ctx.batch.epoch && c.seq >= ctx.batch.seq) continue;
```

Update the file header comment: "the next complete `NfsSession` snapshot from a
LATER batch confirms or cancels it" → "from a LATER batch (a later sequence of
the same engine instance, or the first snapshot after an api restart)".

- [ ] **Step 5: Run the sessions tests, then the whole events folder**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/`
Expected: PASS.
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 6: Update the spec**

S17 §8.0 meta table: replace the `session_candidates` row with

```
| `session_candidates` | `{ <sessionId>: { kind, epoch, seq, view } }` (D-20) — `epoch` is the engine instance id, `seq` its batch counter |
```

§8.5 Sessions: after "confirmed `nfs.session.connected` by the next complete
`NfsSession` snapshot that still contains it (two consecutive observations)"
add "— a snapshot of a *later* batch: a later `seq` of the same engine
instance, or the first complete snapshot after an api restart (the
in-process counter restarts with the process, so a persisted candidate is
never compared against it)".

§14 "api restart" row: append "; session candidates are confirmed or
cancelled by the first complete `NfsSession` snapshot after the restart".

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(events): confirm session candidates after an api restart without waiting out the old sequence

The candidate stored the engine's process-local batch counter and the
snapshot skipped it while candidate.seq >= batch.seq, so after a restart a
connect was reported only once the new counter passed the old one (report
I-03). Candidates now carry the engine instance epoch; a later batch is a
later seq of the same epoch or any batch of another.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/api/events/engine.ts xiNAS-MCP/src/api/events/producers/sessions.ts xiNAS-MCP/src/__tests__/api/events/producers-sessions.test.ts docs/control-path/s17-mcp-subscriptions-spec.md
```

---

## Task 3: RAID producer — unknown never completes, fails or restores (I-01)

**Files:**
- Modify: `xiNAS-MCP/src/api/events/producers/raid.ts` (predicates, operation end/start, `warnUnknownWords`, restore)
- Modify: `xiNAS-MCP/src/api/events/schema.ts` (`RESTORE` enum, `restoreBy`)
- Test: `xiNAS-MCP/src/__tests__/api/events/producers-raid.test.ts`
- Spec: S17 §6.4 (`raid.restore.completed` row), §8.2 (health predicates, operation lifecycle table, restore paragraph), §17 row 13

**Interfaces:**
- Produces: `assess(v: ArrayView): 'healthy' | 'unhealthy' | 'unknown'` (exported), `isHealthy` kept as `assess(v) === 'healthy'`; `raid.restore.completed` `details.result ∈ healthy | read_only | offline | unrecovered | degraded | unhealthy | running | unknown`; `raid.restore.failed` keeps `not_restored`.

- [ ] **Step 1: Write the failing tests**

Add to `producers-raid.test.ts` inside `describe('RAID producer (S17 §8.2)')`, after the `'operation lifecycle'` block:

```ts
  describe('undecidable states never end an operation (I-01)', () => {
    it('an unknown array word at the end of an initialization is warned, kept active, and settled by the first proven state', () => {
      step(['online'], ['online', 'initing']);
      let ev = step(['online', 'initing'], ['future_state']);
      expect(types(ev)).toEqual(['raid.source.unknown_state']);
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({ generation: 1, active: true });
      ev = step(['future_state'], ['online']);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({ generation: 1, active: false });
      expect(types(step(['online'], ['online']))).toEqual([]);
    });

    it('online beside an unknown word is still undecided; a later proven fault is the failure', () => {
      step(['online'], ['online', 'initing']);
      expect(types(step(['online', 'initing'], ['online', 'future_state']))).toEqual([
        'raid.source.unknown_state',
      ]);
      const ev = step(['online', 'future_state'], ['offline']);
      expect(types(ev)).toEqual(['raid.operation.failed', 'raid.state.offline']);
      expect(ev[0]?.details).toMatchObject({ finalStates: ['offline'], generation: 1 });
    });

    it('a proven fault beside an unknown word is still a failure', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['need_init', 'future_state']);
      expect(types(ev)).toEqual(['raid.source.unknown_state', 'raid.operation.failed']);
    });

    it('an unknown member word blocks completion (warned once); members proven online complete it once', () => {
      step(['online'], ['online', 'initing']);
      const weird: ArrayOpts = {
        members: [
          ['d1', ['online']],
          ['d2', ['future_member_state']],
          ['d3', ['online']],
        ],
      };
      let ev = step(['online', 'initing'], ['online'], undefined, weird);
      expect(types(ev)).toEqual(['raid.source.unknown_state']);
      expect(ev[0]?.details).toMatchObject({ word: 'future_member_state' });
      expect(types(step(['online'], ['online'], weird, weird))).toEqual([]);
      ev = step(['online'], ['online'], weird, undefined);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(types(step(['online'], ['online']))).toEqual([]);
    });

    it('a member with no state is undecided, not healthy', () => {
      step(['online'], ['online', 'initing']);
      const blank: ArrayOpts = { members: [['d1', ['online']], ['d2', []], ['d3', ['online']]] };
      expect(types(step(['online', 'initing'], ['online'], undefined, blank))).toEqual([]);
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({ generation: 1, active: true });
    });

    it('the active word reappearing while the end is undecided is not a new start', () => {
      step(['online'], ['online', 'initing']);
      step(['online', 'initing'], ['future_state']);
      expect(types(step(['future_state'], ['online', 'initing']))).toEqual([]);
      const ev = step(['online', 'initing'], ['online']);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
    });

    it('an unknown word does not recover a condition; the proven healthy row does', () => {
      expect(types(step(['online'], ['degraded']))).toEqual(['raid.state.degraded']);
      expect(types(step(['degraded'], ['future_state']))).toEqual(['raid.source.unknown_state']);
      expect(types(step(['future_state'], ['online']))).toEqual(['raid.state.recovered']);
    });
  });
```

And inside `describe('restore after reboot')`:

```ts
    it('names degraded, running, unknown, unrecovered and member-faulted arrays instead of calling them healthy (I-01)', () => {
      h.journal.metaSet('restore_pending', { bootId: 'b2', knownArrays: ['a', 'b', 'c', 'd', 'e'] });
      h.kv.put('XiraidArray', 'a', arrayRow(['degraded', 'reconstructing']));
      h.kv.put('XiraidArray', 'b', { ...arrayRow(['online', 'initing']), id: 'b' });
      h.kv.put('XiraidArray', 'c', { ...arrayRow(['online', 'future_state']), id: 'c' });
      h.kv.put('XiraidArray', 'd', { ...arrayRow(['unrecovered']), id: 'd' });
      h.kv.put('XiraidArray', 'e', {
        ...arrayRow(['online'], {
          members: [
            ['d1', ['online']],
            ['d2', ['offline']],
            ['d3', ['online']],
          ],
        }),
        id: 'e',
      });
      const ev = h.snapshot('XiraidArray', ['a', 'b', 'c', 'd', 'e']);
      expect(ev.map((e) => [e.subject.id, e.type, e.severity, e.details?.result])).toEqual([
        ['a', 'raid.restore.completed', 'error', 'degraded'],
        ['b', 'raid.restore.completed', 'info', 'running'],
        ['c', 'raid.restore.completed', 'warning', 'unknown'],
        ['d', 'raid.restore.completed', 'critical', 'unrecovered'],
        ['e', 'raid.restore.completed', 'error', 'unhealthy'],
      ]);
      expect(h.journal.metaGet('restore_pending')).toBeNull();
    });
```

- [ ] **Step 2: Run to see them fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/producers-raid.test.ts`
Expected: FAIL — `raid.operation.failed`/`completed` emitted on unknown; restore reports `healthy`; `unrecovered` maps to `healthy`.

- [ ] **Step 3: Implement the tri-state predicates**

In `src/api/events/producers/raid.ts` replace `membersHealthy` and `isHealthy` with:

```ts
export type Health = 'healthy' | 'unhealthy' | 'unknown';

/** One member's state words, judged with the same vocabulary as the array. */
function memberHealth(states: string[]): Health {
  if (states.some((w) => MEMBER_BLOCKING_WORDS.has(w))) return 'unhealthy';
  if (states.length === 0 || states.some((w) => !KNOWN_WORDS.has(w))) return 'unknown';
  return states.includes('online') ? 'healthy' : 'unknown';
}

/**
 * Tri-state health (spec §8.2). `unhealthy` needs a proving word on the
 * array or on a member; `healthy` needs `online`, no unhealthy word, no
 * active operation and every member proven `online`; anything the
 * vocabulary cannot settle — an unknown array or member word, a member with
 * no state, no member states at all for an array that has members, or no
 * `online` word — is `unknown`. Unknown is never a completion, a failure
 * or a recovery (AC13: missing data never becomes state).
 */
export function assess(v: ArrayView): Health {
  const W = v.rawStates;
  if (W.some((w) => UNHEALTHY_WORDS.has(w))) return 'unhealthy';
  const members = [...v.members.values()].map(memberHealth);
  if (members.includes('unhealthy')) return 'unhealthy';
  if (isActive(v, 'initialization') || isActive(v, 'reconstruction')) return 'unhealthy';
  if (W.some((w) => !KNOWN_WORDS.has(w))) return 'unknown';
  if (members.includes('unknown')) return 'unknown';
  if (v.memberIds.length > 0 && v.members.size === 0) return 'unknown';
  if (!W.includes('online')) return 'unknown';
  return 'healthy';
}

export const isHealthy = (v: ArrayView): boolean => assess(v) === 'healthy';
```

- [ ] **Step 4: Judge the operation end by the durable op record**

Replace section "1. Operation ends." in `onArrayChange` with:

```ts
  // 1. Operation ends — judged by the durable op record, not by the previous
  //    row alone, so an end left undecided by an unknown state is settled by
  //    the first later observation the vocabulary can prove.
  for (const kind of OPERATION_KINDS) {
    const op = meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
    const wasActive = isActive(prev, kind) || op?.active === true;
    if (!wasActive || isActive(cur, kind)) continue;
    const generation = op?.generation ?? 1;
    const health = assess(cur);
    if (health === 'unknown') {
      // Not proven either way: no terminal event; the operation stays active
      // (same generation) and its progress state is kept for a later decision.
      if (op === null || !op.active) {
        meta.set(META_KEYS.raidOp(id, kind), { generation, active: true } satisfies OpMeta);
      }
      ctx.log('warn', 'event_operation_end_undecided', {
        array: id,
        kind,
        rawStates: cur.rawStates,
      });
      continue;
    }
    ctx.emit({
      feed: 'raid',
      type: health === 'healthy' ? 'raid.operation.completed' : 'raid.operation.failed',
      subject,
      args: { array: id, kind },
      previous: projection(prev),
      current: projection(cur),
      operation: { kind, generation },
      details: { array: id, kind, generation, finalStates: cur.rawStates, observedAt },
    });
    meta.set(META_KEYS.raidOp(id, kind), { generation, active: false } satisfies OpMeta);
    meta.delete(META_KEYS.progress(id, kind));
  }
```

In section "3. Operation starts." change the condition to

```ts
    const op = meta.get<OpMeta>(META_KEYS.raidOp(id, kind));
    // An operation whose end was never proven (op still active) is not a new
    // start when its word reappears: same generation, no event.
    if (!isActive(prev, kind) && isActive(cur, kind) && op?.active !== true) {
```

(and drop the now-duplicate `const op = …` inside the block; the existing
`const generation = (op?.generation ?? 0) + 1;` stays).

- [ ] **Step 5: Warn on unknown member words too**

Replace the first line of `warnUnknownWords` body with:

```ts
  const unknown = new Set(cur.rawStates.filter((w) => !KNOWN_WORDS.has(w)));
  for (const states of cur.members.values()) {
    for (const w of states) if (!KNOWN_WORDS.has(w)) unknown.add(w);
  }
  if (unknown.size === 0) return;
```

(keep the rest; iterate `for (const word of unknown)`).

- [ ] **Step 6: Restore outcomes**

Replace the `let result …; if … else result = 'healthy';` block in
`onArraySnapshot` with a call to a new helper placed above it:

```ts
type RestoreResult =
  | 'healthy'
  | 'read_only'
  | 'offline'
  | 'unrecovered'
  | 'degraded'
  | 'unhealthy'
  | 'running'
  | 'unknown'
  | 'not_restored';

/** Worst proven fact first; `healthy` only when `assess` proves it (spec §8.2). */
function restoreResult(v: ArrayView | null): RestoreResult {
  if (v === null || v.rawStates.includes('none')) return 'not_restored';
  const W = v.rawStates;
  if (W.includes('offline')) return 'offline';
  if (W.includes('unrecovered')) return 'unrecovered';
  if (W.includes('read_only')) return 'read_only';
  if (W.includes('degraded') || W.includes('need_recon')) return 'degraded';
  if (W.some((w) => UNHEALTHY_WORDS.has(w))) return 'unhealthy';
  if (OPERATION_KINDS.some((k) => isActive(v, k))) return 'running';
  const health = assess(v);
  if (health === 'healthy') return 'healthy';
  return health === 'unhealthy' ? 'unhealthy' : 'unknown';
}
```

and in the loop: `const result = restoreResult(v);`.

- [ ] **Step 7: Extend the details schema and severities**

`src/api/events/schema.ts`:

```ts
const restoreBy = (ctx: SeverityContext): Severity => {
  switch (ctx.details?.result) {
    case 'healthy':
    case 'running':
      return 'info';
    case 'read_only':
    case 'unknown':
      return 'warning';
    case 'unrecovered':
      return 'critical';
    default:
      return 'error';
  }
};
```

and `RESTORE`'s `result` to
`ENUM('healthy', 'read_only', 'offline', 'unrecovered', 'degraded', 'unhealthy', 'running', 'unknown', 'not_restored')`.

- [ ] **Step 8: Run the events suites, lint, format**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/`
Expected: PASS, including the pre-existing lifecycle/restore tests.
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 9: Update the spec**

S17 §6.4 row:

```
| `raid.restore.completed` | info (`healthy`, `running`), warning (`read_only`, `unknown`), error (`degraded`, `unhealthy`, `offline`), critical (`unrecovered`) | raid |
```

S17 §8.2 "Health predicates": replace the three bullets with

```
- `active(kind)`: `initing ∈ W` (initialization) / `reconstructing ∈ W`
  (reconstruction).
- `unhealthy`: `W ∩ {degraded, need_recon, need_init, inconsistent,
  read_only, offline, unrecovered, none} ≠ ∅`, or any member whose states
  contain `offline`, `reconstructing` or `need_recon`, or `active(*)`.
- `unknown`: not `unhealthy`, and one of: a word of `W` outside the
  vocabulary; a member word outside the vocabulary; a member with no
  state; no member states for an array whose spec lists members;
  `online ∉ W`.
- `healthy`: neither of the above (`online ∈ W`, every member proven
  `online`, no active operation).

`unknown` is a source problem, not a state: it is reported once per
(array, word) as `raid.source.unknown_state` (member words included) and
never completes, fails, recovers or restores anything.
```

Operation lifecycle table: replace the two `A →` rows with

```
| `A` (word, or `raid_op` still active) | `¬A ∧ healthy` | `raid.operation.completed` |
| `A` (word, or `raid_op` still active) | `¬A ∧ unhealthy` | `raid.operation.failed`; `details.finalStates = raw_states`; severity per §6.4 |
| `A` (word, or `raid_op` still active) | `¬A ∧ unknown` | nothing: `raid_op` stays active with the same generation, progress state is kept, `event_operation_end_undecided` is logged; the first later `healthy`/`unhealthy` observation emits the terminal event above |
| `raid_op` active after an undecided end | `A` again | nothing (no new generation) |
```

Restore paragraph: replace "present with `healthy` → … `{ result: "not_restored" }`" with

```
per known array, the worst proven fact wins: absent or `none ∈ W` →
`raid.restore.failed` `{ result: "not_restored" }`; `offline` → `offline`;
`unrecovered` → `unrecovered`; `read_only` → `read_only`; `degraded ∨
need_recon` → `degraded`; another unhealthy word → `unhealthy`; an active
operation → `running`; `unknown` per the predicates → `unknown`; only a
proven `healthy` → `healthy` (all but the first are
`raid.restore.completed` with that `result`, severities in §6.4).
```

§17 row 13: `| 13 | missing data never becomes state | §8.0, §8.2 (unknown), §8.5 (incomplete rows), §8.6, §14 |`.

- [ ] **Step 10: Commit**

```bash
git commit -m "fix(events): an unknown xiRAID state never completes, fails or restores an array

The RAID producer treated unknown array and member words as healthy, so
an initialization ending in a word outside the vocabulary was reported
completed or failed and a degraded/reconstructing array after a reboot
was reported restored healthy (report I-01). Health is now tri-state; an
undecided end keeps the operation active and is settled by the first
proven observation; restore names degraded, running, unknown, unrecovered
and member-faulted arrays.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/api/events/producers/raid.ts xiNAS-MCP/src/api/events/schema.ts xiNAS-MCP/src/__tests__/api/events/producers-raid.test.ts docs/control-path/s17-mcp-subscriptions-spec.md
```

---

## Task 4: NFS backing and RDMA readiness are tri-state (I-02)

**Files:**
- Modify: `xiNAS-MCP/src/api/events/producers/storage.ts` (`fsReadiness` replaces `fsUnavailableReason`)
- Modify: `xiNAS-MCP/src/api/events/producers/nfs.ts` (`evaluateBacking`, `evaluateRdma`)
- Test: `xiNAS-MCP/src/__tests__/api/events/producers-nfs.test.ts`, `producers-storage.test.ts` (only if it imports `fsUnavailableReason` — check with grep)
- Spec: S17 §8.5 (Backing readiness, NFS over RDMA), §14 new row
- Docs: `docs/TODO.md` (new entry, newest first — right after the header rule line)

**Interfaces:**
- Produces: `fsReadiness(v: FsView): { state: 'available' } | { state: 'unavailable'; reason: 'unmounted' | 'unit_failed' | 'ro_option' } | { state: 'unknown'; missing: string[] }` (exported from `storage.ts`). Engine log line `event_source_incomplete` with fields `{ kind, id, missing, kept }`.

- [ ] **Step 1: Write the failing tests**

In `producers-nfs.test.ts` add a helper after `fsRow`:

```ts
/** The same row with `effective_mount_options` absent (the collector could not read them). */
const fsRowNoOptions = (id: string, mountpoint: string, o: { mounted?: boolean } = {}): Row => {
  const row = fsRow(id, mountpoint, o);
  delete (row.status as Record<string, unknown>).effective_mount_options;
  return row;
};
const profileRowNoListener = (): Row => ({
  kind: 'NfsProfile',
  id: 'default',
  status: { rdma_port: 20049, observed_at: OBSERVED_AT },
});
```

Inside `describe('backing filesystem readiness')` add:

```ts
    it('missing effective_mount_options keeps the last proven state: no false recovery after a read-only fault (I-02)', () => {
      const id = 'srv-data2.mount';
      let ev = h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRow(id, '/srv/data2', { ro: true }));
      expect(types(ev)).toEqual(['nfs.export.backing_unavailable']);
      ev = h.step('Filesystem', id, fsRow(id, '/srv/data2', { ro: true }), fsRowNoOptions(id, '/srv/data2'));
      expect(types(ev)).toEqual([]);
      expect(h.journal.metaGet('backing_unavailable:srv/data2')).toBe(true);
      ev = h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2'), fsRow(id, '/srv/data2'));
      expect(types(ev)).toEqual(['nfs.export.backing_recovered']);
    });

    it('missing fields while available are silent; a missing mounted flag is unknown too', () => {
      const id = 'srv-data2.mount';
      expect(types(h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2')))).toEqual([]);
      const noMounted = fsRow(id, '/srv/data2');
      delete (noMounted.status as Record<string, unknown>).mounted;
      expect(types(h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2'), noMounted))).toEqual([]);
      expect(h.journal.metaGet('backing_unavailable:srv/data2')).toBeNull();
    });

    it('unknown before any proven state: the first proven fault is reported once, a failed unit is proven even with missing fields', () => {
      const id = 'srv-data2.mount';
      expect(types(h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2')))).toEqual([]);
      const ev = h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2', { mounted: false }));
      expect(types(ev)).toEqual(['nfs.export.backing_unavailable']);
      expect(ev[0]?.details).toMatchObject({ reason: 'unmounted' });
      const failed = fsRowNoOptions(id, '/srv/data2', { mounted: false });
      (failed.status as Record<string, unknown>).mount_unit_state = 'failed';
      expect(types(h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2', { mounted: false }), failed))).toEqual([]);
    });

    it('an incomplete row is logged as a source problem, not journaled', () => {
      h.close();
      const logs: unknown[] = [];
      h = makeHarness({
        producers: [nfsProducer],
        log: (level, msg, fields) => logs.push([level, msg, fields]),
      });
      h.kv.put('ExportRule', 'srv/data2', exportRow('/srv/data2', [{ host_pattern: '*', options: ['rw'] }]));
      const id = 'srv-data2.mount';
      h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2'));
      expect(logs).toContainEqual([
        'warn',
        'event_source_incomplete',
        expect.objectContaining({ kind: 'Filesystem', id, missing: ['effective_mount_options'], kept: 'available' }),
      ]);
    });
```

Inside `describe('NFS over RDMA readiness')` add:

```ts
    it('a link turning unknown keeps the last proven state; a proven down is unavailable; a proven up recovers (I-02)', () => {
      desired(true);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      expect(types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'unknown')))).toEqual([]);
      expect(types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'unknown'), ifaceRow('ib0', 'down')))).toEqual(['nfs.rdma.unavailable']);
      expect(types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'down'), ifaceRow('ib0', 'unknown')))).toEqual([]);
      expect(types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'unknown'), ifaceRow('ib0', 'up')))).toEqual(['nfs.rdma.recovered']);
    });

    it('with two managed paths: one proven up is ready; one unknown plus one down is undecided; both down is unavailable', () => {
      desired(true);
      managed('ib0');
      managed('ib1');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      h.kv.put('NetworkInterface', 'ib1', ifaceRow('ib1', 'up'));
      expect(types(h.step('NetworkInterface', 'ib1', ifaceRow('ib1', 'up'), ifaceRow('ib1', 'down')))).toEqual([]);
      expect(types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'unknown')))).toEqual([]);
      const ev = h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'unknown'), ifaceRow('ib0', 'down'));
      expect(types(ev)).toEqual(['nfs.rdma.unavailable']);
      expect(ev[0]?.details).toMatchObject({ interfaces: [] });
    });

    it('a listener whose state is not observed leaves the last proven state; a proven false listener is unavailable', () => {
      desired(true);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      expect(types(h.step('NfsProfile', 'default', profileRow(true), profileRowNoListener()))).toEqual([]);
      expect(types(h.step('NfsProfile', 'default', profileRowNoListener(), profileRow(false)))).toEqual(['nfs.rdma.unavailable']);
      expect(types(h.step('NfsProfile', 'default', profileRow(false), profileRowNoListener()))).toEqual([]);
      expect(types(h.step('NfsProfile', 'default', profileRowNoListener(), profileRow(true)))).toEqual(['nfs.rdma.recovered']);
    });
```

- [ ] **Step 2: Run to see them fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/producers-nfs.test.ts`
Expected: FAIL — `nfs.export.backing_recovered` on the options-less row; `nfs.rdma.unavailable` on `unknown`.

- [ ] **Step 3: Tri-state filesystem readiness**

In `src/api/events/producers/storage.ts` replace `fsUnavailableReason` with:

```ts
export type FsReadiness =
  | { state: 'available' }
  | { state: 'unavailable'; reason: 'unmounted' | 'unit_failed' | 'ro_option' }
  | { state: 'unknown'; missing: string[] };

/**
 * Whether the filesystem can back an export right now (S17 §8.5), or that
 * this row cannot say. A failed unit and `mounted: false` are proven; a
 * row that lacks `mounted` or the effective mount options proves neither
 * the fault nor its absence.
 */
export function fsReadiness(v: FsView): FsReadiness {
  if (v.unitState === 'failed') return { state: 'unavailable', reason: 'unit_failed' };
  if (v.mounted === false) return { state: 'unavailable', reason: 'unmounted' };
  if (v.mounted === null) return { state: 'unknown', missing: ['mounted'] };
  if (v.readOnly === true) return { state: 'unavailable', reason: 'ro_option' };
  if (v.readOnly === null) return { state: 'unknown', missing: ['effective_mount_options'] };
  return { state: 'available' };
}
```

Grep for other importers of `fsUnavailableReason` (`grep -rn fsUnavailableReason src/`) and switch them.

- [ ] **Step 4: Backing evaluation keeps the last proven state**

In `src/api/events/producers/nfs.ts` (import `fsReadiness` instead of `fsUnavailableReason`), replace the body of `evaluateBacking` from `const reason = …` to the end with:

```ts
  const readiness = fsReadiness(covering.view);
  const key = META_KEYS.backingUnavailable(exportId);
  const was = ctx.meta.get<boolean>(key) === true;
  if (readiness.state === 'unknown') {
    // Neither the fault nor the recovery is proven: keep the last proven
    // state and say so where an operator can see it (never as a domain event).
    ctx.log('warn', 'event_source_incomplete', {
      kind: 'Filesystem',
      id: covering.id,
      exportPath,
      missing: readiness.missing,
      kept: was ? 'unavailable' : 'available',
    });
    return;
  }
  const now = readiness.state === 'unavailable';
  if (now === was) return;
  if (mayEmit) {
    ctx.emit({
      feed: 'nfs',
      type: now ? 'nfs.export.backing_unavailable' : 'nfs.export.backing_recovered',
      subject: { kind: 'ExportRule', id: exportPath },
      args: { exportPath },
      relatedResources: [{ kind: 'Filesystem', id: covering.id }],
      ...(readiness.state === 'unavailable'
        ? { reasonCode: readiness.reason }
        : { previous: { severity: 'error' } }),
      details: {
        exportPath,
        mountpoint: covering.mountpoint,
        filesystem: covering.id,
        ...(readiness.state === 'unavailable' ? { reason: readiness.reason } : {}),
        observedAt: ctx.batch.observedAt,
      },
    });
  }
  if (now) ctx.meta.set(key, true);
  else ctx.meta.delete(key);
```

- [ ] **Step 5: RDMA readiness with proven paths**

Replace `evaluateRdma` from `const status = …` to the end with:

```ts
  const status = asRecord(observed.value.status);
  const listening = typeof status.rdma_listening === 'boolean' ? status.rdma_listening : null;
  const port = typeof status.rdma_port === 'number' ? status.rdma_port : undefined;

  const considered: string[] = [];
  const up: string[] = [];
  const undecided: string[] = [];
  for (const r of ctx.kv.list<Row>({ prefix: '/xinas/v1/observed/NetworkInterface/' })) {
    const id = typeof r.value.id === 'string' ? r.value.id : '';
    if (id.length === 0) continue;
    const s = asRecord(r.value.status);
    if (s.rdma_capable !== true) continue;
    if (ctx.kv.get(`/xinas/v1/desired/NetworkInterface/${id}`) === null) continue;
    considered.push(id);
    if (s.rdma_link_state === 'up') up.push(id);
    else if (s.rdma_link_state !== 'down') undecided.push(id);
  }
  if (considered.length === 0) return; // no managed RDMA interface observed: unknown

  const was = ctx.meta.get<boolean>(META_KEYS.rdmaUnavailable) === true;
  // Ready needs one proven path and a proven listener; unavailable needs a
  // proven-false listener or every path proven down. Anything else is not
  // a fact about the serving path and keeps the last proven state.
  let ready: boolean | null;
  if (listening === false) ready = false;
  else if (listening === null) ready = null;
  else if (up.length > 0) ready = true;
  else if (undecided.length === 0) ready = false;
  else ready = null;
  if (ready === null) {
    ctx.log('warn', 'event_source_incomplete', {
      kind: 'NfsProfile',
      id: 'default',
      missing: [
        ...(listening === null ? ['rdma_listening'] : []),
        ...undecided.map((id) => `NetworkInterface/${id}.rdma_link_state`),
      ],
      kept: was ? 'unavailable' : 'available',
    });
    return;
  }
  if (ready === !was) return;
  ctx.emit({
    feed: 'nfs',
    type: ready ? 'nfs.rdma.recovered' : 'nfs.rdma.unavailable',
    subject: { kind: 'SystemdUnit', id: 'nfs-server.service' },
    args: {},
    relatedResources: considered.map((id) => ({ kind: 'NetworkInterface', id })),
    ...(ready ? { previous: { severity: 'error' } } : {}),
    current: { listening: listening === true, interfaces_up: up },
    details: {
      listening: listening === true,
      interfaces: up,
      ...(port !== undefined ? { port } : {}),
      observedAt: ctx.batch.observedAt,
    },
  });
  if (ready) ctx.meta.delete(META_KEYS.rdmaUnavailable);
  else ctx.meta.set(META_KEYS.rdmaUnavailable, true);
```

- [ ] **Step 6: Run the events suites, lint, format**

Run: `env PATH=$N20 npm test -- src/__tests__/api/events/`
Expected: PASS (the pre-existing RDMA `unknown` first-observation test still passes: a first observation is baseline).
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 7: Update the spec and record the deferral**

S17 §8.5 "Backing readiness": replace "the backing is unavailable when
`¬mounted ∨ mount_unit_state = failed ∨ read_only`. A change of that boolean →"
with:

```
the backing is **unavailable** when `mount_unit_state = failed ∨ mounted =
false ∨ (mounted = true ∧ "ro" ∈ effective_mount_options)`, **available**
when `mounted = true ∧ effective_mount_options` is present without `ro`,
and **unknown** when the row lacks `mounted` or (while mounted) lacks
`effective_mount_options`. Only a proven change → 
```

and after "Evaluated on both `Filesystem` and `ExportRule` changes." add:

```
An `unknown` evaluation keeps the last proven state (meta
`backing_unavailable:<export>`), emits nothing, and logs
`event_source_incomplete` `{ kind, id, exportPath, missing, kept }` — the
rule can neither report the fault nor clear it from a row that does not
carry the field.
```

"NFS over RDMA": replace "Ready ⇔ observed `NfsProfile.status.rdma_listening = true ∧` at least one …
that is managed (`desired` row exists). A change →" with:

```
Ready ⇔ observed `NfsProfile.status.rdma_listening = true ∧` at least one
managed (`desired` row exists) observed `NetworkInterface` with
`rdma_capable ∧ rdma_link_state = up`. Unavailable ⇔ `rdma_listening =
false`, or `rdma_listening = true` and every managed RDMA interface has
`rdma_link_state = down`. Anything else — the listener flag absent, or no
proven-up path while some path reads `unknown` — is undecided: the last
proven state is kept and `event_source_incomplete` is logged. One proven
working path is enough for ready; "no proven path" and "every path proven
down" are different facts. A proven change →
```

§14 table: add the row

```
| observation row lacks a field a rule needs (`mounted`, `effective_mount_options`, `rdma_listening`, a link state of `unknown`) | the rule keeps its last proven state and logs `event_source_incomplete`; no domain event (§8.5) |
```

`docs/TODO.md`: insert right after the `---` line that follows the format
paragraph (newest first):

```
## MCP — S17 incomplete-source observations are logged, not journaled

*Deferred 2026-09-08, from the S15–S18 validation remediation
(`docs/superpowers/plans/2026-09-08-s15-s18-validation-remediation.md`, Task 4).*

**What is missing.** A journaled signal for an observation row that lacks a
field a producer rule needs (a `Filesystem` without
`effective_mount_options`, an `NfsProfile` without `rdma_listening`, an
RDMA link reading `unknown`), the way `raid.source.unknown_state` reports a
RAID word outside the vocabulary.

**What the code does instead.** The producer keeps its last proven state
and logs `event_source_incomplete` (`{ kind, id, missing, kept }`) through
the engine log; nothing reaches the feeds, so a client cannot subscribe to
it.

**Why it was cut.** A new event family is a closed-taxonomy change (§6.4,
§6.5, `producers` block, contract fixtures) with no consumer yet; the
domain feeds must not carry a non-domain event to fake one.

**What done looks like.** Either a `*.source.incomplete` family per feed
(warning, `details: { kind, id, missing }`, listed under `producers`) or a
counter on the S17 metrics registry once the `RegistryMetrics` adapter
lands, plus the log line removed.
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(events): NFS backing and RDMA readiness keep the last proven state on incomplete rows

A Filesystem row without effective_mount_options cleared a read-only
backing fault as recovered, and an RDMA link reading unknown was treated
as down (report I-02). Readiness is tri-state now: only proven facts
transition, an undecided row keeps the previous state and is logged as
event_source_incomplete; one proven-up path is ready, every path proven
down is unavailable, anything else is neither.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/api/events/producers/storage.ts xiNAS-MCP/src/api/events/producers/nfs.ts xiNAS-MCP/src/__tests__/api/events/producers-nfs.test.ts docs/control-path/s17-mcp-subscriptions-spec.md docs/TODO.md
```

(add `xiNAS-MCP/src/__tests__/api/events/producers-storage.test.ts` if it was touched).

---

## Task 5: One acknowledgement table, destructive wins (S-02)

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/types.ts` (new `requiredAcknowledgement`)
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/service.ts` (lines 820–826)
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/approval-page.ts` (`needsPhrase`, lines 63–67)
- Modify: `xiNAS-MCP/src/api/mcp/catalog.ts` (line 588 description)
- Modify: `docs/control-path/api-v1.yaml` (lines 1644–1650 and the approve route description ~3557–3563 — descriptions only)
- Test: new `xiNAS-MCP/src/__tests__/api/mcp/acknowledgement.test.ts`; `src/__tests__/api/routes-mcp-confirmations.test.ts`; `src/__tests__/api/mcp/mcp-confirmation.test.ts` (header comment + cases 11a/11b); `src/__tests__/api/mcp/approval-page.test.ts`; `src/__tests__/e2e/mcp-tasks-fs-create.test.ts` (comment only)
- Spec: `docs/control-path/s15-mcp-mrtr-confirmation-spec.md` §9.2 (lines 979–987), `docs/control-path/s8-clients-spec.md` line 423–424

**Interfaces:**
- Produces: `requiredAcknowledgement(record: { risk_level: string; rollback_model: string }): string | undefined` exported from `confirmation/types.ts`.

- [ ] **Step 1: Write the failing table test**

Create `src/__tests__/api/mcp/acknowledgement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ACK_DATA_LOSS,
  ACK_NO_ROLLBACK,
  requiredAcknowledgement,
} from '../../../api/mcp/confirmation/types.js';

// S15 §9.2 — the exhaustive risk × rollback table. Data loss is the worse
// fact, so a destructive record requires the data-loss phrase even when its
// rollback is also unsupported (report S-02: the page's rollback_limitation
// sentence carries the second fact).
describe('requiredAcknowledgement (S15 §9.2)', () => {
  const risks = ['non_disruptive', 'changing_access', 'destructive', 'unsupported_rollback'];
  const models = ['non_disruptive', 'changing_access', 'destructive', 'unsupported'];

  it.each(risks.flatMap((risk_level) => models.map((rollback_model) => [risk_level, rollback_model])))(
    'risk %s × rollback %s',
    (risk_level, rollback_model) => {
      const expected =
        risk_level === 'destructive'
          ? ACK_DATA_LOSS
          : risk_level === 'unsupported_rollback' || rollback_model === 'unsupported'
            ? ACK_NO_ROLLBACK
            : undefined;
      expect(requiredAcknowledgement({ risk_level, rollback_model })).toBe(expected);
    },
  );

  it('destructive + unsupported rollback requires the data-loss phrase, not the rollback phrase', () => {
    expect(requiredAcknowledgement({ risk_level: 'destructive', rollback_model: 'unsupported' })).toBe(
      ACK_DATA_LOSS,
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `env PATH=$N20 npm test -- src/__tests__/api/mcp/acknowledgement.test.ts`
Expected: FAIL — `requiredAcknowledgement` is not exported.

- [ ] **Step 3: Implement the helper and use it in the service**

`src/api/mcp/confirmation/types.ts`, after `ACK_NO_ROLLBACK`:

```ts
/**
 * The phrase an approval must carry (S15 §9.2) — exactly one, from the
 * exhaustive risk × rollback table. Data loss is the worse fact: a
 * `destructive` record always requires the data-loss phrase, even when its
 * rollback is also unsupported (the approval page's `rollback_limitation`
 * sentence still states that). Rollback-only records require the rollback
 * phrase; everything else needs none.
 */
export function requiredAcknowledgement(record: {
  risk_level: string;
  rollback_model: string;
}): string | undefined {
  if (record.risk_level === 'destructive') return ACK_DATA_LOSS;
  if (record.risk_level === 'unsupported_rollback' || record.rollback_model === 'unsupported') {
    return ACK_NO_ROLLBACK;
  }
  return undefined;
}
```

`service.ts`: replace the `const needed = …` ternary with
`const needed = requiredAcknowledgement(record);` (import it; drop the now-unused
`ACK_DATA_LOSS` / `ACK_NO_ROLLBACK` imports if nothing else uses them).

`approval-page.ts` `needsPhrase`:

```js
  function needsPhrase(rec) {
    // S15 §9.2: one phrase; data loss is the worse fact and wins.
    if (rec.risk_level === 'destructive') return ACK_DATA_LOSS;
    if (rec.rollback_model === 'unsupported' || rec.risk_level === 'unsupported_rollback') return ACK_NO_ROLLBACK;
    return null;
  }
```

`catalog.ts` line 588 description → `'Approve a pending URL-mode MCP confirmation out of band (admin; approver policy applies). Destructive records require --acknowledge "DATA MAY BE PERMANENTLY LOST" (also when their rollback is unsupported); records that are only rollback-unsupported require "ROLLBACK IS NOT SUPPORTED".'`

- [ ] **Step 4: Pin the precedence in the route, wire and page tests**

`routes-mcp-confirmations.test.ts`: after the test
`'approve: destructive needs the exact phrase; …'` add (import `ACK_NO_ROLLBACK`):

```ts
  it('approve: destructive with unsupported rollback needs the data-loss phrase; the rollback phrase is refused naming it (S-02)', async () => {
    const record = seedRecord(setup, {
      principal: 'admin:test',
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const rollbackPhrase = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_NO_ROLLBACK });
    expect(rollbackPhrase.status).toBe(400);
    expect(rollbackPhrase.body.errors?.[0]?.details?.required_acknowledge).toBe(ACK_DATA_LOSS);
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');
    const right = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_DATA_LOSS });
    expect(right.status).toBe(200);
    expect(right.body.result.status).toBe('approved');
  });

  it('approve: a non-destructive record with unsupported rollback needs the rollback phrase', async () => {
    const record = seedRecord(setup, {
      principal: 'admin:test',
      risk_level: 'non_disruptive',
      rollback_model: 'unsupported',
    });
    const wrong = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_DATA_LOSS });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors?.[0]?.details?.required_acknowledge).toBe(ACK_NO_ROLLBACK);
    const right = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_NO_ROLLBACK });
    expect(right.status).toBe(200);
  });
```

`mcp-confirmation.test.ts`: `planFsCreateForce` is `destructive` +
`unsupported`, so cases 11a/11b now require `ACK_DATA_LOSS`: change the import
to `ACK_DATA_LOSS`, both `{ acknowledge: ACK_NO_ROLLBACK }` bodies to
`{ acknowledge: ACK_DATA_LOSS }`, and rewrite the header "Task 11 addendum"
paragraph and the `// See the file header addendum …` comment to say: the
S-02 fix makes `destructive` win over `rollback_model: 'unsupported'` (S15
§9.2 table), so the phrase for this record is `ACK_DATA_LOSS`; the
precedence itself is pinned by `routes-mcp-confirmations.test.ts`.

`approval-page.test.ts`: find the `pageRecord()` fixture (line ~111) and the
test that drives an approve with `'DATA MAY BE PERMANENTLY LOST'` (line ~477);
add a sibling test that sets `serverRecord.rollback_model = 'unsupported'`
with `risk_level: 'destructive'`, types `'ROLLBACK IS NOT SUPPORTED'`, clicks
approve and expects `elements.status.textContent` to be
`'The acknowledgement phrase does not match.'` with no POST in `fetchLog`;
then types `'DATA MAY BE PERMANENTLY LOST'` and expects the approve POST body
to carry that phrase. Follow the existing `driveScript` pattern exactly.

`src/__tests__/e2e/mcp-tasks-fs-create.test.ts` header item 2 (lines 55–63):
reword to "That table (S15 §9.2) requires `ACK_NO_ROLLBACK` for a record that
is rollback-unsupported and not destructive; `fsCreateProvider` returns
`rollback_model: 'unsupported'` and `risk_level: 'non_disruptive'` for a
non-force create, so this approval carries `ACK_NO_ROLLBACK`." (the code at
line 392 is unchanged).

- [ ] **Step 5: Run the confirmation suites**

Run: `env PATH=$N20 npm test -- src/__tests__/api/mcp/ src/__tests__/api/routes-mcp-confirmations.test.ts src/__tests__/api/mcp-catalog.test.ts`
Expected: PASS.
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 6: Update the spec, the OpenAPI descriptions, S8**

S15 §9.2: replace the paragraph "For `risk_level: destructive` the `approve`
body MUST carry … no transition happens." with:

```
Exactly one acknowledgement phrase is ever required, from this exhaustive
table (`requiredAcknowledgement()` in `confirmation/types.ts`; the approval
page's `needsPhrase`, `operatorDecide`, the `xinasctl` description and
`api-v1.yaml` all state the same rule, and
`__tests__/api/mcp/acknowledgement.test.ts` pins every cell):

| `risk_level` | `rollback_model` | `approve` body MUST carry |
|---|---|---|
| `destructive` | any | `"acknowledge": "DATA MAY BE PERMANENTLY LOST"` |
| `unsupported_rollback` | any | `"acknowledge": "ROLLBACK IS NOT SUPPORTED"` |
| `non_disruptive` / `changing_access` | `unsupported` | `"acknowledge": "ROLLBACK IS NOT SUPPORTED"` |
| `non_disruptive` / `changing_access` | anything else | nothing (`{}` is a valid body) |

Data loss is the worse fact, so a record that is both destructive and
rollback-unsupported requires the data-loss phrase; the page still states
the second fact in `rollback_limitation` (§10.2) — the warning about data
loss never disappears because a second risk is present. Phrases are exact
and case-sensitive; a wrong or missing phrase is `INVALID_ARGUMENT` with
`details.required_acknowledge` naming the expected one, and no transition
happens.
```

`api-v1.yaml` `McpConfirmationDecision.description`:

```
        Body of `POST /mcp/confirmations/{id}/approve` and `/decline`.
        `acknowledge` is required on approve, exactly and case-sensitively:
        `DATA MAY BE PERMANENTLY LOST` for `risk_level: destructive`
        (whatever the rollback model), `ROLLBACK IS NOT SUPPORTED` for
        `risk_level: unsupported_rollback` or `rollback_model: unsupported`
        records that are not destructive; nothing otherwise. Ignored on
        decline. See the S15 spec §9.2 table.
```

and in the approve route description replace "Destructive and
unsupported-rollback records require the exact `acknowledge` phrase
(`INVALID_ARGUMENT` otherwise)." with "Destructive records require
`acknowledge: "DATA MAY BE PERMANENTLY LOST"`; rollback-unsupported records
that are not destructive require `"ROLLBACK IS NOT SUPPORTED"`
(`INVALID_ARGUMENT` naming the expected phrase otherwise)."

Run the spectral lint from the repo root:
`env PATH=$N20 npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml` → 0 errors.

`s8-clients-spec.md` line 423–424: "Destructive records require the exact
phrase `DATA MAY BE PERMANENTLY LOST`; records that are only
rollback-unsupported require `ROLLBACK IS NOT SUPPORTED` (S15 §9.2)."

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(mcp): destructive records always require the data-loss acknowledgement

The service checked rollback_model: unsupported before risk_level:
destructive, so a destructive record with an unsupported rollback was
approved with ROLLBACK IS NOT SUPPORTED and refused DATA MAY BE
PERMANENTLY LOST (report S-02). One exhaustive risk x rollback table now
drives operatorDecide, the approval page, the xinasctl description and
api-v1.yaml: destructive wins, rollback-only records keep the rollback
phrase, everything else needs none.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/api/mcp/confirmation/types.ts xiNAS-MCP/src/api/mcp/confirmation/service.ts xiNAS-MCP/src/api/mcp/confirmation/approval-page.ts xiNAS-MCP/src/api/mcp/catalog.ts xiNAS-MCP/src/__tests__/api/mcp/acknowledgement.test.ts xiNAS-MCP/src/__tests__/api/routes-mcp-confirmations.test.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts xiNAS-MCP/src/__tests__/api/mcp/approval-page.test.ts xiNAS-MCP/src/__tests__/e2e/mcp-tasks-fs-create.test.ts docs/control-path/api-v1.yaml docs/control-path/s15-mcp-mrtr-confirmation-spec.md docs/control-path/s8-clients-spec.md
```

---

## Task 6: S15 §3.5 states two trust models (S-01) — spec only

**Files:**
- Modify: `docs/control-path/s15-mcp-mrtr-confirmation-spec.md` §3.5 (lines 203–243), §18 Risks (append one bullet)

- [ ] **Step 1: Rewrite the opening of §3.5**

Replace the two lines "What MRTR proves is that **a credential other than the
requesting MCP client's accepted this exact plan**. It cannot prove more than
the node's own trust model allows:" with:

```
What MRTR proves depends on the mode. The two modes rest on two different
trust models, and neither is "a human is proven to have clicked" — each
names the party the server trusts:

- **Form mode** (`non_disruptive` / `changing_access` with a supported
  rollback, §3.2) trusts the **MCP host** — the application that renders
  the elicitation dialog (Claude Code, Codex, …) — to show the generated
  message (§10.1) to its user and to return that user's decision. The
  server verifies only that the `ElicitResult` came back with an intact
  `requestState` bound to the same principal, tool, arguments, plan,
  revision and key (§7), and that the record is still pending; the
  approver it records is that same principal (`approval_channel:
  mcp_form`, §8.3). A client that controls its own MCP messages can
  therefore fabricate an `accept`: **form mode does not resist a fully
  agent-controlled client.** What it guarantees is that nothing is applied
  without a round trip the host can display, log and refuse, and that a
  replayed, tampered or re-targeted answer is rejected (§7.3–§7.5). It is
  the right mode for an agent that reaches xiNAS through a host it does
  not control, which is the deployment MRTR-FORM-001…006 target.
- **URL mode** (`destructive`, `unsupported_rollback`, `rollback_model:
  unsupported`) trusts **the server's own record**: the apply proceeds
  only when a decision written by the approval routes exists (§9.1),
  taken under `approver_policy` (default `distinct_principal`: an `admin`
  credential other than the requester's, §9.2), and the client's `accept`
  is only consent to open the page (§4.4, V-07). This is the mode that
  proves that **a credential other than the requesting MCP client's
  accepted this exact plan**. It cannot prove more than the node's own
  trust model allows:
```

Keep the existing five bullets that follow (bearer surface, `surface: mcp`
scoping, root/`xinas-admin`, UDS break-glass, distinct credential ≠ distinct
person) as the URL-mode sub-list, indented one level under the URL bullet.
Then append, still in §3.5:

```
**Policy note (report S-01).** Whether *every* apply, including a
non-disruptive one, must resist an agent that controls its own client is
a product decision this spec does not make. Answering "yes" means
replacing form mode with url mode for every plan (or an operator switch
to that effect) and is recorded as an open question in §18; until it is
decided, the guarantee claimed for form mode is the host-mediated one
above, and no test or sentence in this spec should be read as claiming
more. Acceptance criterion 3 (§16) is a statement about url mode.
```

- [ ] **Step 2: Add the risk bullet in §18**

Append to §18:

```
- **Form-mode trust in the host (open question, S-01):** form mode
  accepts the host's elicitation result on the requester's own principal.
  A deployment whose agent controls its host gets no independent
  confirmation for non-disruptive and access-changing applies. If that
  deployment must be supported, the fix is a policy knob that sends every
  plan to url mode (`mcp.confirmation.min_mode: url`, not implemented),
  not a wording change — decide it explicitly before claiming it.
```

- [ ] **Step 3: Lint markdown**

Run from the repo root: `env PATH=$N20 npx --yes markdownlint-cli2 'docs/control-path/s15-mcp-mrtr-confirmation-spec.md'` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(control-path): S15 names the two MRTR trust models instead of one guarantee

§3.5 promised that every apply was accepted by a credential other than
the requesting client's; that holds for url mode only, while form mode
trusts the MCP host to relay its user's decision on the same principal
(report S-01). The section now states each model, what form mode does
and does not resist, and records the url-for-everything policy as an
open product question rather than masking it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- docs/control-path/s15-mcp-mrtr-confirmation-spec.md
```

---

## Task 7: The handoff follows whichever task result the host gets (S-03)

**Files:**
- Modify: `xiNAS-MCP/src/mcp-apps/plan-facts.ts` (add `handoffArguments`, `handoffMessage`)
- Modify: `xiNAS-MCP/src/mcp-apps/raid-create.ts` (`requestSecureApply`, lines 553–565)
- Test: `xiNAS-MCP/src/__tests__/mcp-apps/plan-facts.test.ts`; new `xiNAS-MCP/src/__tests__/api/mcp/mcp-apps-handoff.test.ts`
- Spec: `docs/control-path/s18-mcp-raid-create-app-spec.md` header "Depends on", §8, §11

**Interfaces:**
- Produces: `handoffArguments(plan: { plan_id: string; state_revision_expected?: number }, idempotencyKey: string): { mode: 'apply'; plan_id: string; expected_revision: number; idempotency_key: string }`; `handoffMessage(tools: { create: string; task_wait: string }, args: ReturnType<typeof handoffArguments>): string`.

- [ ] **Step 1: Write the failing helper tests**

Append to `src/__tests__/mcp-apps/plan-facts.test.ts` (extend the import):

```ts
describe('handoff (S18 §7.2, §8)', () => {
  it('builds exactly the four apply arguments, defaulting the revision to 0', () => {
    expect(handoffArguments({ plan_id: 'p1', state_revision_expected: 7 }, 'k1')).toEqual({
      mode: 'apply',
      plan_id: 'p1',
      expected_revision: 7,
      idempotency_key: 'k1',
    });
    expect(Object.keys(handoffArguments({ plan_id: 'p2' }, 'k2'))).toEqual([
      'mode',
      'plan_id',
      'expected_revision',
      'idempotency_key',
    ]);
    expect(handoffArguments({ plan_id: 'p2' }, 'k2').expected_revision).toBe(0);
  });

  it('tells the host to follow the native task handle or the tasks.wait fallback, whichever it receives', () => {
    const args = handoffArguments({ plan_id: 'p1' }, 'k1');
    const text = handoffMessage({ create: 'arrays.create', task_wait: 'tasks.wait' }, args);
    expect(text).toContain('Call arrays.create with exactly these arguments:');
    expect(text).toContain(JSON.stringify(args, null, 2));
    expect(text).toContain('resultType "task"');
    expect(text).toContain('tasks/get');
    expect(text).toContain('pollIntervalMs');
    expect(text).toContain('isError');
    expect(text).toContain('resultType "complete"');
    expect(text).toContain('tasks.wait');
    expect(text).toContain('initialization continues in the background');
    expect(text).not.toMatch(/bearer|token|requestState/i);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `env PATH=$N20 npm test -- src/__tests__/mcp-apps/plan-facts.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helpers and use them in the view**

Append to `src/mcp-apps/plan-facts.ts`:

```ts
export interface HandoffArguments {
  mode: 'apply';
  plan_id: string;
  expected_revision: number;
  idempotency_key: string;
}

/** The exact apply arguments the host must send (S18 §7.2). */
export function handoffArguments(
  plan: { plan_id: string; state_revision_expected?: number },
  idempotencyKey: string,
): HandoffArguments {
  return {
    mode: 'apply',
    plan_id: plan.plan_id,
    expected_revision: plan.state_revision_expected ?? 0,
    idempotency_key: idempotencyKey,
  };
}

/**
 * The user message handed to the host (S18 §7.2, §8). The host executes the
 * apply and gets ONE of two results, decided by the capabilities on its
 * final confirmation retry (S16 §8); it must continue by the one it got.
 */
export function handoffMessage(
  tools: { create: string; task_wait: string },
  args: HandoffArguments,
): string {
  return [
    'I reviewed the xiNAS RAID creation plan in the MCP App and request secure execution.',
    `Call ${tools.create} with exactly these arguments:`,
    JSON.stringify(args, null, 2),
    'Continue through the existing MRTR confirmation flow. Do not bypass confirmation and do not re-plan unless the server reports that this plan is stale.',
    'Then follow the result you actually receive:',
    '- resultType "task": keep its taskId (it is the xiNAS task_id), poll tasks/get at the returned pollIntervalMs until the status is terminal, and read the final CallToolResult — isError: true means the array was NOT created even though the task reads "completed".',
    `- resultType "complete": the result carries task_id and a next hint; call ${tools.task_wait} with that id until the task state is terminal (success, failed, cancelled, requires_manual_recovery).`,
    'A terminal task reports the control-path operation only: xiRAID initialization continues in the background and is reported separately (arrays.get, or the raid and raid/progress event feeds).',
  ].join('\n\n');
}
```

In `raid-create.ts` import `handoffArguments, handoffMessage` from `'./plan-facts.js'`
and in `requestSecureApply` replace the `applyArguments` and `message` literals with:

```ts
  const applyArguments = handoffArguments(plan, crypto.randomUUID());
  const message = handoffMessage(config.tools, applyArguments);
```

- [ ] **Step 4: Run the helper test**

Run: `env PATH=$N20 npm test -- src/__tests__/mcp-apps/plan-facts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the composition test (handoff → MRTR → both task shapes)**

Create `src/__tests__/api/mcp/mcp-apps-handoff.test.ts`, modeled on
`mcp-tasks.test.ts` (copy its `rpc`, `internalCall`, `META`, `call`, `taskRpc`,
`toolResultOf`, `payloadOf`, `resultOf`, `nextId`, `progress` helpers and its
`beforeAll` server config verbatim — `startServer`, `startMockAgentServer`,
`respondToHealth`, `mcp.allow_apply: true`). Seed eight observed disks instead
of shares:

```ts
function seedDisk(handle: Awaited<ReturnType<typeof startServer>>, index: number): string {
  const id = `serial-disk-${index}`;
  handle.state.kv.put(`/xinas/v1/observed/Disk/${id}`, {
    kind: 'Disk',
    id,
    status: {
      device_path: `/dev/nvme${index}n1`,
      serial: `S-${index}`,
      model: 'X',
      capacity_bytes: 1_000_000_000_000,
      safe_for_use: true,
      system_disk: false,
      mounted: false,
      observed_at: new Date().toISOString(),
    },
  });
  return id;
}
```

Tests:

```ts
describe('RAID Create App handoff → MRTR → task result (S18 §8, S-03)', () => {
  // beforeAll: start server + mock agent as in mcp-tasks.test.ts; const disks = [0..7].map(seedDisk)

  async function planArray(name: string, members: string[]) {
    const res = await call(port, 'tok-admin', nextId('plan'), 'arrays.create', {
      mode: 'plan',
      spec: { name, level: 'raid5', member_disk_ids: members, strip_size_kib: 128, block_size: 4096 },
    });
    const result = payloadOf(res).result as { plan_id: string; state_revision_expected?: number; blockers?: unknown[] };
    expect(result.blockers ?? []).toEqual([]);
    return result;
  }

  async function applyWithHandoff(args: HandoffArguments, caps: Record<string, unknown>) {
    const first = await call(port, 'tok-admin', nextId('call'), 'arrays.create', args, {}, caps);
    expect(toolResultOf(first).resultType).toBe('input_required');
    expect(toolResultOf(first).inputRequests?.confirm_apply?.params.mode).toBe('form');
    return call(
      port,
      'tok-admin',
      nextId('call'),
      'arrays.create',
      args,
      {
        requestState: toolResultOf(first).requestState,
        inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
      },
      caps,
    );
  }

  it('fallback: the exact handoff arguments reach a task with a tasks.wait next hint', async () => {
    const plan = await planArray('data_a', disks.slice(0, 4));
    const args = handoffArguments(plan, randomUUID());
    const second = await applyWithHandoff(args, FORM_ONLY);
    expect(toolResultOf(second).resultType).toBe('complete');
    const payload = payloadOf(second);
    const taskId = (payload.result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');
    expect(payload.next).toMatchObject({ tool: 'tasks.wait', args: { id: taskId, timeout_s: 25 } });
    expect(countTasksByPlan(plan.plan_id)).toBe(1);
  });

  it('native: the same arguments under the Tasks capability return a task handle; tasks/get reaches completed with isError telling success from failure', async () => {
    const plan = await planArray('data_b', disks.slice(4, 8));
    const args = handoffArguments(plan, randomUUID());
    const second = await applyWithHandoff(args, FORM_TASKS);
    const body = resultOf(second);
    expect(body.resultType).toBe('task');
    const taskId = body.taskId as string;
    expect(typeof taskId).toBe('string');
    expect(typeof body.pollIntervalMs).toBe('number');
    expect(countTasksByPlan(plan.plan_id)).toBe(1);

    let got = resultOf(await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP));
    expect(got.status).toBe('working');
    await progress(taskId, [
      { event_type: 'accepted', stage_total: 2 },
      { event_type: 'stage_started', stage_index: 0, stage_name: 'preflight' },
      { event_type: 'stage_failed', stage_index: 0, stage_name: 'preflight', error_code: 'XIRAID_ERROR', error_message: 'daemon refused' },
      { event_type: 'terminal', status: 'failed', error_code: 'XIRAID_ERROR', error_message: 'daemon refused' },
    ]);
    got = resultOf(await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP));
    expect(got.status).toBe('completed'); // "completed" is the protocol word, not success
    expect((got.result as { isError?: boolean }).isError).toBe(true);
    expect(got.pollIntervalMs).toBeUndefined();
  });
});
```

(If the `progress()` event shapes above are rejected by
`/internal/v1/task_progress`, copy the exact failed-task event sequence used by
`mcp-tasks.test.ts` case 5 "a task driven to terminal failed".)

- [ ] **Step 6: Run the composition test**

Run: `env PATH=$N20 npm test -- src/__tests__/api/mcp/mcp-apps-handoff.test.ts`
Expected: PASS (both shapes).
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 7: Update the S18 spec**

Header: `Depends on: S3 xiRAID array create, S8 MCP catalog/dispatcher, S14 modern MCP, S15 MRTR confirmation, S16 MCP Tasks`.

Replace §8 with:

```
## 8. Task progress

S18 adds no task monitor. The host executes the reviewed apply and receives
one of two results, decided by the capabilities on its final confirmation
retry (S16 §8 item 4), and MUST continue by the result it actually got —
the handoff message (`handoffMessage()`, `mcp-apps/plan-facts.ts`) says so:

- **Native** (`io.modelcontextprotocol/tasks` declared): `resultType:
  "task"` with `taskId` (= the xiNAS `task_id`), `status` and
  `pollIntervalMs` (S16 §5.1). Follow with `tasks/get` until the status is
  terminal, then read the terminal `CallToolResult` (S16 §6.6): `completed`
  with `isError: true` is a failed or manual-recovery task, not a created
  array.
- **Fallback** (no extension): `resultType: "complete"` whose text carries
  `task_id` and `next: { tool: "tasks.wait", args: { id, timeout_s: 25 } }`
  (S16 §12.1). Follow the hint until `state` is terminal.

Both terminal outcomes report the control-path task only: the xiRAID
initialization the array starts afterwards is a separate operation, visible
through `arrays.get` or the `raid` / `raid/progress` feeds (S17 §8.2–§8.3),
never inferred from the task. The view itself does not consume the S17
feeds (`docs/TODO.md`).
```

§11: append

```
13. The handoff arguments are exactly `{ mode, plan_id, expected_revision, idempotency_key }`, and the same arguments reach one task under both result shapes (`__tests__/api/mcp/mcp-apps-handoff.test.ts`).
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(mcp-apps): the RAID Create handoff follows the native task handle or the tasks.wait fallback

S18 described only the task_id + tasks.wait result although S16 lets the
server answer resultType: task on the same apply (report S-03). The
handoff message now tells the host to continue by the result it actually
received, including that a completed task with isError is not a created
array; a composition test drives the exact handoff arguments through
MRTR into both shapes.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/mcp-apps/plan-facts.ts xiNAS-MCP/src/mcp-apps/raid-create.ts xiNAS-MCP/src/__tests__/mcp-apps/plan-facts.test.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-apps-handoff.test.ts docs/control-path/s18-mcp-raid-create-app-spec.md
```

---

## Task 8: Spare-pool membership is decided in the device-path domain (I-07)

**Files:**
- Create: `xiNAS-MCP/src/mcp-apps/inventory-facts.ts`
- Modify: `xiNAS-MCP/src/mcp-apps/raid-create.ts` (`poolDiskIds`/`unavailableReason`, lines 159–174; `diskCards`/`render` call sites)
- Test: new `xiNAS-MCP/src/__tests__/mcp-apps/inventory-facts.test.ts`
- Spec: S18 §5 (the "not a drive in an observed spare pool" bullet)

**Interfaces:**
- Produces: `pooledDevicePaths(pools: Array<{ drives?: string[] }>): Set<string>`; `isPooled(disk: { status?: { device_path?: string } }, pooled: Set<string>): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mcp-apps/inventory-facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPooled, pooledDevicePaths } from '../../mcp-apps/inventory-facts.js';

// S18 §5: pool `drives` are device paths (lib/parse/pool.ts); Disk ids are
// stable serial keys. Membership is decided in the path domain only (I-07).
describe('spare-pool membership (S18 §5)', () => {
  const pools = [{ name: 'spares', drives: ['/dev/nvme0n1'] }, { name: 'empty' }];

  it('excludes a disk whose device path is a pool drive even though its id differs', () => {
    const pooled = pooledDevicePaths(pools);
    expect(isPooled({ status: { device_path: '/dev/nvme0n1' } }, pooled)).toBe(true);
  });

  it('never matches a disk by id, and never blocks a disk with another path or no path', () => {
    const pooled = pooledDevicePaths([{ drives: ['serial-disk-1'] }]);
    expect(isPooled({ status: { device_path: '/dev/nvme1n1' } }, pooled)).toBe(false);
    expect(isPooled({ status: { device_path: '/dev/nvme2n1' } }, pooledDevicePaths(pools))).toBe(false);
    expect(isPooled({}, pooledDevicePaths(pools))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `env PATH=$N20 npm test -- src/__tests__/mcp-apps/inventory-facts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/mcp-apps/inventory-facts.ts`:

```ts
/**
 * Pure inventory rules for the S18 RAID Create View (spec §5, §10).
 *
 * DOM-free like plan-facts.ts so the unit suite can exercise them;
 * raid-create.ts owns the rendering.
 */

/** Pool `drives` are device paths (`lib/parse/pool.ts`), never Disk ids. */
export function pooledDevicePaths(pools: Array<{ drives?: string[] }>): Set<string> {
  return new Set(pools.flatMap((pool) => pool.drives ?? []));
}

/**
 * A disk is held by a spare pool when its device path is a pool drive. The
 * stable Disk id is a serial key and is never compared against pool drives —
 * doing so offered pooled disks as free (report I-07).
 */
export function isPooled(disk: { status?: { device_path?: string } }, pooled: Set<string>): boolean {
  const path = disk.status?.device_path;
  return path !== undefined && pooled.has(path);
}
```

In `raid-create.ts`: import `isPooled, pooledDevicePaths` from `'./inventory-facts.js'`;
delete `poolDiskIds()`; change `unavailableReason(disk: Disk)` to
`unavailableReason(disk: Disk, pooled: Set<string> = pooledDevicePaths(pools))` and its
pool line to `if (isPooled(disk, pooled)) return 'Assigned to a spare pool';`. In
`diskCards()` and `render()` compute `const pooled = pooledDevicePaths(pools);` once
and pass it (`unavailableReason(disk, pooled)`); `refreshInventory`'s selection
filter passes it too.

- [ ] **Step 4: Run, lint, format**

Run: `env PATH=$N20 npm test -- src/__tests__/mcp-apps/`
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 5: Update S18 §5**

Replace "- it is not a drive in an observed spare pool." with
"- its device path is not a drive of an observed spare pool (pool `drives`
are device paths, so membership is decided in the path domain; the stable
Disk `id` is never compared against them — `mcp-apps/inventory-facts.ts`)."

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(mcp-apps): exclude spare-pool drives by device path, not by Disk id

The view built a set of pool drives (device paths) and tested Disk ids
(serial keys) against it, so a pooled disk stayed selectable and a
selected disk survived the refresh that put it in a pool (report I-07).
Membership is now decided in the path domain by a DOM-free helper.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/mcp-apps/inventory-facts.ts xiNAS-MCP/src/mcp-apps/raid-create.ts xiNAS-MCP/src/__tests__/mcp-apps/inventory-facts.test.ts docs/control-path/s18-mcp-raid-create-app-spec.md
```

---

## Task 9: Inventory trust state — a failed or degraded refresh blocks plan and handoff (I-06)

**Files:**
- Modify: `xiNAS-MCP/src/mcp-apps/inventory-facts.ts` (add `classifyWarnings`, `InventoryTrust`)
- Modify: `xiNAS-MCP/src/mcp-apps/raid-create.ts` (state, `refreshInventory`, `validationErrors`, `render`, guards)
- Modify: `xiNAS-MCP/src/mcp-apps/raid-create.css` (one `.notice.error` rule if absent)
- Test: `xiNAS-MCP/src/__tests__/mcp-apps/inventory-facts.test.ts`
- Spec: S18 §5 (refresh paragraph), §10 (first bullet)

**Interfaces:**
- Produces: `classifyWarnings(warnings: Array<{ code?: string; message?: string }> | undefined): { blocking: Warning[]; advisory: Warning[] }` — `blocking` = codes starting `DEGRADED_`; `type InventoryTrust = 'none' | 'trusted' | 'degraded' | 'failed'`; `inventoryBanner(trust, detail)` string helper.

- [ ] **Step 1: Write the failing tests**

Append to `inventory-facts.test.ts`:

```ts
describe('inventory warnings (S18 §5, §10)', () => {
  it('treats DEGRADED_* warnings as blocking and everything else as advisory', () => {
    const { blocking, advisory } = classifyWarnings([
      { code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'xiRAID daemon down' },
      { code: 'EXECUTOR_DEGRADED', message: 'slow' },
      { message: 'no code' },
    ]);
    expect(blocking).toEqual([{ code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'xiRAID daemon down' }]);
    expect(advisory).toHaveLength(2);
    expect(classifyWarnings(undefined)).toEqual({ blocking: [], advisory: [] });
  });

  it('describes why the inventory is not current', () => {
    expect(inventoryBanner('failed', 'pools.list failed')).toBe(
      'Inventory is not current: pools.list failed. Showing the last known inventory; Review plan is disabled until a refresh succeeds.',
    );
    expect(inventoryBanner('degraded', 'DEGRADED_BACKEND_UNAVAILABLE — xiRAID daemon down')).toBe(
      'Inventory is not current: DEGRADED_BACKEND_UNAVAILABLE — xiRAID daemon down. Showing the last known inventory; Review plan is disabled until a refresh succeeds.',
    );
    expect(inventoryBanner('trusted', '')).toBe('');
    expect(inventoryBanner('none', '')).toBe('');
  });
});
```

- [ ] **Step 2: Run to see it fail**, then implement in `inventory-facts.ts`:

```ts
export interface InventoryWarning {
  code?: string;
  message?: string;
}

/** `DEGRADED_*` means a backend was absent and the rows are empty or stale — the form must not plan on them (§10). */
export const BLOCKING_WARNING_PREFIX = 'DEGRADED_';

export function classifyWarnings(warnings: InventoryWarning[] | undefined): {
  blocking: InventoryWarning[];
  advisory: InventoryWarning[];
} {
  const blocking: InventoryWarning[] = [];
  const advisory: InventoryWarning[] = [];
  for (const w of warnings ?? []) {
    if (typeof w.code === 'string' && w.code.startsWith(BLOCKING_WARNING_PREFIX)) blocking.push(w);
    else advisory.push(w);
  }
  return { blocking, advisory };
}

export type InventoryTrust = 'none' | 'trusted' | 'degraded' | 'failed';

export function inventoryBanner(trust: InventoryTrust, detail: string): string {
  if (trust !== 'failed' && trust !== 'degraded') return '';
  return `Inventory is not current: ${detail}. Showing the last known inventory; Review plan is disabled until a refresh succeeds.`;
}

export function warningText(w: InventoryWarning): string {
  return [w.code, w.message].filter((part) => part !== undefined && part.length > 0).join(' — ');
}
```

- [ ] **Step 3: Thread the trust state through the view**

In `raid-create.ts`:

- State: `let inventoryTrust: InventoryTrust = 'none'; let inventoryDetail = ''; let inventoryAdvisories: InventoryWarning[] = [];`
- `refreshInventory` success path: after the three payloads,
  ```ts
    const all = classifyWarnings([
      ...(diskPayload.warnings ?? []),
      ...(arrayPayload.warnings ?? []),
      ...(poolPayload.warnings ?? []),
    ]);
    inventoryAdvisories = all.advisory;
    if (all.blocking.length > 0) {
      inventoryTrust = 'degraded';
      inventoryDetail = all.blocking.map(warningText).join('; ');
      statusMessage = `Inventory refreshed with warnings · ${disks.length} disks observed`;
      statusKind = 'error';
    } else {
      inventoryTrust = 'trusted';
      inventoryDetail = '';
      statusMessage = `Inventory refreshed · ${disks.length} disks observed`;
      statusKind = 'success';
    }
  ```
  (keep the selection filter, `plan = null`, `planFingerprint = ''`, `handoffSent = false`).
- `catch`: `inventoryTrust = 'failed'; inventoryDetail = statusMessage-text; plan = null; planFingerprint = ''; handoffSent = false;` — the old `disks`/`arrays`/`pools`/`selected` stay for display.
- `validationErrors()`: first line after the config check:
  `if (inventoryTrust !== 'trusted') errors.push('Inventory is not current — refresh before planning.');`
- `requestPlan` and `requestSecureApply`: add `|| inventoryTrust !== 'trusted'` to their early-return guards.
- `planPanel()`: `const blocked = (plan.blockers?.length ?? 0) > 0 || inventoryTrust !== 'trusted';` and the handoff button `disabled` uses that `blocked`.
- `render()`: right after the `.step-line` div insert
  ```ts
    ${inventoryBanner(inventoryTrust, inventoryDetail) ? `<div class="notice error" id="inventory-banner" role="alert">${escapeHtml(inventoryBanner(inventoryTrust, inventoryDetail))}</div>` : ''}
    ${inventoryAdvisories.length > 0 ? `<div class="notice warning" id="inventory-advisories">${inventoryAdvisories.map((w) => escapeHtml(warningText(w))).join('<br />')}</div>` : ''}
  ```
  and add `data-inventory-trust="${inventoryTrust}"` to the `.app-shell` div.
- `raid-create.css`: if no `.notice.error` rule exists, add one next to `.notice.warning` (same layout, error colors as `.toast.error`).

- [ ] **Step 4: Run, typecheck, lint, format, build the bundle**

Run: `env PATH=$N20 npm test -- src/__tests__/mcp-apps/` → PASS.
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check && env PATH=$N20 npm run build:ui` → clean; `dist/mcp-apps/raid-create.html` rebuilt.

- [ ] **Step 5: Update S18 §5 and §10**

§5, replace "A refresh clears any selected disk that became ineligible and
invalidates the current plan." with:

```
A refresh clears any selected disk that became ineligible and invalidates
the current plan. A refresh that fails on any of the three calls, or that
succeeds with a `DEGRADED_*` warning on any of them, marks the inventory
**not current**: the previously displayed disks stay visible under a
banner that names the error or warning, the current plan is discarded,
and `Review plan` / `Request secure creation` stay disabled until a
refresh succeeds without a blocking warning. Other warnings are displayed
and do not block (`mcp-apps/inventory-facts.ts`).
```

§10 first bullet → "- Inventory failures and `DEGRADED_*` warnings leave the
form non-submittable, show the tool error or warning, and never present the
last known rows as current (§5)."

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(mcp-apps): a failed or degraded inventory refresh blocks planning and handoff

A failed pools.list only changed the status text: the old disks,
selection, plan and fingerprint stayed and both buttons came back after
the busy flag cleared; a DEGRADED_BACKEND_UNAVAILABLE warning was read
as a clean refresh (report I-06). The view now keeps an inventory trust
state: not-current data stays visible under a banner, the plan is
discarded, and Review plan / Request secure creation stay disabled until
a clean refresh; advisory warnings are shown, not swallowed.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/mcp-apps/inventory-facts.ts xiNAS-MCP/src/mcp-apps/raid-create.ts xiNAS-MCP/src/mcp-apps/raid-create.css xiNAS-MCP/src/__tests__/mcp-apps/inventory-facts.test.ts docs/control-path/s18-mcp-raid-create-app-spec.md
```

---

## Task 10: Typing works — focus survives re-render — and a real-browser regression suite (I-05, I-06, I-07)

**Files:**
- Modify: `xiNAS-MCP/src/mcp-apps/raid-create.ts` (`render()` focus capture/restore)
- Modify: `xiNAS-MCP/package.json`, `package-lock.json` (devDependency `playwright@1.63.0`; script `test:e2e:browsers`)
- Modify: `.github/workflows/ci.yml` (`typescript-e2e` job: browser cache + install)
- Create: `xiNAS-MCP/src/__tests__/e2e/raid-create-view.test.ts`
- Spec: S18 §9 (one bullet), §11 (AC 14)

- [ ] **Step 1: Add Playwright**

Run: `env PATH=$N20 npm install --save-dev --save-exact playwright@1.63.0 --no-audit --no-fund`
then `env PATH=$N20 npx playwright install chromium`. Add to `package.json` scripts:
`"test:e2e:browsers": "playwright install chromium"`.

- [ ] **Step 2: Write the failing browser test**

Create `src/__tests__/e2e/raid-create-view.test.ts`:

```ts
/**
 * S18 RAID Create view in a real Chromium (report I-05/I-06/I-07): keyboard
 * typing into the name field, paste and mid-string edits, Tab order,
 * keyboard disk selection, plan staleness, a failed refresh, a degraded
 * refresh and spare-pool exclusion by device path. The host is a fixture
 * page that speaks the MCP Apps bridge (`ui/initialize`, `tools/call`,
 * `ui/message`) over postMessage; no storage apply ever happens.
 *
 * Needs the Vite bundle (`npm run build`, or `npm run build:ui`) and a
 * Chromium from `npm run test:e2e:browsers`.
 */
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { type Browser, type FrameLocator, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { raidCreateAppConfig } from '../../api/routes/storage.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const BUNDLE = join(PROJECT_ROOT, 'dist/mcp-apps/raid-create.html');

const config = raidCreateAppConfig();
const disks = Array.from({ length: 6 }, (_, i) => ({
  id: `serial-disk-${i}`,
  status: {
    device_path: `/dev/nvme${i}n1`,
    serial: `serial-${i}`,
    capacity_bytes: 1e12,
    safe_for_use: true,
    mounted: false,
    system_disk: false,
  },
}));
const plan = {
  plan_id: '00000000-0000-4000-8000-000000000099',
  state_revision_expected: 0,
  risk_level: 'non_disruptive',
  rollback_model: 'non_disruptive',
  blockers: [],
  warnings: [],
  affected_resources: [{ kind: 'XiraidArray', id: 'data_01' }],
  diff: { action: 'create' },
};

/** The host fixture: answers the bridge; `window.fixture` flags drive failures. */
const hostPage = `<!doctype html><html><body>
<iframe id="view" src="/app" style="width:100%;height:100vh;border:0"></iframe>
<script>
const config = ${JSON.stringify(config)}, disks = ${JSON.stringify(disks)}, plan = ${JSON.stringify(plan)};
window.fixture = { calls: [], failTool: null, pooled: false, degraded: false, lastHandoff: null };
window.addEventListener('message', (e) => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0' || m.id === undefined) return;
  let result;
  if (m.method === 'ui/initialize') {
    result = { protocolVersion: '2026-01-26', hostInfo: { name: 'fixture-host', version: '1' },
      hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: 'light' } };
  } else if (m.method === 'tools/call') {
    window.fixture.calls.push(m.params);
    const name = m.params.name;
    if (window.fixture.failTool === name) {
      result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL', message: name + ' failed (fixture)' } }) }] };
    } else {
      const value = name === 'mcp_apps.raid_create' ? config : name === 'disks.list' ? disks : name === 'arrays.list' ? []
        : name === 'pools.list' ? (window.fixture.pooled ? [{ name: 'spares', drives: ['/dev/nvme0n1'], active: true }] : []) : plan;
      const warnings = window.fixture.degraded && name === 'disks.list' ? [{ code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'Inventory is stale (fixture)' }] : undefined;
      result = { content: [{ type: 'text', text: JSON.stringify({ result: value, ...(warnings ? { warnings } : {}) }) }] };
    }
  } else if (m.method === 'ui/message') { window.fixture.lastHandoff = m.params; result = {}; }
  else result = {};
  e.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
});
</script></body></html>`;

describe('RAID Create view in Chromium (S18 §6.1, §9, §10)', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let view: FrameLocator;
  let url: string;

  beforeAll(async () => {
    const bundle = readFileSync(BUNDLE);
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/app' ? bundle : hostPage);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(url);
    view = page.frameLocator('#view');
    await view.locator('#array-name').waitFor();
    await view.locator('[data-disk-id]').first().waitFor();
  });

  const fixture = (patch: Record<string, unknown>) =>
    page.evaluate((p) => Object.assign((window as unknown as { fixture: object }).fixture, p), patch);
  const calls = () =>
    page.evaluate(() => (window as unknown as { fixture: { calls: Array<{ name: string }> } }).fixture.calls);
  const focusedId = () =>
    view.locator('body').evaluate((body) => {
      const el = body.ownerDocument.activeElement as HTMLElement | null;
      return el?.id || (el as HTMLInputElement | null)?.dataset?.diskId || el?.tagName || null;
    });

  it('accepts character-by-character typing, keeps focus and caret, paste and mid-string edits (I-05)', async () => {
    await view.locator('#array-name').click();
    await page.keyboard.type('data_01', { delay: 20 });
    expect(await view.locator('#array-name').inputValue()).toBe('data_01');
    expect(await focusedId()).toBe('array-name');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('X');
    expect(await view.locator('#array-name').inputValue()).toBe('dataX_01');
    expect(await view.locator('#array-name').evaluate((el) => (el as HTMLInputElement).selectionStart)).toBe(5);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('pasted_name');
    expect(await view.locator('#array-name').inputValue()).toBe('pasted_name');
    expect(await focusedId()).toBe('array-name');
  });

  it('Tab and Shift+Tab move through the form; Space toggles a focused disk and keeps focus on it', async () => {
    await view.locator('#array-name').click();
    await page.keyboard.press('Tab');
    expect(await focusedId()).toBe('raid-level');
    await page.keyboard.press('Shift+Tab');
    expect(await focusedId()).toBe('array-name');
    await view.locator('[data-disk-id="serial-disk-1"]').focus();
    await page.keyboard.press('Space');
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isChecked()).toBe(true);
    expect(await focusedId()).toBe('serial-disk-1');
    await page.keyboard.press('Tab');
    expect(await focusedId()).toBe('serial-disk-2');
  });

  it('one plan request per click; a later edit marks the plan stale and disables the handoff', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await view.locator('#plan-button').click();
    await view.locator('#handoff-button').waitFor();
    expect((await calls()).filter((c) => c.name === 'arrays.create')).toHaveLength(1);
    expect(await view.locator('#handoff-button').isEnabled()).toBe(true);
    await view.locator('#array-name').click();
    await page.keyboard.type('x');
    expect(await view.locator('.plan-state').innerText()).toBe('STALE');
    expect(await view.locator('#handoff-button').isEnabled()).toBe(false);
  });

  it('a failed inventory call keeps the old rows visible but blocks plan and handoff until a clean refresh (I-06)', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await view.locator('#plan-button').click();
    await view.locator('#handoff-button').waitFor();
    await fixture({ failTool: 'pools.list' });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor();
    expect(await view.locator('#inventory-banner').innerText()).toContain('pools.list failed');
    expect(await view.locator('#plan-button').isEnabled()).toBe(false);
    expect(await view.locator('#handoff-button').count()).toBe(0);
    expect(await view.locator('[data-disk-id]').count()).toBe(6);
    await fixture({ failTool: null });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor({ state: 'detached' });
    expect(await view.locator('#plan-button').isEnabled()).toBe(true);
  });

  it('a DEGRADED_* warning is shown and blocks planning; an advisory warning does not (I-06)', async () => {
    await view.locator('#array-name').fill('data_01');
    for (let i = 0; i < 4; i++) await view.locator(`[data-disk-id="serial-disk-${i}"]`).check();
    await fixture({ degraded: true });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor();
    expect(await view.locator('#inventory-banner').innerText()).toContain('DEGRADED_BACKEND_UNAVAILABLE');
    expect(await view.locator('#plan-button').isEnabled()).toBe(false);
    await fixture({ degraded: false });
    await view.locator('#refresh-button').click();
    await view.locator('#inventory-banner').waitFor({ state: 'detached' });
    expect(await view.locator('#plan-button').isEnabled()).toBe(true);
  });

  it('a disk that joins a spare pool is deselected and disabled by device path; others stay selectable (I-07)', async () => {
    await view.locator('[data-disk-id="serial-disk-0"]').check();
    await view.locator('[data-disk-id="serial-disk-1"]').check();
    await fixture({ pooled: true });
    await view.locator('#refresh-button').click();
    await view.locator('[data-disk-id="serial-disk-0"]:disabled').waitFor();
    expect(await view.locator('[data-disk-id="serial-disk-0"]').isChecked()).toBe(false);
    expect(await view.locator('.disk-card:has([data-disk-id="serial-disk-0"]) .disk-reason').innerText()).toBe('Assigned to a spare pool');
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isEnabled()).toBe(true);
    expect(await view.locator('[data-disk-id="serial-disk-1"]').isChecked()).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see the typing test fail**

Run: `env PATH=$N20 npm run build:ui && env PATH=$N20 npm run test:e2e -- src/__tests__/e2e/raid-create-view.test.ts`
Expected: the typing test FAILS (value `d`, focus lost); the I-06/I-07 tests pass already if Tasks 8–9 landed.

- [ ] **Step 4: Preserve focus and selection across `render()`**

In `raid-create.ts` add above `render()`:

```ts
interface FocusState {
  selector: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  direction: 'forward' | 'backward' | 'none';
}

/** What the operator was doing before the DOM is replaced (S18 §6.1, §9). */
function captureFocus(): FocusState | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  let selector: string | null = null;
  if (active.id.length > 0) selector = `#${active.id}`;
  else if (active instanceof HTMLInputElement && active.dataset.diskId !== undefined) {
    selector = `input[data-disk-id="${active.dataset.diskId.replaceAll('"', '\\"')}"]`;
  }
  if (selector === null) return null;
  const text = active instanceof HTMLInputElement && active.type === 'text';
  return {
    selector,
    selectionStart: text ? active.selectionStart : null,
    selectionEnd: text ? active.selectionEnd : null,
    direction: text ? (active.selectionDirection ?? 'none') : 'none',
  };
}

function restoreFocus(state: FocusState | null): void {
  if (state === null) return;
  const el = root.querySelector<HTMLElement>(state.selector);
  if (el === null) return;
  el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement && state.selectionStart !== null && state.selectionEnd !== null) {
    el.setSelectionRange(state.selectionStart, state.selectionEnd, state.direction);
  }
}
```

In `render()`: capture at the top of the non-loading branch
(`const focus = captureFocus();`), and after `bindEvents();` call
`restoreFocus(focus);`. Make the name input explicit: `<input id="array-name" type="text" …>`.

- [ ] **Step 5: Rebuild and run the browser suite; then lint/format**

Run: `env PATH=$N20 npm run build:ui && env PATH=$N20 npm run test:e2e -- src/__tests__/e2e/raid-create-view.test.ts`
Expected: PASS (6 tests).
Run: `env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check`

- [ ] **Step 6: CI: install Chromium in the e2e job**

In `.github/workflows/ci.yml` `typescript-e2e`, after the `npm ci` step add:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('xiNAS-MCP/package-lock.json') }}
      - run: npx playwright install --with-deps chromium
        working-directory: xiNAS-MCP
```

and extend the job comment: "The RAID Create view suite drives the built
bundle in a real Chromium (report I-05: DOM-free tests cannot see a lost
focus), so the job installs the browser."

Run `yamllint -c .yamllint.yml .github/workflows/ci.yml` from the repo root (the
Python venv may be needed: `.venv/bin/yamllint`) → clean.

- [ ] **Step 7: Update S18 §9 and §11**

§9 add bullet: "- Re-rendering never steals the keyboard: the active control,
its caret and selection are restored after every DOM update, so
character-by-character typing, paste, mid-string edits, Tab order and
Space on a focused disk behave as in a static form."

§11 add: `14. In a real Chromium (`__tests__/e2e/raid-create-view.test.ts`): typing, paste and mid-string edits keep focus and caret; Tab/Shift+Tab and Space work; one plan request per click; an edit marks the plan stale; a failed or degraded refresh blocks planning; a pooled disk is deselected and disabled by device path.`

- [ ] **Step 8: Commit**

```bash
git add xiNAS-MCP/src/__tests__/e2e/raid-create-view.test.ts
git commit -m "fix(mcp-apps): keep focus and caret across re-renders; test the view in a real Chromium

Every input event re-rendered the whole view and dropped the active
element, so typing a name left one character and no focus (report I-05).
render() now restores the focused control, caret and selection. A
Playwright suite in the e2e job drives the built bundle: typing, paste,
mid-string edits, Tab order, keyboard disk selection, plan staleness,
failed and degraded refreshes, spare-pool exclusion by device path.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/src/mcp-apps/raid-create.ts xiNAS-MCP/src/__tests__/e2e/raid-create-view.test.ts xiNAS-MCP/package.json xiNAS-MCP/package-lock.json .github/workflows/ci.yml docs/control-path/s18-mcp-raid-create-app-spec.md
```

---

## Task 11: Record the verified runtime, the changelog and the memory

**Files:**
- Create: `xiNAS-MCP/.nvmrc` (content `20`)
- Modify: `CLAUDE.md` §Verification (one note under the TypeScript block)
- Modify: `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: `.nvmrc` and the CLAUDE.md note**

Add to CLAUDE.md after the `npm test` note bullet:

```
- **Run the TypeScript suite on Node 20** (`xiNAS-MCP/.nvmrc`; CI's
  major). `package.json` allows `>=20`, but better-sqlite3's worker threads
  crash under Node 24/25 on macOS (`RemoveEnvironmentCleanupHook`), which
  reads as random unit failures. The RAID Create browser suite in
  `test:e2e` needs `npm run test:e2e:browsers` once per machine.
```

- [ ] **Step 2: CHANGELOG `[Unreleased]`**

```
### Fixed

- **S17 event producers no longer turn missing data into state.** An
  unknown xiRAID array or member word neither completes nor fails an
  initialization/reconstruction (the operation stays active until a proven
  state settles it) and never reports an array restored `healthy` after a
  reboot (`degraded`, `running`, `unknown`, `unrecovered`, `unhealthy` are
  named); a `Filesystem` row without `effective_mount_options` keeps the
  last proven NFS backing state instead of clearing a read-only fault; an
  RDMA link reading `unknown` no longer counts as down; session
  connect/disconnect candidates are confirmed by the first complete
  snapshot after an api restart; `timeAccuracy: task` is set only with the
  task's terminal transition time.
- **MCP confirmation acknowledgement precedence.** A destructive record
  whose rollback is also unsupported requires `DATA MAY BE PERMANENTLY
  LOST` (it accepted `ROLLBACK IS NOT SUPPORTED` before); one table drives
  the service, the approval page, `xinasctl` and `api-v1.yaml`.
- **RAID Create App.** Typing into the array name keeps focus and caret; a
  failed or `DEGRADED_*` inventory refresh blocks planning and handoff and
  keeps the old rows visible as not current; spare-pool drives are excluded
  by device path; the handoff message tells the host to follow either the
  native task handle or the `tasks.wait` fallback. A Playwright/Chromium
  suite now runs in `test:e2e`.
- **Specs.** S15 §3.5 names the two MRTR trust models (form: host-mediated;
  url: server-verified distinct credential) instead of one guarantee; S17
  §8.2/§8.5 carry the tri-state rules; S18 §8 depends on S16.

Requires-Rebuild: xinas_node_build
```

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/.nvmrc
git commit -m "docs: record Node 20 as the verified TypeScript runtime; changelog for the S15–S18 remediation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- xiNAS-MCP/.nvmrc CLAUDE.md CHANGELOG.md
```

---

## Task 12: Full gates on one HEAD, then the PR

- [ ] **Step 1: TypeScript gates (from `xiNAS-MCP/`)**

```bash
env PATH=$N20 npm run typecheck && env PATH=$N20 npm run lint && env PATH=$N20 npm run format:check
env PATH=$N20 npm test -- --maxWorkers=2 --minWorkers=1
env PATH=$N20 npm run test:contracts
env PATH=$N20 npm run build && env PATH=$N20 npm run test:e2e
```

Expected: all PASS; record the counts.

- [ ] **Step 2: Repo gates (from the repo root)**

```bash
env PATH=$N20 npx --yes markdownlint-cli2 'docs/**/*.md'
env PATH=$N20 npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
yamllint -c .yamllint.yml .github/workflows/ci.yml
```

- [ ] **Step 3: Push and open the PR against `release/3.14`**

```bash
git push -u origin fix/s15-s18-validation-findings
gh pr create --base release/3.14 --title "fix: close the S15–S18 validation findings (I-01–I-07, S-01–S-03)" --body-file <body>
```

Body: the finding → commit table, the gate results, the `Requires-Rebuild:
xinas_node_build` restatement, and what stays open (hardware run,
product-client smoke rows, release-notes scope statement).
