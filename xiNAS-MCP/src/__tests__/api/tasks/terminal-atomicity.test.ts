/**
 * s2-task-envelope-spec §6: the terminal-event handler's state transition and
 * lease release must commit together. Before this, `applyEvent` did
 * `store.transition(success)` (autocommit) and THEN `releaseLeases()` as two
 * separate writes — a failure/crash after the transition left the lease
 * orphaned on an already-`success` task, which (with no periodic sweep at the
 * time) stayed locked until restart and blocked the next mutation of that
 * resource with `CONFLICT: resource is locked by another task`.
 *
 * Drives `applyEvent` over a REAL sqlite db so the transaction rollback is
 * genuinely exercised (no mock can prove atomicity).
 */

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { applyEvent } from '../../../api/tasks/progress.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { LeaseManager } from '../../../state/leases.js';
import { runMigrations } from '../../../state/migrations.js';
import type { Task } from '../../../api/tasks/types.js';

function leaseCount(db: Database.Database, resourceId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource_id = ?').get(resourceId) as {
      n: number;
    }
  ).n;
}

describe('applyEvent terminal branch – atomic transition + lease release', () => {
  let db: Database.Database;
  let store: TaskStore;
  let leases: LeaseManager;
  let task: Task;

  const runAtomic = <T>(fn: () => T): T => db.transaction(fn)();

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new TaskStore({ db, now: () => 1_000, newId: () => 'task-0001' });
    leases = new LeaseManager(db);
    task = store.createApplyTask({
      kind: 'share.create',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '22222222-2222-2222-2222-222222222222',
      correlation_id: 'corr-1',
      input_hash: 'h',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Share', id: 's1', revision: 0 }],
    });
    store.transition(task.task_id, { state: 'running' });
    leases.acquire({
      resource_kind: 'Share',
      resource_id: 's1',
      task_id: task.task_id,
      ttl_seconds: 60,
    });
  });

  afterEach(() => db.close());

  it('rolls the success transition back when the lease release fails', () => {
    expect(() =>
      applyEvent({
        store,
        task,
        event: { task_id: task.task_id, sequence: 1, event_type: 'terminal', status: 'success' },
        spillDir: '/tmp',
        heartbeat: () => {},
        releaseLeases: () => {
          throw new Error('release failed');
        },
        revertDesired: () => {},
        captureDesired: () => {},
        runAtomic,
      }),
    ).toThrow();

    // Atomicity: because the release threw, the whole terminal write rolls
    // back — the task is NOT left `success`, and the lease is NOT orphaned.
    expect(store.get(task.task_id)?.state).toBe('running');
    expect(leaseCount(db, 's1')).toBe(1);
  });

  it('commits the success transition and the lease release together', () => {
    applyEvent({
      store,
      task,
      event: { task_id: task.task_id, sequence: 1, event_type: 'terminal', status: 'success' },
      spillDir: '/tmp',
      heartbeat: () => {},
      releaseLeases: () => leases.releaseByTask(task.task_id),
      revertDesired: () => {},
      captureDesired: () => {},
      runAtomic,
    });

    expect(store.get(task.task_id)?.state).toBe('success');
    expect(leaseCount(db, 's1')).toBe(0);
  });
});
