# MCP Task Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a long-running apply (filesystem creation above all) observable from an MCP client: a rolled-up progress summary on every task read, a bounded long-poll endpoint to wait for the next change, and an explicit "call this next" hint in the MCP result.

**Architecture:** The agent already emits a progress event per stage transition; the api already persists it. Three additions close the gap: the agent reports how many executor stages exist (`stage_total`) so a denominator exists; the api rolls the stage rows up into a `progress` object inside a shared task renderer that REST *and* the SSE watch both call; and a new `GET /tasks/{id}/wait` long-polls the store so a client can block instead of spinning. The MCP dispatcher then advertises `tasks.wait` and attaches a `next` block to any result carrying a non-terminal `task_id`.

**Tech Stack:** TypeScript (Node ≥20, ESM), Express, better-sqlite3, vitest + supertest, biome (lint/format), `@modelcontextprotocol/sdk`.

**Spec:** [docs/superpowers/specs/2026-08-16-mcp-task-progress-design.md](../specs/2026-08-16-mcp-task-progress-design.md) (revision 2)

## Global Constraints

- Work on a branch: `feat/mcp-task-progress`. Never commit to `main` directly.
- **Spec-first (`CLAUDE.md`): the durable contract lands in Task 1, before any code.** Do not reorder.
- All repository artifacts (code comments, docs, commit messages) are in **English**.
- Every commit touching `xiNAS-MCP/src/` carries the trailer `Requires-Rebuild: xinas_node_build` (compiled `dist/` is not tracked in git; without it the change never reaches a host).
- Conventional Commits: `type(scope): subject`.
- All `docs/control-path/api-v1.yaml` changes must be **additive** — `oasdiff` fails the PR on a breaking change (removed/tightened field).
- Verification, run from `xiNAS-MCP/` before declaring any code task done:
  `npm run typecheck && npm run lint && npm run format:check` and `npm test`.
- Timestamps in the store are epoch-ms numbers; the HTTP boundary renders ISO strings. Do not mix the two.
- No fabricated percentages, and **no live stage output** — the runner buffers `emitOutput()` until a stage ends (`runner.ts:98`, `runner.ts:114`), so a running stage genuinely has none. Progress is stage plus elapsed time.

---

### Task 1: Contract and durable specs first

The repository's spec-first rule puts the owning spec ahead of the code. Everything below implements what this task writes down.

**Files:**

- Modify: `docs/control-path/api-v1.yaml`
- Modify: `docs/control-path/s2-task-envelope-spec.md`
- Modify: `docs/control-path/s8-clients-spec.md`
- Modify: `docs/TODO.md`

**Interfaces:**

- Consumes: nothing.
- Produces: the `TaskProgress` / `TaskWaitResult` schemas, `Task.stage_total`, `Task.progress`, `TaskProgressEvent.stage_total`, and the `/tasks/{id}/wait` path that Tasks 2–6 implement.

- [ ] **Step 1: Add the schemas to `api-v1.yaml`**

Under `components.schemas`, beside `TaskStage`:

```yaml
    TaskProgress:
      description: |
        Rolled-up view of where a running task is: which stage, how far
        through the executor's stage list, and how long it has been going.
        Present on any task that executes (absent on `plan_only`).

        No completion percentage is reported — `mkfs.xfs` and friends do not
        emit one, so stage plus elapsed time is the honest granularity. No
        output line is reported either: the agent buffers stage output and
        publishes it only when the stage ends, so a running stage has none
        (read finished stages' output from `stages[]`).
      type: object
      required: [phase, completed_stages, elapsed_s]
      properties:
        phase:
          type: string
          enum: [preparing, executing, rolling_back, finalizing, done]
        stage_name: { type: string }
        stage_status:
          type: string
          enum: [pending, running, success, failed, skipped]
        stage_index:
          type: integer
          description: Raw emission index; correlates with an entry in `stages[]`.
        stage_position:
          type: integer
          description: |
            1-based position among EXECUTOR stages. Absent while a synthetic
            stage (snapshot_before/snapshot_after/rollback) is current.
        stage_total:
          type: integer
          description: |
            Executor stage count reported by the agent on `accepted`. Absent
            for tasks created before the field existed — clients must render
            the position without a denominator in that case.
        completed_stages: { type: integer }
        elapsed_s:
          type: integer
          description: Wall-clock since the task was created; frozen at `terminal_at`.
        stage_elapsed_s: { type: integer }

    TaskWaitResult:
      type: object
      required: [changed, waited_s, task]
      properties:
        changed:
          type: boolean
          description: False when the call returned because the timeout expired.
        waited_s: { type: integer }
        task: { $ref: '#/components/schemas/Task' }
```

In the `Task` schema's `properties`, add:

```yaml
        stage_total: { type: [integer, "null"] }
        progress: { $ref: '#/components/schemas/TaskProgress' }
```

In `TaskProgressEvent.properties`, add:

```yaml
        stage_total:
          type: integer
          description: |
            Executor stage count; sent on the `accepted` event only. The api
            persists it on the task as the denominator for `progress`.
```

Add the path beside `/tasks/{id}/watch`:

```yaml
  /tasks/{id}/wait:
    parameters:
      - in: path
        name: id
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [tasks]
      operationId: waitTask
      summary: Block until the task changes, or the timeout expires.
      description: |
        Bounded long-poll for clients with no server-push channel — above all
        MCP, whose transport runs in JSON response mode. Returns as soon as the
        task's `last_event_sequence` passes `since_revision`, or the task is
        terminal, or `timeout_s` elapses.

        Concurrency is capped (4 waiters per task, 32 per process). Over the
        cap the call returns immediately with the current task and a
        `WAIT_CAPACITY` warning rather than queueing or failing.
      parameters:
        - name: timeout_s
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 60, default: 25 }
        - name: since_revision
          in: query
          required: false
          schema: { type: integer }
      responses:
        '200':
          description: The task, with its progress rollup.
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/Envelope'
                  - type: object
                    properties:
                      result: { $ref: '#/components/schemas/TaskWaitResult' }
        '404': { $ref: '#/components/responses/NotFound' }
```

Check the exact names of the shared `Envelope` and `NotFound` components in the file before writing them, and copy the surrounding paths' style — `/tasks/{id}/watch` is the closest model.

- [ ] **Step 2: Lint the contract**

