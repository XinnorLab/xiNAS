import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { GcSweeper } from '../../state/gc.js';

function seedTask(
  db: Database.Database,
  task_id: string,
  state: string,
  terminal_at: number | null,
) {
  db.prepare(
    `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                        input_hash, risk_level, affected_resources, created_at, updated_at, terminal_at)
     VALUES (?, 'k', ?, 'p', 'system', ?, ?, 'h', 'non_disruptive', '[]', ?, ?, ?)`,
  ).run(task_id, state, `r-${task_id}`, `c-${task_id}`, Date.now(), Date.now(), terminal_at);
}

/** Minimal row satisfying every NOT NULL column of mcp_confirmations
 *  (migrations/006-mcp-confirmations.sql). */
function seedConfirmation(
  db: Database.Database,
  confirmation_id: string,
  status: string,
  created_at: number,
) {
  db.prepare(
    `INSERT INTO mcp_confirmations (
       confirmation_id, status, mode, principal, role, tool_name, operation_kind,
       arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key,
       expected_revision, risk_level, rollback_model, request_state_nonce_hash,
       round, created_at, expires_at, correlation_id, request_id, node_id
     ) VALUES (
       ?, ?, 'form', 'admin:test', 'admin', 'shares.update', 'share.update',
       'h', 'p-1', 'ph', 'pdh', 'ik-1',
       1, 'changing_access', 'automatic', 'nh',
       1, ?, ?, 'c-1', 'r-1', 'n-1'
     )`,
  ).run(confirmation_id, status, created_at, created_at + 300_000);
}

function seedLease(
  db: Database.Database,
  resource_id: string,
  task_id: string,
  heartbeat_at: number,
  ttl: number,
) {
  db.prepare(
    `INSERT INTO leases (lease_id, resource_kind, resource_id, task_id, acquired_at, ttl_seconds, heartbeat_at)
     VALUES (?, 'array', ?, ?, ?, ?, ?)`,
  ).run(`l-${resource_id}`, resource_id, task_id, Date.now(), ttl, heartbeat_at);
}

describe('GcSweeper', () => {
  let dir: string;
  let db: Database.Database;
  let gc: GcSweeper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-gc-'));
    db = new Database(':memory:');
    runMigrations(db);
    gc = new GcSweeper(db, {
      taskRetentionDays: 30,
      archiveDir: dir,
      leaseGraceMs: 0,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('archives + removes terminal tasks older than retention', async () => {
    const now = Date.now();
    const day = 86400 * 1000;
    seedTask(db, 't-old', 'success', now - 31 * day);
    seedTask(db, 't-recent', 'success', now - 1 * day);
    seedTask(db, 't-running', 'running', null);

    const result = await gc.sweepTasks();
    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(1);

    const remaining = (
      db.prepare('SELECT task_id FROM tasks ORDER BY task_id').all() as { task_id: string }[]
    ).map((r) => r.task_id);
    expect(remaining).toEqual(['t-recent', 't-running']);

    const files = readdirSync(dir);
    expect(files.some((f) => /^tasks-\d{6}\.jsonl\.gz$/.test(f))).toBe(true);
  });

  it('does not remove non-terminal tasks regardless of age', async () => {
    const now = Date.now();
    seedTask(db, 't-old-running', 'running', null);
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(
      now - 1000 * 86400,
      't-old-running',
    );
    await gc.sweepTasks();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id = 't-old-running'").get(),
    ).toEqual({ n: 1 });
  });

  it('sweepLeases delegates to LeaseManager and returns its result shape', () => {
    seedTask(db, 't1', 'running', null);
    seedLease(db, 'arr1', 't1', Date.now() - 60_000, 30);
    seedLease(db, 'arr2', 't1', Date.now(), 60);

    const result = gc.sweepLeases();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1);
    expect(db.prepare('SELECT resource_id FROM leases').all()).toEqual([{ resource_id: 'arr2' }]);
  });

  it('sweepAll combines results', async () => {
    const now = Date.now();
    seedTask(db, 't-old', 'success', now - 31 * 86400 * 1000);
    seedTask(db, 't1', 'running', null);
    seedLease(db, 'arr1', 't1', now - 60_000, 30);

    const result = await gc.sweepAll();
    expect(result.tasks_archived).toBe(1);
    expect(result.tasks_deleted).toBe(1);
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1);
  });

  // S15 Task 14 — GC prunes terminal mcp_confirmations rows past the same
  // task-retention window, leaving an OPEN (pending/approved) row alone
  // regardless of age: TERMINAL_CONFIRMATION_STATUSES
  // (api/mcp/confirmation/types.ts) are declined/cancelled/expired/consumed
  // — never pending/approved.
  it('sweepConfirmations deletes only terminal mcp_confirmations rows older than the retention window', () => {
    const now = Date.now();
    const day = 86400 * 1000;
    seedConfirmation(db, 'c-old-expired', 'expired', now - 31 * day);
    seedConfirmation(db, 'c-old-pending', 'pending', now - 31 * day);

    const result = gc.sweepConfirmations();
    expect(result.confirmations_deleted).toBe(1);

    const remaining = (
      db.prepare('SELECT confirmation_id FROM mcp_confirmations').all() as {
        confirmation_id: string;
      }[]
    ).map((r) => r.confirmation_id);
    expect(remaining).toEqual(['c-old-pending']);
  });

  it('sweepAll also prunes terminal mcp_confirmations rows', async () => {
    const now = Date.now();
    const day = 86400 * 1000;
    seedConfirmation(db, 'c-old-declined', 'declined', now - 31 * day);
    seedConfirmation(db, 'c-recent-declined', 'declined', now - 1 * day);

    const result = await gc.sweepAll();
    expect(result.confirmations_deleted).toBe(1);

    const remaining = (
      db.prepare('SELECT confirmation_id FROM mcp_confirmations').all() as {
        confirmation_id: string;
      }[]
    ).map((r) => r.confirmation_id);
    expect(remaining).toEqual(['c-recent-declined']);
  });
});
