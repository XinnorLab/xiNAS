import { type Request, type Response, Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { getOrNull, listByPrefix, sendOk, unwrapValues } from '../handlers/reads.js';
import { requireTasks } from './apply-helpers.js';
import type { TaskListFilter } from '../tasks/store.js';
import type { Task, TaskState } from '../tasks/types.js';
import { formatFrame } from '../tasks/watch.js';

/**
 * Per api-v1.yaml QueryLimit: integer, default 100, min 1, max 1000.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return 100;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param 'limit' must be a single value`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param 'limit' must be an integer, got '${raw}'`,
    );
  }
  if (n < 1 || n > 1000) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param 'limit' must be in [1, 1000], got ${n}`,
    );
  }
  return n;
}

function parseStringQuery(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param '${name}' must be a single value`);
  }
  return raw;
}

/**
 * Project a store `Task` (epoch-ms timestamps, `output_path`) into the public
 * api-v1.yaml shape: ISO date-time strings, `output_url` for spilled stage
 * output, and the synthesized `metadata` object (s2-task-envelope-spec §10 —
 * the S0/S1 `embedMetadata` fold-in). Tasks live in the SQLite `tasks` table,
 * not as RevisionedValue rows, so there is no KV row tracking to read; the
 * metadata is synthesized from Task fields per §10:
 *   revision        ← last_event_sequence (or 1 — a fresh task has no events)
 *   created_at      ← ISO of created_at
 *   modified_at     ← ISO of updated_at
 *   owner           ← principal
 *   source          ← client_type
 *   validation_status ← 'valid'
 */
function renderTask(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...task,
    created_at: new Date(task.created_at).toISOString(),
    updated_at: new Date(task.updated_at).toISOString(),
    stages: task.stages.map((s) => {
      const stage: Record<string, unknown> = {
        ...s,
        ...(s.started_at !== undefined ? { started_at: new Date(s.started_at).toISOString() } : {}),
        ...(s.ended_at !== undefined ? { ended_at: new Date(s.ended_at).toISOString() } : {}),
      };
      // api-v1.yaml renders the relative spill path as `output_url`.
      if (s.output_path !== undefined) {
        stage.output_url = s.output_path;
        delete (stage as { output_path?: unknown }).output_path;
      }
      return stage;
    }),
    metadata: {
      revision: task.last_event_sequence > 0 ? task.last_event_sequence : 1,
      created_at: new Date(task.created_at).toISOString(),
      modified_at: new Date(task.updated_at).toISOString(),
      owner: task.principal,
      source: task.client_type,
      validation_status: 'valid',
    },
  };
  if (task.terminal_at !== undefined) {
    out.terminal_at = new Date(task.terminal_at).toISOString();
  }
  if (task.cancel_requested_at !== undefined) {
    out.cancel_requested_at = new Date(task.cancel_requested_at).toISOString();
  }
  // `spec`, `plan_binding`, and `desired_rollback` are internal-only columns —
  // none is part of the public Task surface in api-v1.yaml.
  //   - `spec` (migration 003): the raw requester-submitted executor INPUT
  //     (s2-task-envelope-spec §3.1).
  //   - `plan_binding` / `desired_rollback` (S3 N0): the plan's observed-freshness
  //     ref and the prior-value undo set (s3-nfs-executor-spec §5.4).
  // Strip all three so a read endpoint never echoes the operation input, the
  // requester's raw desired payload, or every mutated KV key back over the wire.
  // The SSE watch snapshot strips the same three (see watchTask).
  delete out.spec;
  delete out.plan_binding;
  delete out.desired_rollback;
  return out;
}

