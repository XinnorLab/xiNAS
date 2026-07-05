/**
 * Periodic lease sweep (ADR-0004 "periodic sweep"; s2-task-envelope-spec §9).
 *
 * The 60 s lease TTL only self-heals if something drives the clock. Startup +
 * agent-reconnect `reconcile()` are not enough: a lease that outlives its
 * TERMINAL task (a release that didn't run) stays held until the next
 * restart/reconnect, surfacing as a spurious
 * `CONFLICT: resource is locked by another task` on the next mutation. This
 * timer runs `LeaseManager.reapExpiredTerminalLeases()` every interval to
 * bound that — and it must NEVER reap a running/queued task's lease (a slow
 * in-flight stage may legitimately outlive the TTL without a heartbeat).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { LeaseManager } from '../../state/leases.js';
import { startLeaseSweeper } from '../../api/lease-sweeper.js';

function seedTask(db: Database.Database, id: string, state: string): void {
  db.prepare(
    `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                        input_hash, risk_level, affected_resources, created_at, updated_at)
     VALUES (?, 'share.create', ?, 'sys', 'system', ?, ?, 'h', 'non_disruptive', '[]', ?, ?)`,
  ).run(id, state, `r-${id}`, `c-${id}`, Date.now(), Date.now());
}

function leaseCount(db: Database.Database, resourceId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM leases WHERE resource_id = ?').get(resourceId) as {
      n: number;
    }
  ).n;
}

describe('startLeaseSweeper', () => {
  let db: Database.Database;
  let leases: LeaseManager;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    runMigrations(db);
    leases = new LeaseManager(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("reclaims a TERMINAL task's expired lease on a later tick, not before TTL", () => {
    seedTask(db, 't1', 'success');
    expect(
      leases.acquire({ resource_kind: 'Share', resource_id: 's1', task_id: 't1', ttl_seconds: 60 })
        .ok,
    ).toBe(true);

    const handle = startLeaseSweeper({ leases, intervalMs: 30_000 });

    // First tick at +30 s: lease not yet expired (heartbeat + 60 s > now) → kept.
    vi.advanceTimersByTime(30_000);
    expect(leaseCount(db, 's1')).toBe(1);

    // Past the TTL: the tick at +90 s finds it expired AND terminal → reaped.
    vi.advanceTimersByTime(60_000);
    expect(leaseCount(db, 's1')).toBe(0);

    handle.stop();
  });

  it("NEVER reaps a running task's expired lease (no false-reaping)", () => {
    // A `running` task whose stage runs longer than the TTL without emitting a
    // heartbeat must keep its lease — the timer cannot tell "slow" from "dead".
    seedTask(db, 't2', 'running');
    leases.acquire({ resource_kind: 'Share', resource_id: 's2', task_id: 't2', ttl_seconds: 60 });

    const handle = startLeaseSweeper({ leases, intervalMs: 30_000 });
    // Far past the TTL — many ticks.
    vi.advanceTimersByTime(10 * 60_000);
    expect(leaseCount(db, 's2')).toBe(1);

    handle.stop();
  });

  it('stops sweeping after stop()', () => {
    seedTask(db, 't1', 'success');
    leases.acquire({ resource_kind: 'Share', resource_id: 's1', task_id: 't1', ttl_seconds: 60 });
    const handle = startLeaseSweeper({ leases, intervalMs: 30_000 });
    handle.stop();

    vi.advanceTimersByTime(10 * 60_000);
    expect(leaseCount(db, 's1')).toBe(1);
  });

  it('a sweep that throws does not crash the timer (best-effort)', () => {
    seedTask(db, 't1', 'success');
    leases.acquire({ resource_kind: 'Share', resource_id: 's1', task_id: 't1', ttl_seconds: 60 });
    const throwOnce = vi.spyOn(leases, 'reapExpiredTerminalLeases').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const handle = startLeaseSweeper({ leases, intervalMs: 30_000 });
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    // Second tick runs the real reap again.
    throwOnce.mockRestore();
    vi.advanceTimersByTime(60_000);
    expect(leaseCount(db, 's1')).toBe(0);

    handle.stop();
  });
});