```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

Expected: no errors. All five edits are additive, so `oasdiff` on the PR should also stay green.

- [ ] **Step 3: Update `s2-task-envelope-spec.md`**

- §6 (progress taxonomy): document `stage_total` on the `accepted` event, that the api persists it on the task, and that it counts executor stages only — the synthetic `snapshot_before` / `snapshot_after` / `rollback` rows are excluded, with the shared constants in `src/lib/tasks/stage-names.ts` named as the single definition.
- Add the `progress` rollup: the fields, the `phase` values, and the rule that `stage_position` / `completed_stages` count non-synthetic rows only.
- §10 (the SSE watch): record that the snapshot frame is now produced by the shared `renderTask`, and that this changes its shape — ISO timestamps instead of epoch-ms, `output_url` instead of `output_path`, plus the synthesized `metadata` object. State explicitly that this aligns the frame with the `Task` schema `api-v1.yaml` already documents, and that no in-repo consumer reads the stream.
- Add `/tasks/{id}/wait`: the `[1, 60]` validated timeout (400 outside the range, not clamped), the 250 ms poll interval, the `changed` / `waited_s` result fields, the per-task/global waiter caps with the `WAIT_CAPACITY` warning, and the fact that an MCP-side disconnect does not abort the inner loopback request — so the timeout, not the disconnect, is what frees the slot.

- [ ] **Step 4: Update `s8-clients-spec.md`**

- Add `tasks.wait` to the MCP tool surface.
- Document the catalog's `returns_async_task` flag: which entries carry it (every `plan_apply` entry, plus the `direct` entries `support.bundle` and `tasks.cancel`), and that the `next` hint and the "asynchronous" clause in `tools/list` are both generated from it — keying off `mutability` alone would miss `support.bundle`, which returns a 202 Task envelope from a `direct` tool.
- Document the `next` hint shape and why it exists: JSON response mode has no server-push channel, so a client must be told what to call.

- [ ] **Step 5: Record the deferred work**

Append to `docs/TODO.md`:

```markdown
- **No live stage output in task progress.** `ctx.emitOutput()` accumulates
  in the agent's runner and is drained only into the `stage_succeeded` /
  `stage_failed` event (`xiNAS-MCP/src/agent/task/runner.ts`), so a running
  stage's row carries no output and `TaskProgress` reports none. Done looks
  like: a `stage_output` progress event (a 9th value in the §6 taxonomy)
  carrying a drained chunk on an interval, an api-side append + spill rule,
  and a `last_output_line` field on `TaskProgress`. Cut from the 2026-08-16
  MCP progress design to keep that change to presentation only.
- **`xinasctl --wait` still polls `GET /tasks/{id}` itself.** `plan_apply_wait`
  predates `GET /tasks/{id}/wait` (2026-08-16 MCP progress design) and keeps its
  own poll loop, so its output does not use the `progress` rollup. Done looks
  like: `plan_apply_wait` calls `/wait` and renders `progress.stage_name` /
  `stage_position` / `stage_total`.
- **No completion percentage on task progress.** `TaskProgress` reports stage
  and elapsed time only, because `mkfs.xfs` emits no percentage. Done looks like:
  an executor that can honestly compute one (xiRAID initialization, via
  `init_progress`) reports it, and `TaskProgress` gains an optional `percent`.
```

- [ ] **Step 6: Lint the docs and commit**

```bash
npx --yes markdownlint-cli2 'docs/**/*.md'
```

Expected: 0 issues.

```bash
git add docs/control-path/api-v1.yaml docs/control-path/s2-task-envelope-spec.md docs/control-path/s8-clients-spec.md docs/TODO.md
git commit -m "docs(control-path): specify the task progress rollup and /tasks/{id}/wait"
```

---

### Task 2: Agent reports `stage_total` on `accepted`

The api cannot say "stage 2 of 5" because it never learns the stage count. The runner knows `executor.stages.length` before it starts. This task also lifts the synthetic stage names out of the runner into a shared module, because the api's rollup (Task 4) must recognize exactly the same names.

**Files:**

- Create: `xiNAS-MCP/src/lib/tasks/stage-names.ts`
- Modify: `xiNAS-MCP/src/agent/task/types.ts` (add `stage_total` to `TaskProgressEvent`)
- Modify: `xiNAS-MCP/src/agent/task/runner.ts` (line 58 local `ROLLBACK_STAGE`; the `accepted` emit at line ~151; the `snapshot_before` / `snapshot_after` literals)
- Test: `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts` (add a case)

**Interfaces:**

- Consumes: nothing.
- Produces: `SNAPSHOT_BEFORE_STAGE`, `SNAPSHOT_AFTER_STAGE`, `ROLLBACK_STAGE`, `SYNTHETIC_STAGE_NAMES: ReadonlySet<string>` from `src/lib/tasks/stage-names.ts`; `TaskProgressEvent.stage_total?: number`, set on the `accepted` event only.

- [ ] **Step 1: Write the failing test**

Add to `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts`, inside the existing `describe('TaskRunner.run — success path', …)`:

```typescript
  it('reports the executor stage count as stage_total on the accepted event', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['snap-before', 'snap-after']));

    await runner.run(
      { task_id: 't-total', operation_kind: 'reference.echo', spec: { message: 'hi' } },
      referenceExecutor,
      publish,
    );

    const accepted = events.find((e) => e.event_type === 'accepted');
    // referenceExecutor has three stages: preflight, apply, verify.
    expect(accepted?.stage_total).toBe(3);

    // stage_total counts EXECUTOR stages only — the synthetic
    // snapshot_before/snapshot_after rows are excluded, and no other
    // event repeats the field.
    const withTotal = events.filter((e) => e.stage_total !== undefined);
    expect(withTotal).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/runner.test.ts -t 'stage_total'`
Expected: FAIL — `stage_total` is not a property of `TaskProgressEvent` (typecheck error) or `accepted?.stage_total` is `undefined`.

- [ ] **Step 3: Create the shared stage-name module**

Create `xiNAS-MCP/src/lib/tasks/stage-names.ts`:

```typescript
/**
 * Synthetic stage names minted by the agent's TaskRunner.
 *
 * The runner wraps every executor's own stages with rows that no executor
 * declares: the xinas_history snapshots either side of the change, and the
 * rollback it runs on failure. The api's progress rollup must count only the
 * REAL executor stages against `stage_total`, so both sides read the names
 * from here — a second copy would drift the moment a name changes.
 */

export const SNAPSHOT_BEFORE_STAGE = 'snapshot_before';
export const SNAPSHOT_AFTER_STAGE = 'snapshot_after';
export const ROLLBACK_STAGE = 'rollback';

export const SYNTHETIC_STAGE_NAMES: ReadonlySet<string> = new Set([
  SNAPSHOT_BEFORE_STAGE,
  SNAPSHOT_AFTER_STAGE,
  ROLLBACK_STAGE,
]);
```

- [ ] **Step 4: Add the field to the event type**

In `xiNAS-MCP/src/agent/task/types.ts`, inside `interface TaskProgressEvent`, after `readonly stage_name?: string;`:

```typescript
  /**
   * Number of EXECUTOR stages this task will run (the denominator for
   * "stage 2 of 5"). Sent on the `accepted` event only; excludes the
   * runner's synthetic snapshot_before/snapshot_after/rollback rows.
   */
  readonly stage_total?: number;
