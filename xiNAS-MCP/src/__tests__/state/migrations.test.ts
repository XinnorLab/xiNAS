import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../state/migrations.js';

describe('migrations runner', () => {
  it('creates the schema_version table and applies all migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toEqual([
      'audit_index',
      'audit_outbox',
      'kv',
      'leases',
      'mcp_confirmations',
      'schema_version',
      'sqlite_sequence',
      'task_stages',
      'tasks',
    ]);

    const versions = db
      .prepare('SELECT version, filename FROM schema_version ORDER BY version')
      .all();
    expect(versions).toEqual([
      { version: 1, filename: '001-initial.sql' },
      { version: 2, filename: '002-task-dispatch.sql' },
      { version: 3, filename: '003-task-spec.sql' },
      { version: 4, filename: '004-task-plan-binding.sql' },
      { version: 5, filename: '005-task-stage-total.sql' },
      { version: 6, filename: '006-mcp-confirmations.sql' },
    ]);
  });

  it('004 adds plan_binding + desired_rollback columns to tasks (nullable)', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('plan_binding');
    expect(columns).toContain('desired_rollback');

    // Both are nullable (NULL for tasks created before 004 / without them).
    db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                          input_hash, risk_level, affected_resources, created_at, updated_at)
       VALUES ('t-004', 'test', 'queued', 'sys', 'system', 'r', 'c', 'h', 'non_disruptive', '[]', 0, 0)`,
    ).run();
    const row = db
      .prepare('SELECT plan_binding, desired_rollback FROM tasks WHERE task_id = ?')
      .get('t-004') as { plan_binding: string | null; desired_rollback: string | null };
    expect(row.plan_binding).toBeNull();
    expect(row.desired_rollback).toBeNull();
  });

  it('005 adds a nullable stage_total column to tasks', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('stage_total');

    // NULL until the agent's `accepted` event reports the executor's stage
    // count — every pre-005 task keeps a missing denominator, by design.
    db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                          input_hash, risk_level, affected_resources, created_at, updated_at)
       VALUES ('t-005', 'test', 'queued', 'sys', 'system', 'r', 'c', 'h', 'non_disruptive', '[]', 0, 0)`,
    ).run();
    const row = db.prepare('SELECT stage_total FROM tasks WHERE task_id = ?').get('t-005') as {
      stage_total: number | null;
    };
    expect(row.stage_total).toBeNull();
  });

  it('003 adds the spec column to tasks (nullable)', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('spec');

    // spec is nullable (NULL for tasks created before 003 / without a spec).
    db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                          input_hash, risk_level, affected_resources, created_at, updated_at)
       VALUES ('t-003', 'test', 'queued', 'sys', 'system', 'r', 'c', 'h', 'non_disruptive', '[]', 0, 0)`,
    ).run();
    const row = db.prepare('SELECT spec FROM tasks WHERE task_id = ?').get('t-003') as {
      spec: string | null;
    };
    expect(row.spec).toBeNull();
  });

  it('002 adds the dispatch-tracking columns to tasks', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('agent_acceptance_id');
    expect(columns).toContain('last_event_sequence');

    // last_event_sequence defaults to 0 (NOT NULL DEFAULT 0).
    db.prepare(
      `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                          input_hash, risk_level, affected_resources, created_at, updated_at)
       VALUES ('t-002', 'test', 'queued', 'sys', 'system', 'r', 'c', 'h', 'non_disruptive', '[]', 0, 0)`,
    ).run();
    const row = db
      .prepare('SELECT agent_acceptance_id, last_event_sequence FROM tasks WHERE task_id = ?')
      .get('t-002') as { agent_acceptance_id: string | null; last_event_sequence: number };
    expect(row.agent_acceptance_id).toBeNull();
    expect(row.last_event_sequence).toBe(0);
  });

  it('is idempotent: re-running applies no new migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    runMigrations(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('006 adds plan_document columns and the mcp_confirmations table (S15)', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(taskCols).toContain('plan_document');
    expect(taskCols).toContain('plan_document_hash');

    const confCols = (
      db.prepare('PRAGMA table_info(mcp_confirmations)').all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      'confirmation_id',
      'status',
      'mode',
      'principal',
      'role',
      'tool_name',
      'operation_kind',
      'arguments_hash',
      'plan_id',
      'plan_hash',
      'plan_document_hash',
      'idempotency_key',
      'expected_revision',
      'risk_level',
      'rollback_model',
      'request_state_nonce_hash',
      'round',
      'created_at',
      'expires_at',
      'approved_at',
      'approved_by',
      'approval_channel',
      'approval_interface',
      'declined_at',
      'declined_by',
      'decision_reason',
      'consumed_at',
      'consumed_task_id',
      'expired_reason',
      'correlation_id',
      'request_id',
      'node_id',
    ]) {
      expect(confCols, `missing column ${col}`).toContain(col);
    }

    // status is CHECK-constrained
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_confirmations (confirmation_id, status, mode, principal, role, tool_name,
             operation_kind, arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key,
             expected_revision, risk_level, rollback_model, request_state_nonce_hash, round,
             created_at, expires_at, correlation_id, request_id, node_id)
           VALUES ('c1', 'bogus', 'form', 'p', 'admin', 't', 'k', 'a', 'pl', 'ph', 'dh', 'ik',
             0, 'non_disruptive', 'non_disruptive', 'nh', 1, 0, 1, 'c', 'r', 'n')`,
        )
        .run(),
    ).toThrow(/CHECK/);

    // a task can be produced by at most one confirmation
    const insert = db.prepare(
      `INSERT INTO mcp_confirmations (confirmation_id, status, mode, principal, role, tool_name,
         operation_kind, arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key,
         expected_revision, risk_level, rollback_model, request_state_nonce_hash, round,
         created_at, expires_at, consumed_task_id, correlation_id, request_id, node_id)
       VALUES (?, 'consumed', 'form', 'p', 'admin', 't', 'k', 'a', 'pl', 'ph', 'dh', ?,
         0, 'non_disruptive', 'non_disruptive', 'nh', 1, 0, 1, 'task-1', 'c', 'r', 'n')`,
    );
    insert.run('c2', 'ik-2');
    expect(() => insert.run('c3', 'ik-3')).toThrow(/UNIQUE/);
  });
});
