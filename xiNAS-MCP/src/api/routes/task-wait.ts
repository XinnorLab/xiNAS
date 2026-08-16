/**
 * `GET /tasks/{id}/wait` — bounded long-poll for the next task change
 * (s2-task-envelope-spec §10.2).
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

  const atCap =
    (waitersByTask.get(id) ?? 0) >= MAX_WAITERS_PER_TASK || waitersTotal >= MAX_WAITERS_TOTAL;
  if (atCap) {
    const warning: Warning = {
      code: 'WAIT_CAPACITY',
      message:
        `too many concurrent waiters (max ${MAX_WAITERS_PER_TASK} per task, ` +
        `${MAX_WAITERS_TOTAL} total) — returned without waiting`,
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