```

- [ ] **Step 5: Emit it from the runner**

In `xiNAS-MCP/src/agent/task/runner.ts`:

Replace the local constant at line 58:

```typescript
const ROLLBACK_STAGE = 'rollback';
```

with an import at the top of the file (keep the import block's existing order):

```typescript
import {
  ROLLBACK_STAGE,
  SNAPSHOT_AFTER_STAGE,
  SNAPSHOT_BEFORE_STAGE,
} from '../../lib/tasks/stage-names.js';
```

Replace the `'snapshot_before'` string literal in the `stage_succeeded` emit with `SNAPSHOT_BEFORE_STAGE`, and `'snapshot_after'` with `SNAPSHOT_AFTER_STAGE`.

Change the `accepted` emit (currently `await emit('accepted');`) to:

```typescript
      // 1. accepted (seq 1). Carries the executor's stage count so the api can
      //    render "stage N of M" — nothing else on the wire knows M.
      await emit('accepted', { stage_total: executor.stages.length });
```

- [ ] **Step 6: Run the tests**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/runner.test.ts`
Expected: PASS (the new case plus every pre-existing runner case — the taxonomy shape assertions must be unaffected).

- [ ] **Step 7: Verify and commit**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check
```

```bash
git add xiNAS-MCP/src/lib/tasks/stage-names.ts xiNAS-MCP/src/agent/task/types.ts xiNAS-MCP/src/agent/task/runner.ts xiNAS-MCP/src/__tests__/agent/task/runner.test.ts
git commit -m "feat(agent): report executor stage_total on the accepted progress event

Requires-Rebuild: xinas_node_build"
```

---

### Task 3: The api persists `stage_total`

**Files:**

- Create: `xiNAS-MCP/src/state/migrations/005-task-stage-total.sql`
- Modify: `xiNAS-MCP/src/api/tasks/types.ts` (`Task`)
- Modify: `xiNAS-MCP/src/api/tasks/store.ts` (`TaskRow`, `TaskPatch`, both `UPDATE tasks SET …` statements in `transition` and `transitionIf`, `rowToTask`)
- Modify: `xiNAS-MCP/src/api/tasks/progress.ts` (`TaskProgressBody`, `ProgressEvent`, `parseEvent`, the `accepted` branch of `applyEvent`)
- Test: `xiNAS-MCP/src/__tests__/api/tasks/stage-total.test.ts` (create)

**Interfaces:**

- Consumes: `TaskProgressEvent.stage_total` from Task 2.
- Produces: `Task.stage_total?: number`, readable from `store.get(id)` and therefore from `renderTask`.

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/tasks/stage-total.test.ts`:

```typescript
/**
 * `stage_total` travels agent → api → durable task row (2026-08-16 progress
 * design §1). Drives applyEvent directly — no HTTP, no DB.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyEvent } from '../../../api/tasks/progress.js';
import type { Task } from '../../../api/tasks/types.js';

function makeStore() {
  return { transition: vi.fn(), upsertStage: vi.fn() };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-abc',
    kind: 'fs.create',
    state: 'queued',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    input_hash: 'abc',
    risk_level: 'changing_access',
    affected_resources: [],
    last_event_sequence: 0,
    created_at: 1000,
    updated_at: 1000,
    stages: [],
    ...overrides,
  };
}

const deps = (store: ReturnType<typeof makeStore>, task: Task, event: unknown) =>
  ({
    store,
    task,
    event,
    spillDir: '/tmp/does-not-matter',
    heartbeat: vi.fn(),
    releaseLeases: vi.fn(),
    revertDesired: vi.fn(),
    captureDesired: vi.fn(),
  }) as unknown as Parameters<typeof applyEvent>[0];

describe('applyEvent — accepted carries stage_total', () => {
  it('persists stage_total alongside the queued→running transition', () => {
    const store = makeStore();
    const task = makeTask();

    applyEvent(
      deps(store, task, {
        task_id: task.task_id,
        sequence: 1,
        event_type: 'accepted',
        stage_total: 5,
      }),
    );

    expect(store.transition).toHaveBeenCalledWith(task.task_id, {
      last_event_sequence: 1,
      state: 'running',
      stage_total: 5,
    });
  });

  it('omits stage_total when the agent did not send one (older agent)', () => {
    const store = makeStore();
    const task = makeTask();

    applyEvent(deps(store, task, { task_id: task.task_id, sequence: 1, event_type: 'accepted' }));

    expect(store.transition).toHaveBeenCalledWith(task.task_id, {
      last_event_sequence: 1,
      state: 'running',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/stage-total.test.ts`
Expected: FAIL — `transition` is called without `stage_total` in the first case.

- [ ] **Step 3: Add the migration**

Create `xiNAS-MCP/src/state/migrations/005-task-stage-total.sql`:

```sql
-- 005: the number of executor stages a task will run.
--
-- The agent sends it on the `accepted` progress event (it is the only party
-- that knows the executor's stage list); the api renders "stage N of M" from
-- it. NULL for every task created before this migration and for any task whose
-- agent predates the field — consumers must treat the denominator as optional.
ALTER TABLE tasks ADD COLUMN stage_total INTEGER;
```

Note: `runMigrations` (`src/state/migrations.ts`) picks up any `^\d{3,}-.*\.sql$` file in numeric order — no registration step.

- [ ] **Step 4: Thread the column through the store**

In `xiNAS-MCP/src/api/tasks/types.ts`, add to `interface Task` after `last_event_sequence: number;`:

```typescript
  /** Executor stage count reported on `accepted`; absent on pre-005 rows. */
  stage_total?: number;
```

In `xiNAS-MCP/src/api/tasks/store.ts`:

1. `interface TaskPatch` — add `stage_total?: number;`
2. `interface TaskRow` — add `stage_total: number | null;`
3. In **both** `UPDATE tasks SET …` statements (`transition` and `transitionIf`), add the assignment right after `last_event_sequence = @last_event_sequence,`:

```sql
            stage_total = @stage_total,
```

and add the parameter to both `.run({ … })` objects, next to `last_event_sequence`:

```typescript
        stage_total: merged.stage_total ?? null,
```

1. In `rowToTask`, add to the spread block:

```typescript
    ...(row.stage_total !== null ? { stage_total: row.stage_total } : {}),
```

`INSERT_TASK_SQL` is deliberately untouched: at insert time no agent has accepted the task, so the column stays NULL until the `accepted` event.

- [ ] **Step 5: Accept the field on the wire**

In `xiNAS-MCP/src/api/tasks/progress.ts`:

1. `interface TaskProgressBody` — add `stage_total?: unknown;`
2. `interface ProgressEvent` — add `stage_total?: number;`
3. In `parseEvent`, next to the `stage_index` guard:

```typescript
  if (typeof body.stage_total === 'number' && Number.isInteger(body.stage_total)) {
    event.stage_total = body.stage_total;
  }
```

1. In the `accepted` branch of `applyEvent`, widen the patch:

```typescript
    case 'accepted': {
      // queued → running (only when still queued; never demote a later state).
      const patch: {
        last_event_sequence: number;
        state?: TaskState;
        stage_total?: number;
      } = { last_event_sequence: seq };
      if (task.state === 'queued') patch.state = 'running';
      // The agent's stage count — the denominator the rollup renders. An
      // agent that predates the field simply omits it.
      if (event.stage_total !== undefined) patch.stage_total = event.stage_total;
      store.transition(taskId, patch);
      deps.heartbeat();
      return;
    }
```

