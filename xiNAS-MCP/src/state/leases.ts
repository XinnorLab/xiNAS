import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';

export interface AcquireParams {
  resource_kind: string;
  resource_id: string;
  task_id: string;
  ttl_seconds: number;
}

export type AcquireResult =
  | { ok: true; lease_id: string }
  | { ok: false; reason: 'held_by_other'; holder_task_id: string };

export interface SweepResult {
  leases_removed: number;
  tasks_recovered: number;
}

export class LeaseManager {
  private readonly db: Database;
  private readonly insertStmt: Statement;
  private readonly findHolderStmt: Statement;
  private readonly heartbeatStmt: Statement;
  private readonly heartbeatByTaskStmt: Statement;
  private readonly releaseStmt: Statement;
  private readonly releaseByTaskStmt: Statement;
  private readonly findExpiredHoldersStmt: Statement;
  private readonly recoverTaskStmt: Statement;
  private readonly deleteExpiredStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO leases (lease_id, resource_kind, resource_id, task_id, acquired_at, ttl_seconds, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findHolderStmt = db.prepare(
      'SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?',
    );
    this.heartbeatStmt = db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?');
    this.heartbeatByTaskStmt = db.prepare('UPDATE leases SET heartbeat_at = ? WHERE task_id = ?');
    this.releaseStmt = db.prepare('DELETE FROM leases WHERE lease_id = ?');
    this.releaseByTaskStmt = db.prepare('DELETE FROM leases WHERE task_id = ?');
    this.findExpiredHoldersStmt = db.prepare(
      `SELECT l.task_id
         FROM leases l
         JOIN tasks t ON t.task_id = l.task_id
        WHERE l.heartbeat_at + (l.ttl_seconds * 1000) < ?
          AND t.state IN ('queued', 'running')`,
    );
    this.recoverTaskStmt = db.prepare(
      `UPDATE tasks
          SET state = 'requires_manual_recovery',
              error_code = 'FAILED_STATE_DESYNC',
              error_message = COALESCE(error_message, 'lease expired during execution; in-flight state unknown'),
              remediation_hint = COALESCE(remediation_hint, 'inspect system state for the affected resource; manual recovery required'),
              updated_at = ?,
              terminal_at = COALESCE(terminal_at, ?)
        WHERE task_id = ?
          AND state IN ('queued', 'running')`,
    );
    this.deleteExpiredStmt = db.prepare(
      'DELETE FROM leases WHERE heartbeat_at + (ttl_seconds * 1000) < ?',
    );
  }

  acquire(params: AcquireParams): AcquireResult {
    try {
      const now = Date.now();
      const lease_id = randomUUID();
      this.insertStmt.run(
        lease_id,
        params.resource_kind,
        params.resource_id,
        params.task_id,
        now,
        params.ttl_seconds,
        now,
      );
      return { ok: true, lease_id };
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        const holder = this.findHolderStmt.get(params.resource_kind, params.resource_id) as
          | { task_id: string }
          | undefined;
        return {
          ok: false,
          reason: 'held_by_other',
          holder_task_id: holder?.task_id ?? 'unknown',
        };
      }
      throw err;
    }
  }

  heartbeat(lease_id: string): void {
    this.heartbeatStmt.run(Date.now(), lease_id);
  }

  /**
   * Bump `heartbeat_at` on every lease a task holds, by `task_id`. The
   * task_progress receiver (s2-task-envelope-spec §6) calls this on each
   * applied stage event: the agent reports progress but does not know its
   * `lease_id`s, so the api keeps the task's leases fresh by task_id rather
   * than tracking each id. Returns the number of leases bumped; idempotent —
   * a task with no leases bumps nothing.
   */
  heartbeatByTask(task_id: string): number {
    return this.heartbeatByTaskStmt.run(Date.now(), task_id).changes;
  }

  release(lease_id: string): void {
    this.releaseStmt.run(lease_id);
  }

  /**
   * Release every lease held by a task, by `task_id`. Used by the dispatch
   * path (s2-task-envelope-spec §5.2) when `task.begin` is rejected/unavailable:
   * the apply txn acquired one lease per affected resource and the caller only
   * has the `task_id`, so this DELETEs them all at once rather than tracking
   * each `lease_id`. Returns the number of leases removed. Idempotent — a task
   * with no leases removes nothing.
   */
  releaseByTask(task_id: string): number {
    return this.releaseByTaskStmt.run(task_id).changes;
  }

  /**
   * Per ADR-0004: expired leases held by non-terminal tasks force the
   * task to `requires_manual_recovery` (we cannot know whether the
   * executor's in-flight side effects completed). Terminal tasks whose
   * leases expired (release race) just lose the lease cleanly.
   *
   * Both task-recovery and lease-delete happen in one SQLite
   * transaction so a crash mid-sweep does not leave orphan state.
   */
  sweepExpired(): SweepResult {
    const now = Date.now();
    let leases_removed = 0;
    let tasks_recovered = 0;

    const run = this.db.transaction((cutoff: number) => {
      const expiredHolders = this.findExpiredHoldersStmt.all(cutoff) as { task_id: string }[];
      for (const { task_id } of expiredHolders) {
        const info = this.recoverTaskStmt.run(cutoff, cutoff, task_id);
        if (info.changes > 0) tasks_recovered += 1;
      }
      const del = this.deleteExpiredStmt.run(cutoff);
      leases_removed = del.changes;
    });
    run(now);

    return { leases_removed, tasks_recovered };
  }
}
