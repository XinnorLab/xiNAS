import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { LeaseManager } from '../../state/leases.js';

function openLeases() {
  const db = new Database(':memory:');
  runMigrations(db);
  // Seed two stub tasks so the FK constraint passes.
  for (const t of ['t1', 't2']) {
    db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                          input_hash, risk_level, affected_resources, created_at, updated_at)
       VALUES (?, 'test', 'running', 'sys', 'system', ?, ?, 'h', 'non_disruptive', '[]', ?, ?)`,
    ).run(t, `r-${t}`, `c-${t}`, Date.now(), Date.now());
  }
  return { db, leases: new LeaseManager(db) };
}

describe('LeaseManager', () => {
  let db: Database.Database;
  let leases: LeaseManager;

  beforeEach(() => {
    ({ db, leases } = openLeases());
  });

  it('acquires a lease for a resource', () => {
    const result = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second acquire on the same resource', () => {
    leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    const second = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't2', ttl_seconds: 60 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('held_by_other');
    expect(second.holder_task_id).toBe('t1');
  });

  it('release frees the resource', () => {
    const first = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    if (!first.ok) throw new Error('seed failed');
    leases.release(first.lease_id);
    const second = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't2', ttl_seconds: 60 });
    expect(second.ok).toBe(true);
  });

  it('heartbeat extends ttl', () => {
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    if (!r.ok) throw new Error('seed failed');
    const t0 = (db.prepare('SELECT heartbeat_at FROM leases WHERE lease_id = ?').get(r.lease_id) as { heartbeat_at: number }).heartbeat_at;
    leases.heartbeat(r.lease_id);
    const t1 = (db.prepare('SELECT heartbeat_at FROM leases WHERE lease_id = ?').get(r.lease_id) as { heartbeat_at: number }).heartbeat_at;
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('sweepExpired removes leases whose heartbeat_at + ttl is past now', () => {
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);
    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
  });

  it('sweepExpired transitions still-running holder tasks to requires_manual_recovery', () => {
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);

    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1);

    const task = db.prepare('SELECT state, error_code FROM tasks WHERE task_id = ?').get('t1') as {
      state: string;
      error_code: string;
    };
    expect(task.state).toBe('requires_manual_recovery');
    expect(task.error_code).toBe('FAILED_STATE_DESYNC');
  });

  it('sweepExpired does not touch terminal tasks even when their lease expires', () => {
    db.prepare("UPDATE tasks SET state = 'success', terminal_at = ? WHERE task_id = 't1'").run(Date.now());
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);

    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(0);
    const task = db.prepare("SELECT state FROM tasks WHERE task_id = 't1'").get() as { state: string };
    expect(task.state).toBe('success');
  });
});