- [ ] **Step 6: Run the tests**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/ src/__tests__/api/internal-task-progress.test.ts`
Expected: PASS — the new file plus the existing progress-receiver suites.

- [ ] **Step 7: Verify and commit**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check
```

```bash
git add xiNAS-MCP/src/state/migrations/005-task-stage-total.sql xiNAS-MCP/src/api/tasks/ xiNAS-MCP/src/__tests__/api/tasks/stage-total.test.ts
git commit -m "feat(api): persist the task stage_total reported on accepted

Requires-Rebuild: xinas_node_build"
```

---

### Task 4: The progress rollup, and one renderer for REST and SSE

`renderTask` currently lives inside `src/api/routes/tasks.ts` as a module-private function, and the SSE watch does **not** call it — `watchTask()` hand-rolls its snapshot frame from the raw store `Task` (`src/api/routes/tasks.ts:245`). This task moves the renderer into `src/api/tasks/render.ts` (Task 5 needs it from a second route file, and importing it back would create a cycle), adds the rollup, and puts the SSE snapshot on the same renderer so the "one renderer, every consumer" claim is actually true.

**Files:**

- Create: `xiNAS-MCP/src/api/tasks/render.ts` (moved `renderTask` + new `taskProgress`)
- Modify: `xiNAS-MCP/src/api/routes/tasks.ts` (delete the local `renderTask`, import it; replace the manual projection inside `watchTask`)
- Test: `xiNAS-MCP/src/__tests__/api/tasks/progress-rollup.test.ts` (create)
- Test: `xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts` (add an SSE assertion)
- Test: `xiNAS-MCP/src/__tests__/e2e/task-engine-roundtrip.test.ts` (add an end-to-end assertion)

**Interfaces:**

- Consumes: `Task.stage_total` (Task 3); `SYNTHETIC_STAGE_NAMES`, `ROLLBACK_STAGE`, `SNAPSHOT_AFTER_STAGE` (Task 2).
- Produces:
  - `renderTask(task: Task): Record<string, unknown>` — exported from `src/api/tasks/render.ts` (ISO timestamps, `output_url`, synthesized `metadata`, `spec`/`plan_binding`/`desired_rollback` stripped, plus `progress`).
  - `taskProgress(task: Task, now?: number): TaskProgressSummary | undefined`
  - `interface TaskProgressSummary { phase: 'preparing' | 'executing' | 'rolling_back' | 'finalizing' | 'done'; stage_name?: string; stage_status?: string; stage_index?: number; stage_position?: number; stage_total?: number; completed_stages: number; elapsed_s: number; stage_elapsed_s?: number }`

- [ ] **Step 1: Write the failing rollup test**

Create `xiNAS-MCP/src/__tests__/api/tasks/progress-rollup.test.ts`:

```typescript
/**
 * The task progress rollup (2026-08-16 progress design §3). Pure unit test —
 * builds Task fixtures and asserts the summary, no DB and no HTTP.
 */

import { describe, expect, it } from 'vitest';
import { taskProgress } from '../../../api/tasks/render.js';
import type { Task, TaskStage } from '../../../api/tasks/types.js';

const T0 = 1_700_000_000_000; // task created_at
const NOW = T0 + 96_000; // 96 s later

function stage(over: Partial<TaskStage> & { stage_index: number; name: string }): TaskStage {
  return { status: 'success', output_size_bytes: 0, ...over } as TaskStage;
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    task_id: 't1',
    kind: 'fs.create',
    state: 'running',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    input_hash: 'abc',
    risk_level: 'changing_access',
    affected_resources: [],
    last_event_sequence: 4,
    created_at: T0,
    updated_at: NOW,
    stages: [],
    ...over,
  };
}

describe('taskProgress', () => {
  it('reports the running executor stage against stage_total', () => {
    const task = makeTask({
      stage_total: 5,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 55_000 }),
        stage({ stage_index: 2, name: 'mkfs', status: 'running', started_at: T0 + 55_000 }),
      ],
    });

    expect(taskProgress(task, NOW)).toEqual({
      phase: 'executing',
      stage_name: 'mkfs',
      stage_status: 'running',
      stage_index: 2,
      stage_position: 2,
      stage_total: 5,
      completed_stages: 1,
      elapsed_s: 96,
      stage_elapsed_s: 41,
    });
  });

  it('omits the denominator for a task that predates stage_total', () => {
    const task = makeTask({
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', status: 'running', started_at: T0 + 1_000 }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.stage_total).toBeUndefined();
    expect(p?.stage_position).toBe(1);
  });

  it('reports phase=preparing before the first executor stage starts', () => {
    const queued = makeTask({ state: 'queued', stages: [] });
    expect(taskProgress(queued, NOW)).toEqual({
      phase: 'preparing',
      completed_stages: 0,
      elapsed_s: 96,
    });
  });

  it('reports phase=rolling_back while the rollback stage runs, without counting it', () => {
    const task = makeTask({
      stage_total: 5,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 5_000 }),
        stage({
          stage_index: 2,
          name: 'mkfs',
          status: 'failed',
          started_at: T0 + 5_000,
          ended_at: T0 + 90_000,
        }),
        stage({ stage_index: 3, name: 'rollback', status: 'running', started_at: T0 + 90_000 }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.phase).toBe('rolling_back');
    expect(p?.stage_name).toBe('rollback');
    expect(p?.stage_position).toBeUndefined(); // synthetic rows have no position
    expect(p?.completed_stages).toBe(1);
  });

  it('reports phase=done and total elapsed for a terminal task', () => {
    const task = makeTask({
      state: 'success',
      stage_total: 5,
      terminal_at: T0 + 120_000,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 5_000 }),
        stage({ stage_index: 2, name: 'mkfs', started_at: T0 + 5_000, ended_at: T0 + 100_000 }),
        stage({
          stage_index: 3,
          name: 'install_unit',
          started_at: T0 + 100_000,
          ended_at: T0 + 101_000,
        }),
        stage({ stage_index: 4, name: 'mount', started_at: T0 + 101_000, ended_at: T0 + 102_000 }),
        stage({ stage_index: 5, name: 'verify', started_at: T0 + 102_000, ended_at: T0 + 103_000 }),
        stage({
          stage_index: 6,
          name: 'snapshot_after',
          started_at: T0 + 119_000,
          ended_at: T0 + 120_000,
        }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.phase).toBe('done');
    expect(p?.completed_stages).toBe(5);
    expect(p?.elapsed_s).toBe(120); // terminal_at − created_at, not now
  });

  it('has no progress at all for a plan_only task', () => {
    expect(taskProgress(makeTask({ state: 'plan_only', stages: [] }), NOW)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/progress-rollup.test.ts`
Expected: FAIL — `src/api/tasks/render.ts` does not exist.

- [ ] **Step 3: Create `render.ts` with the moved renderer and the rollup**