export function tasksRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/tasks', (req, res) => {
    const stateFilter = parseStringQuery(req.query.state, 'state');
    const kindFilter = parseStringQuery(req.query.kind, 'kind');
    const limit = parseLimit(req.query.limit);

    // Source of truth is the S2 SQLite `tasks` table when the engine is wired
    // (ctx.tasks present). Read-only contexts (no engine) keep the S0/S1 KV
    // path so /tasks still answers — the integration + routes-tasks suites that
    // seed via state.kv depend on this fallback.
    if (ctx.tasks) {
      const filter: TaskListFilter = {};
      if (stateFilter !== undefined) filter.state = stateFilter as TaskState;
      if (kindFilter !== undefined) filter.kind = kindFilter;
      let tasks = ctx.tasks.store.list(filter);
      if (tasks.length > limit) tasks = tasks.slice(0, limit);
      const values = tasks.map(renderTask);
      sendOk(
        req,
        res,
        values,
        tasks.map((t) => t.last_event_sequence),
      );
      return;
    }

    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/tasks/');
    let values = unwrapValues(rows);
    if (stateFilter !== undefined) {
      values = values.filter((v) => (v as { state?: string }).state === stateFilter);
    }
    if (kindFilter !== undefined) {
      values = values.filter((v) => (v as { kind?: string }).kind === kindFilter);
    }
    if (values.length > limit) values = values.slice(0, limit);
    sendOk(
      req,
      res,
      values,
      rows.map((x) => x.revision),
    );
  });

  r.get('/tasks/:id', (req, res) => {
    if (ctx.tasks) {
      const task = ctx.tasks.store.get(req.params.id);
      if (!task) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
      sendOk(req, res, renderTask(task), [task.last_event_sequence]);
      return;
    }
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  // S10 (ADR-0012, s2 spec §16.1): real cancel. The engine owns the state
  // branching; this route maps args + stamps the audit operation_id so
  // /audit?task_id= finds the cancel row.
  r.post('/tasks/:id/cancel', async (req, res, next) => {
    try {
      const tasks = requireTasks(ctx);
      const task = await tasks.taskEngine.cancel({
        taskId: req.params.id as string,
        agentClient: ctx.tasks?.agentClient,
        trackerOffline: ctx.tracker ? ctx.tracker.currentState() === 'offline' : true,
      });
      const rc = req.context;
      if (rc) rc.operation_id = task.task_id;
      sendOk(req, res, renderTask(task), [task.last_event_sequence]);
    } catch (err) {
      next(err);
    }
  });

  r.get('/tasks/:id/watch', (req, res) => watchTask(ctx, req, res, req.params.id));

  return r;
}

/**
 * Resumable SSE watch (s2-task-envelope-spec §10).
 *
 * Engine-backed (ctx.tasks present):
 *   1. 404 when the task is unknown.
 *   2. Set the SSE response headers and DO NOT end the response — the stream
 *      stays open until the client disconnects.
 *   3. No `Last-Event-ID` → first frame is the current Task snapshot, keyed at
 *      the task's current `last_event_sequence`.
 *   4. `Last-Event-ID: <sequence>` → RESYNC. The durable record is the rolled-up
 *      `task_stages` rows (no per-event sequence), so the catch-up is the current
 *      Task snapshot (which already carries every stage's latest state), again
 *      keyed at `last_event_sequence`. A client behind the current sequence gets
 *      that snapshot; one already current attaches live with no re-send. The SSE
 *      `id` is the event `sequence` for BOTH this frame and the live frames
 *      (TaskWatch.notify keys on `sequence`) — a single, coherent id space.
 *   5. subscribe(res) for live events, and unsubscribe on `res.on('close')`.
 *
 * Read-only context (no engine): fall back to the S0/S1 single-shot behavior —
 * read the KV task row, emit one `event: snapshot` frame, and END. This keeps
 * the watch responsive (and supertest-friendly) in contexts that never run the
 * task engine; nothing live can arrive there because nothing writes progress.
 */
function watchTask(ctx: ApiContext, req: Request, res: Response, id: string): void {
  // --- Read-only fallback: single-shot snapshot from KV, then close. ---
  if (!ctx.tasks) {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${id} not found`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write('event: snapshot\n');
    res.write(`data: ${JSON.stringify(row.value)}\n\n`);
    res.end();
    return;
  }

  const watch = ctx.taskWatch;
  const task = ctx.tasks.store.get(id);
  if (!task) throw new ApiException('NOT_FOUND', `task ${id} not found`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Flush the headers so the client's response callback fires before any
  // replay/live frame races in (some agents/clients buffer otherwise).
  res.flushHeaders?.();

  const lastEventId = readLastEventId(req);

  // Resync model. The durable record is the ROLLED-UP `task_stages` rows (no
  // per-event sequence column), so a precise "replay events past sequence N"
  // is not reconstructable from it. Instead, the catch-up IS the current Task
  // snapshot — which already carries every stage's latest state — keyed at the
  // task's current `last_event_sequence`. That keeps the SSE id space a SINGLE
  // space (the event sequence) for both this frame and the live frames that
  // follow (TaskWatch.notify also keys on `sequence`). A reconnecting client
  // sends the last sequence it saw as `Last-Event-ID`: behind the current
  // sequence → it gets a fresh snapshot to catch up; already current → it
  // attaches live with no re-send. Reading the task and subscribing happen
  // synchronously below, so no live event can slip through the gap.
  if (lastEventId === undefined || lastEventId < task.last_event_sequence) {
    // Strip the internal-only columns (`spec` raw executor input, `plan_binding`,
    // `desired_rollback`) before the snapshot crosses the wire — none is part of
    // the public Task surface on REST or SSE (mirrors renderTask). The rest of the
    // raw store shape is kept as-is for the frame.
    const snapshot: Record<string, unknown> = { ...task };
    delete snapshot.spec;
    delete snapshot.plan_binding;
    delete snapshot.desired_rollback;
    res.write(formatFrame(task.last_event_sequence, snapshot));
  }

  // Attach to the live stream. If no TaskWatch is wired (should not happen once
  // server.ts builds one, but the field is optional), there is nothing to
  // subscribe to — keep the connection open so the snapshot/replay still lands.
  if (watch) {
    const unsubscribe = watch.subscribe(id, res);
    res.on('close', unsubscribe);
  }
}

/** Parse the resume cursor from `Last-Event-ID:` header or `?last_event_id=`. */
function readLastEventId(req: Request): number | undefined {
  const header = req.header('Last-Event-ID');
  const query = req.query.last_event_id;
  const raw = header ?? (typeof query === 'string' ? query : undefined);
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw) return undefined;
  return n;
}
