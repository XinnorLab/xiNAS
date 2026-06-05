import type { Response } from 'express';

/**
 * T8 — in-memory SSE fan-out for `/tasks/{id}/watch` (s2-task-envelope-spec §10).
 *
 * A single per-process registry of live SSE responses keyed by task_id. The T5
 * progress receiver (`tasks/progress.ts`) calls `notify(task_id, event)` after
 * it applies each `POST /internal/v1/task_progress` event; this writes the event
 * as an SSE frame to every subscriber of that task. With no subscribers, notify
 * is a cheap no-op (the common case — most tasks are not being watched).
 *
 * Scope is deliberately small: this is *live* fan-out only. Reconnect catch-up
 * (the `Last-Event-ID` path) is served by the route as a RESYNC — it re-sends the
 * current Task snapshot (which already carries every stage's latest state) keyed
 * at the task's `last_event_sequence`, NOT from this in-memory buffer. Nothing is
 * retained here once a subscriber drops, so a process restart loses no
 * client-visible history (the durable `tasks`/`task_stages` rows are the source
 * of truth).
 *
 * SSE framing: `id: <sequence>\ndata: <json>\n\n`. The `id` is the event
 * `sequence` for BOTH live frames here and the route's resync snapshot frame, so
 * the id space is a single, coherent event-sequence space: a reconnecting client
 * sends the last `sequence` it saw as `Last-Event-ID` and the route resyncs it if
 * that is behind the task's current `last_event_sequence`.
 */
export class TaskWatch {
  /** task_id → set of live Express responses streaming that task. */
  private readonly subscribers = new Map<string, Set<Response>>();

  /**
   * Register `res` as a live SSE subscriber of `taskId`. Returns an idempotent
   * unsubscribe fn; the route also wires `res.on('close', unsubscribe)` so a
   * client disconnect cleans up without the route polling. Empty task buckets
   * are pruned so the map does not grow unbounded.
   */
  subscribe(taskId: string, res: Response): () => void {
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set<Response>();
      this.subscribers.set(taskId, set);
    }
    set.add(res);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscribers.get(taskId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) this.subscribers.delete(taskId);
    };
  }

  /**
   * Fan an applied progress `event` out to every live subscriber of `taskId` as
   * an SSE frame. The frame `id` is the event's `sequence` when present (so a
   * client's `Last-Event-ID` tracks the live high-water mark); otherwise the
   * `id` line is omitted. No subscribers → no-op. A write to a half-dead socket
   * is swallowed so one stale client can never break the fan-out for the rest.
   */
  notify(taskId: string, event: unknown): void {
    const set = this.subscribers.get(taskId);
    if (!set || set.size === 0) return;

    const seq = (event as { sequence?: unknown }).sequence;
    const frame = formatFrame(typeof seq === 'number' ? seq : undefined, event);
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        // Writing to a closed/errored response throws; the matching
        // res.on('close') unsubscribe will prune it. Ignore here.
      }
    }
  }

  /** Live subscriber count for a task (0 when none) — used by tests. */
  subscriberCount(taskId: string): number {
    return this.subscribers.get(taskId)?.size ?? 0;
  }
}

/** Render one SSE frame: `id: <id>\n` (when given) + `data: <json>\n\n`. */
export function formatFrame(id: number | undefined, payload: unknown): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}data: ${JSON.stringify(payload)}\n\n`;
}