Create `xiNAS-MCP/src/api/tasks/render.ts`. Move the whole existing `renderTask` function (and its doc comment) verbatim out of `src/api/routes/tasks.ts`, add `export`, and add the rollup below it:

```typescript
import {
  ROLLBACK_STAGE,
  SNAPSHOT_AFTER_STAGE,
  SYNTHETIC_STAGE_NAMES,
} from '../../lib/tasks/stage-names.js';
import type { Task, TaskStage } from './types.js';

/** Rolled-up, human-facing view of where a running task is (progress design §3). */
export interface TaskProgressSummary {
  phase: 'preparing' | 'executing' | 'rolling_back' | 'finalizing' | 'done';
  stage_name?: string;
  stage_status?: string;
  /** Raw emission index — correlates the summary with an entry in `stages[]`. */
  stage_index?: number;
  /** 1-based position among EXECUTOR stages; absent for synthetic rows. */
  stage_position?: number;
  stage_total?: number;
  completed_stages: number;
  elapsed_s: number;
  stage_elapsed_s?: number;
}

const isSynthetic = (s: TaskStage): boolean => SYNTHETIC_STAGE_NAMES.has(s.name);

/**
 * Roll a task's stage rows up into "which stage, how far in, how long".
 *
 * Returns undefined for a `plan_only` task (nothing executes). Counting is done
 * over EXECUTOR stages only — the runner's synthetic snapshot_before /
 * snapshot_after / rollback rows carry emission indices too, so deriving a
 * position from `stage_index` arithmetic would read one too high.
 *
 * No output line is reported: the runner buffers `emitOutput()` and drains it
 * only into the stage's terminal event, so a RUNNING stage's row has none
 * (see docs/TODO.md — intra-stage output is a separate change).
 */
export function taskProgress(
  task: Task,
  now: number = Date.now(),
): TaskProgressSummary | undefined {
  if (task.state === 'plan_only') return undefined;

  const real = task.stages.filter((s) => !isSynthetic(s));
  const completed = real.filter((s) => s.status === 'success').length;
  const terminal = task.terminal_at !== undefined;
  const elapsed_s = Math.round(((task.terminal_at ?? now) - task.created_at) / 1000);

  const base: TaskProgressSummary = {
    phase: terminal ? 'done' : 'preparing',
    completed_stages: completed,
    elapsed_s,
    ...(task.stage_total !== undefined ? { stage_total: task.stage_total } : {}),
  };

  // Current stage: the one still running, else the highest-index row.
  const running = task.stages.find((s) => s.status === 'running');
  const latest = [...task.stages].sort((a, b) => a.stage_index - b.stage_index).at(-1);
  const current = running ?? latest;
  if (current === undefined) return base;

  const phase: TaskProgressSummary['phase'] = terminal
    ? 'done'
    : current.name === ROLLBACK_STAGE
      ? 'rolling_back'
      : current.name === SNAPSHOT_AFTER_STAGE
        ? 'finalizing'
        : isSynthetic(current)
          ? 'preparing'
          : 'executing';

  // 1-based position among executor stages; synthetic rows have none.
  const position = isSynthetic(current)
    ? undefined
    : real.findIndex((s) => s.stage_index === current.stage_index) + 1;

  return {
    ...base,
    phase,
    stage_name: current.name,
    stage_status: current.status,
    stage_index: current.stage_index,
    ...(position !== undefined && position > 0 ? { stage_position: position } : {}),
    ...(current.started_at !== undefined
      ? { stage_elapsed_s: Math.round(((current.ended_at ?? now) - current.started_at) / 1000) }
      : {}),
  };
}
```

Then, inside the moved `renderTask`, attach the rollup just before the `delete out.spec;` block:

```typescript
  const progress = taskProgress(task);
  if (progress !== undefined) out.progress = progress;
```

- [ ] **Step 4: Point both the routes and the SSE snapshot at it**

In `xiNAS-MCP/src/api/routes/tasks.ts`, delete the local `renderTask` definition and import it:

```typescript
import { renderTask } from '../tasks/render.js';
```

Then replace the hand-rolled snapshot inside `watchTask` — this is the whole point of the move, not a cleanup:

```typescript
    const snapshot: Record<string, unknown> = { ...task };
    delete snapshot.spec;
    delete snapshot.plan_binding;
    delete snapshot.desired_rollback;
    res.write(formatFrame(task.last_event_sequence, snapshot));
```

with:

```typescript
    // ONE renderer for REST and SSE: the frame is the same public Task shape
    // GET /tasks/{id} returns — ISO timestamps, `output_url`, `metadata`, the
    // `progress` rollup, and the three internal-only columns stripped. Before
    // this it was a hand-copied raw store row, which is how the rollup would
    // otherwise have been missing from the stream.
    res.write(formatFrame(task.last_event_sequence, renderTask(task)));
```

The remaining call sites (`GET /tasks`, `GET /tasks/{id}`, the cancel route) keep calling `renderTask` unchanged.

- [ ] **Step 5: Assert the SSE frame carries the rollup**

In `xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts`, extend the existing snapshot-frame test (the one that asserts `spec` / `plan_binding` / `desired_rollback` are stripped) with:

```typescript
    // The snapshot frame goes through the shared renderer, so it carries the
    // progress rollup and ISO timestamps — not the raw store row.
    expect(snapshot.progress?.phase).toBeDefined();
    expect(typeof snapshot.created_at).toBe('string');
    expect(snapshot.metadata).toBeDefined();
```

Use the file's existing frame-parsing helper (`parseFrames`) and its variable names; do not add a second harness.

- [ ] **Step 6: Prove the rollup advances end-to-end**

In `xiNAS-MCP/src/__tests__/e2e/task-engine-roundtrip.test.ts`, which already drives a full plan → apply → execute → terminal round-trip, add an assertion after the task reaches its terminal state:

```typescript
    // The rollup lands on the durable task the same way the stages do.
    const finished = await request(setup.app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(finished.body.result.progress.phase).toBe('done');
    expect(finished.body.result.progress.completed_stages).toBe(finished.body.result.stage_total);
```

Adapt `setup`, `taskId`, and the auth constant to the names the file already uses.

- [ ] **Step 7: Run the tests**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/ src/__tests__/api/routes-tasks.test.ts src/__tests__/api/tasks-watch.test.ts src/__tests__/e2e/task-engine-roundtrip.test.ts`
Expected: PASS. The watch suite is the regression guard for the renderer swap.

- [ ] **Step 8: Verify and commit**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check
```

```bash
git add xiNAS-MCP/src/api/tasks/render.ts xiNAS-MCP/src/api/routes/tasks.ts xiNAS-MCP/src/__tests__/api/tasks/progress-rollup.test.ts xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts xiNAS-MCP/src/__tests__/e2e/task-engine-roundtrip.test.ts
git commit -m "feat(api): roll task stages up into a progress summary on REST and SSE

Requires-Rebuild: xinas_node_build"
```

---

### Task 5: `GET /tasks/{id}/wait`

**Files:**

