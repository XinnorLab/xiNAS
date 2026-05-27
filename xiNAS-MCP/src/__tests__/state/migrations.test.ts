import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';

describe('migrations runner', () => {
  it('creates the schema_version table and applies 001-initial.sql', () => {
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
    expect(versions).toEqual([{ version: 1, filename: '001-initial.sql' }]);
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
