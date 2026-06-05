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
    ]);
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
});