- Create: `xiNAS-MCP/src/api/routes/task-wait.ts`
- Modify: `xiNAS-MCP/src/api/tasks/store.ts` (add `revisionOf`)
- Modify: `xiNAS-MCP/src/api/routes/tasks.ts` (mount the route)
- Test: `xiNAS-MCP/src/__tests__/api/tasks/task-wait.test.ts` (create)

**Interfaces:**

- Consumes: `renderTask` from `src/api/tasks/render.ts` (Task 4).
- Produces:
  - `TaskStore.revisionOf(taskId: string): { state: TaskState; last_event_sequence: number } | null` — the cheap poll probe.
  - `waitForTask(ctx: ApiContext, req: Request, res: Response, id: string): Promise<void>`; response body `result: { changed: boolean; waited_s: number; task: <rendered Task> }`, with a `WAIT_CAPACITY` envelope warning when the caps are hit.

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/tasks/task-wait.test.ts`. It needs an **engine-wired** app (the default `buildTestApp()` has no task engine); mirror the builder in `src/__tests__/api/tasks-watch.test.ts`:

```typescript
/**
 * GET /tasks/{id}/wait — bounded long-poll (2026-08-16 progress design §4).
 */

import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, type TestSetup } from '../_helpers.js';
import { createApp } from '../../../api/app.js';
import type { ApiContext } from '../../../api/context.js';
import { buildTaskEngines } from '../../../api/tasks/build.js';

const AGENT_TOKEN = 'agent-tok-wait';

interface WaitSetup extends TestSetup {
  cleanup(): Promise<void>;
  seedTask(): string;
  emit(taskId: string, body: Record<string, unknown>): Promise<unknown>;
}

async function buildApp(): Promise<WaitSetup> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };
  const tasks = buildTaskEngines({ state: setup.state });
  const ctx: ApiContext = {
    config: setup.config,
    state: setup.state,
    tasks,
    taskProgressSpillDir: join(setup.dir, 'task-logs'),
  };
  return {
    ...setup,
    app: createApp(ctx),
    ctx,
    seedTask() {
      return tasks.store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'mcp',
        request_id: 'req-1',
        correlation_id: 'corr-1',
        input_hash: 'deadbeef',
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
      }).task_id;
    },
    emit(taskId, body) {
      return request(this.app)
        .post('/internal/v1/task_progress')
        .set('Authorization', `Bearer ${AGENT_TOKEN}`)
        .send({ task_id: taskId, observed_at: new Date().toISOString(), ...body });
    },
    async cleanup() {
      await setup.cleanup();
    },
  } as WaitSetup;
}

describe('GET /tasks/{id}/wait', () => {
  let setup: WaitSetup;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('404s on an unknown task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/wait')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('returns immediately when the task already moved past since_revision', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=0&timeout_s=5`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.changed).toBe(true);
    expect(res.body.result.task.state).toBe('running');
    expect(res.body.result.task.progress.stage_total).toBe(3);
  });

  it('wakes on a progress event that lands mid-wait', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    const pending = request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=10`)
      .set('Authorization', ADMIN_TOKEN);

    setTimeout(() => {
      void setup.emit(id, {
        sequence: 2,
        event_type: 'stage_started',
        stage_index: 1,
        stage_name: 'apply',
        status: 'running',
      });
    }, 300);

    const res = await pending;
    expect(res.body.result.changed).toBe(true);
    expect(res.body.result.task.progress.stage_name).toBe('apply');
  });

  it('returns changed:false at the timeout when nothing happened', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=1`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.changed).toBe(false);
    expect(res.body.result.waited_s).toBeGreaterThanOrEqual(1);
  });

  it('rejects a timeout_s outside [1, 60]', async () => {
    const id = setup.seedTask();
    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?timeout_s=600`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('over the per-task cap, returns immediately with a WAIT_CAPACITY warning', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    // Four waiters occupy the per-task cap; the fifth must not queue.
    const held = Array.from({ length: 4 }, () =>
      request(setup.app)
        .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=2`)
        .set('Authorization', ADMIN_TOKEN),
    );
    await new Promise((r) => setTimeout(r, 200));

    const overflow = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=2`)
      .set('Authorization', ADMIN_TOKEN);

    expect(overflow.status).toBe(200);
    expect(overflow.body.result.changed).toBe(false);
    expect(overflow.body.result.waited_s).toBe(0);
    expect(overflow.body.warnings.map((w: { code: string }) => w.code)).toContain('WAIT_CAPACITY');

    await Promise.all(held);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/task-wait.test.ts`
Expected: FAIL — 404 from the catch-all for every case (the route does not exist).

- [ ] **Step 3: Add the cheap poll probe to the store**

In `xiNAS-MCP/src/api/tasks/store.ts`, add a prepared statement beside `getTaskStmt` (declare the field with the others, assign it in the constructor next to `this.getTaskStmt = …`):

```typescript
  private readonly revisionStmt: Statement;
```

```typescript
    this.revisionStmt = this.db.prepare(
      'SELECT state, last_event_sequence FROM tasks WHERE task_id = ?',
    );
```

and the method beside `get`:

```typescript
  /**
   * Cheap liveness probe for the long-poll (`/tasks/{id}/wait`): the two
   * columns a waiter actually branches on, without the stage-row fetch and
   * JSON parsing `get()` does. A waiter runs this four times a second; it must
   * stay a single-row read.
   */
  revisionOf(taskId: string): { state: TaskState; last_event_sequence: number } | null {
    const row = this.revisionStmt.get(taskId) as
      | { state: string; last_event_sequence: number }
      | undefined;
    if (!row) return null;
    return { state: row.state as TaskState, last_event_sequence: row.last_event_sequence };
  }
```

- [ ] **Step 4: Implement the handler**

Create `xiNAS-MCP/src/api/routes/task-wait.ts`:

```typescript
/**
 * `GET /tasks/{id}/wait` — bounded long-poll for the next task change
 * (2026-08-16 MCP progress design §4).
 *
 * A client over MCP has no server-push channel (the /mcp transport runs in JSON
 * response mode), so "show me progress" has to be a request it can repeat
 * without spinning. This holds the request until the task's
 * `last_event_sequence` passes `since_revision`, the task reaches a terminal
 * state, or `timeout_s` elapses — whichever comes first — and answers with the
 * same rendered Task that `GET /tasks/{id}` returns, progress rollup included.
 *
 * Cost control, because a waiter is a HELD request:
 *   - the loop probes `store.revisionOf()` (one row, no stages), not `get()`;
 *   - concurrency is capped per task and per process — over the cap the call
 *     answers immediately with a WAIT_CAPACITY warning instead of queueing,
 *     degrading to exactly the plain read the client would have done;
 *   - `timeout_s <= 60` bounds how long one waiter holds its slot.
 *
 * On a direct REST call, `res.on('close')` ends the loop when the client hangs
 * up. It does NOT fire for a call arriving through the MCP loopback: that is a
 * real http.request against the api's own listener (server.ts), and nothing
 * aborts it when the outer MCP client disconnects. An abandoned MCP wait
 * therefore holds its slot until the timeout — which is why the caps exist.
 *
 * It polls rather than subscribing to TaskWatch: that class is typed against
 * the Express Response and writes SSE frames. Generalizing it into an emitter
 * is a bigger change than this endpoint justifies.
 */

import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import type { Warning } from '../envelope.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import { renderTask } from '../tasks/render.js';
import { TERMINAL_STATES } from '../tasks/types.js';
import { requireTasks } from './apply-helpers.js';

const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_S = 25;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 60;
const MAX_WAITERS_PER_TASK = 4;
const MAX_WAITERS_TOTAL = 32;

/** Live waiter counts. A waiter cannot outlive its request (finally decrements). */
const waitersByTask = new Map<string, number>();
let waitersTotal = 0;

function parseIntQuery(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param '${name}' must be a single value`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param '${name}' must be an integer, got '${raw}'`,
    );
  }
  return n;
}

export async function waitForTask(
  ctx: ApiContext,
  req: Request,
  res: Response,
  id: string,
): Promise<void> {
  const tasks = requireTasks(ctx);

  const timeout_s = parseIntQuery(req.query.timeout_s, 'timeout_s') ?? DEFAULT_TIMEOUT_S;
  if (timeout_s < MIN_TIMEOUT_S || timeout_s > MAX_TIMEOUT_S) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param 'timeout_s' must be in [${MIN_TIMEOUT_S}, ${MAX_TIMEOUT_S}], got ${timeout_s}`,
    );
  }
  const since = parseIntQuery(req.query.since_revision, 'since_revision') ?? -1;

  const first = tasks.store.get(id);
  if (!first) throw new ApiException('NOT_FOUND', `task ${id} not found`);

  const atCap = (waitersByTask.get(id) ?? 0) >= MAX_WAITERS_PER_TASK || waitersTotal >= MAX_WAITERS_TOTAL;
  if (atCap) {
    const warning: Warning = {
      code: 'WAIT_CAPACITY',
      message: `too many concurrent waiters (max ${MAX_WAITERS_PER_TASK} per task, ${MAX_WAITERS_TOTAL} total) — returned without waiting`,
      details: { task_id: id },
    };
    sendOk(
      req,
      res,
      { changed: false, waited_s: 0, task: renderTask(first) },
      [first.last_event_sequence],
      [warning],
    );
    return;
  }

  waitersByTask.set(id, (waitersByTask.get(id) ?? 0) + 1);
  waitersTotal += 1;

  const startedAt = Date.now();
  const deadline = startedAt + timeout_s * 1000;
  // A direct REST client that hangs up must not leave the loop reading the db.
  let aborted = false;
  const onClose = (): void => {
    aborted = true;
  };
  res.on('close', onClose);

  try {
    let probe = tasks.store.revisionOf(id) ?? {
      state: first.state,
      last_event_sequence: first.last_event_sequence,
    };
    let changed = probe.last_event_sequence > since || TERMINAL_STATES.has(probe.state);
    while (!changed && !aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const next = tasks.store.revisionOf(id);
      if (!next) break; // vanished mid-wait: answer with what we have
      probe = next;
      changed = probe.last_event_sequence > since || TERMINAL_STATES.has(probe.state);
    }
    if (aborted) return;

    const task = tasks.store.get(id) ?? first;
    sendOk(
      req,
      res,
      {
        changed,
        waited_s: Math.round((Date.now() - startedAt) / 1000),
        task: renderTask(task),
      },
      [task.last_event_sequence],
    );
  } finally {
    res.off('close', onClose);
    waitersTotal -= 1;
    const n = (waitersByTask.get(id) ?? 1) - 1;
    if (n <= 0) waitersByTask.delete(id);
    else waitersByTask.set(id, n);
  }
}
```

- [ ] **Step 5: Mount it**

In `xiNAS-MCP/src/api/routes/tasks.ts`, add the import and the route beside the existing watch route:

```typescript
import { waitForTask } from './task-wait.js';
```

```typescript
  r.get('/tasks/:id/wait', (req, res, next) => {
    waitForTask(ctx, req, res, req.params.id as string).catch(next);
  });
```

- [ ] **Step 6: Run the tests**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/tasks/task-wait.test.ts src/__tests__/api/routes-tasks.test.ts src/__tests__/api/rbac.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check
```

```bash
git add xiNAS-MCP/src/api/routes/task-wait.ts xiNAS-MCP/src/api/routes/tasks.ts xiNAS-MCP/src/api/tasks/store.ts xiNAS-MCP/src/__tests__/api/tasks/task-wait.test.ts
git commit -m "feat(api): add GET /tasks/{id}/wait bounded long-poll with waiter caps

Requires-Rebuild: xinas_node_build"
```

---

### Task 6: The MCP surface — `tasks.wait`, `returns_async_task`, and the `next` hint

**Files:**

- Modify: `xiNAS-MCP/src/api/mcp/catalog.ts` (`CatalogEntry`, the `planApply()` helper, `tasks.cancel`, `support.bundle`, plus the new `tasks.wait` entry)
- Modify: `xiNAS-MCP/src/api/mcp/dispatch.ts` (`ListToolsRequestSchema` handler, the success return of `CallToolRequestSchema`)
- Test: `xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts` (add cases)
- Test: `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts` (add a flag-coverage case)

**Interfaces:**

- Consumes: `GET /tasks/{id}/wait` (Task 5).
- Produces: `CatalogEntry.returns_async_task?: boolean`; MCP tool `tasks.wait`; the `next` block on tool results.

- [ ] **Step 1: Write the failing tests**

Add to `xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts` (reuse the file's existing harness for driving one `tools/call` against a stubbed loopback — check its signature before writing these; do not add a second harness):

```typescript
  it('attaches a next hint pointing at tasks.wait for a running task', async () => {
    const result = await callTool(
      'filesystems.create',
      { mode: 'apply' },
      { status: 202, body: { result: { task_id: 'task-42', state: 'running', kind: 'fs.create' } } },
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.next).toEqual({
      tool: 'tasks.wait',
      args: { id: 'task-42', timeout_s: 25 },
      note: expect.stringContaining('until state is terminal'),
    });
  });

  it('attaches the hint for support.bundle too — a direct tool that starts a task', async () => {
    const result = await callTool(
      'support.bundle',
      {},
      { status: 202, body: { result: { task_id: 'task-77', state: 'queued' } } },
    );
    expect(JSON.parse(result.content[0].text).next?.args.id).toBe('task-77');
  });

  it('omits the next hint for a task that is already terminal', async () => {
    const result = await callTool(
      'filesystems.create',
      { mode: 'apply' },
      { status: 202, body: { result: { task_id: 'task-42', state: 'success', kind: 'fs.create' } } },
    );
    expect(JSON.parse(result.content[0].text).next).toBeUndefined();
  });

  it('omits the next hint for a plain read', async () => {
    const result = await callTool(
      'tasks.get',
      { id: 'task-42' },
      { status: 200, body: { result: { task_id: 'task-42', state: 'running' } } },
    );
    expect(JSON.parse(result.content[0].text).next).toBeUndefined();
  });
```

Add to `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts`:

```typescript
  it('every entry that returns a Task envelope is flagged returns_async_task', () => {
    const byName = new Map(CATALOG.map((e) => [e.name, e]));
    for (const e of CATALOG.filter((x) => x.mutability === 'plan_apply')) {
      expect(e.returns_async_task, `${e.name} must be flagged`).toBe(true);
    }
    // The two direct entries whose 202 carries a Task envelope.
    expect(byName.get('support.bundle')?.returns_async_task).toBe(true);
    expect(byName.get('tasks.cancel')?.returns_async_task).toBe(true);
    // A plain read must not be flagged.
    expect(byName.get('tasks.get')?.returns_async_task).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/mcp-dispatch.test.ts src/__tests__/api/mcp-catalog.test.ts`
Expected: FAIL — `payload.next` is `undefined`, and `returns_async_task` is not a property of `CatalogEntry`.

- [ ] **Step 3: Add the flag and the new entry to the catalog**

In `xiNAS-MCP/src/api/mcp/catalog.ts`, add to `interface CatalogEntry`:

```typescript
  /**
   * The success response is a Task envelope (`task_id` + `state`) — the work
   * runs asynchronously. Drives the MCP `next` hint and the "asynchronous"
   * clause in tools/list. Explicit rather than inferred from `mutability`:
   * `support.bundle` is a DIRECT tool that returns 202 + a Task.
   */
  returns_async_task?: boolean;
```

In the `planApply()` helper's returned object, add `returns_async_task: true,` (before the `...over` spread, so an entry can still override it).

On the `tasks.cancel` and `support.bundle` entries, add `returns_async_task: true,`.

Directly after the `tasks.get` entry, add:

```typescript
  read(
    'tasks.wait',
    'GET',
    '/tasks/{id}/wait',
    'Block until a task changes or the timeout expires; returns the task with its progress summary. Call repeatedly to follow a long operation.',
    {
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'task id' },
          timeout_s: {
            type: 'integer',
            description: 'how long to block, 1–60 seconds (default 25)',
          },
          since_revision: {
            type: 'integer',
            description:
              'the last_event_sequence already seen; the call returns as soon as the task moves past it',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ),
```

`buildRequest` already turns non-path args of a `GET` entry into query parameters, so the dispatcher needs no change for this tool. The catalog is also what drives REST RBAC, so this entry is what makes `/tasks/{id}/wait` a viewer-level route.

- [ ] **Step 4: Add the `next` hint and the async clause**

In `xiNAS-MCP/src/api/mcp/dispatch.ts`, add above `buildMcpServer`:

```typescript
/** Task states from which more progress is still expected. */
const LIVE_TASK_STATES: ReadonlySet<string> = new Set(['queued', 'running']);

/**
 * The "what do I call next" pointer for a call that started a task.
 *
 * The /mcp transport runs in JSON response mode — there is no server-push
 * stream, so a client cannot be *told* about progress; it has to ask. Attaching
 * the exact follow-up call to the result is what turns a bare task_id into
 * something a client will actually follow. Gated on the catalog's
 * `returns_async_task` flag, NOT on `mutability`: support.bundle is a direct
 * tool that returns a Task envelope.
 */
function nextHint(entry: CatalogEntry, result: unknown): Record<string, unknown> | undefined {
  if (entry.returns_async_task !== true) return undefined;
  const task = result as { task_id?: unknown; state?: unknown } | null;
  if (typeof task?.task_id !== 'string') return undefined;
  if (typeof task.state !== 'string' || !LIVE_TASK_STATES.has(task.state)) return undefined;
  return {
    tool: 'tasks.wait',
    args: { id: task.task_id, timeout_s: 25 },
    note: 'long-running operation — call this repeatedly until state is terminal (success, failed, cancelled, requires_manual_recovery)',
  };
}
```

In the `ListToolsRequestSchema` handler, extend the description mapping:

```typescript
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CATALOG.filter((e) => e.binary !== true).map((e) => {
      const async =
        e.returns_async_task === true
          ? ' Returns a task_id and executes asynchronously — follow it with tasks.wait.'
          : '';
      return {
        name: e.name,
        description:
          (e.status === 'degraded' ? `${e.description} [DEGRADED backend]` : e.description) + async,
        inputSchema: e.input_schema as { type: 'object'; [k: string]: unknown },
      };
    }),
  }));
```

And in the success return of the call handler:

```typescript
    const next = nextHint(entry, envelope.result);
    return text({
      result: envelope.result,
      ...(envelope.warnings !== undefined && envelope.warnings.length > 0
        ? { warnings: envelope.warnings }
        : {}),
      ...(next !== undefined ? { next } : {}),
    });
```

- [ ] **Step 5: Run the tests**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/mcp-dispatch.test.ts src/__tests__/api/mcp-catalog.test.ts src/__tests__/api/mcp-integration.test.ts`
Expected: PASS. `mcp-catalog.test.ts` also enforces that every `{param}` in a path appears in the tool's `input_schema.properties` and that same-route entries agree on `min_role` — the new entry satisfies both.

- [ ] **Step 6: Verify and commit**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check
```

```bash
git add xiNAS-MCP/src/api/mcp/catalog.ts xiNAS-MCP/src/api/mcp/dispatch.ts xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts
git commit -m "feat(mcp): expose tasks.wait and point async-task results at it

Requires-Rebuild: xinas_node_build"
```

---

### Task 7: Final sweep

**Files:** none created; corrections only, wherever the sweep finds drift.

- [ ] **Step 1: Re-read the contract against the code**

Open `docs/control-path/api-v1.yaml` beside `src/api/tasks/render.ts` and `src/api/routes/task-wait.ts`. Every field in `TaskProgress` and `TaskWaitResult` must exist in the code with the same name and type, and vice versa. Fix whichever side drifted (the spec wins on intent; the code wins on what actually ships — if they disagree on a name, change the code).

- [ ] **Step 2: Run the full gate**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:contracts
```

```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
npx --yes markdownlint-cli2 'docs/**/*.md'
```

Expected: all green. `openapi-compat` (oasdiff) and `secrets` (gitleaks) have no local equivalent — expect them to run on the PR.

- [ ] **Step 3: Commit any corrections**

```bash
git commit -am "fix(control-path): reconcile the task progress contract with the implementation

Requires-Rebuild: xinas_node_build"
```

(Skip if the sweep found nothing.)

---

## Done means

- `filesystems.create mode=apply` over MCP returns a `task_id` **and** a `next` block naming `tasks.wait`; so does `support.bundle`.
- `tasks.wait` blocks up to 25 s and comes back with `progress.stage_name` (`preflight` → `mkfs` → `install_unit` → `mount` → `verify`), `stage_position` of `stage_total`, and elapsed seconds.
- The same `progress` object appears on `GET /tasks/{id}`, on `GET /tasks`, and in the SSE watch snapshot — one renderer, every consumer, asserted by a test on each surface.
- Every command in Task 7's gate passes.
