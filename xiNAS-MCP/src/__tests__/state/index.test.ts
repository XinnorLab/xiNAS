import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender } from '../../state/audit.js';
import { openStateStore } from '../../state/index.js';

describe('openStateStore factory', () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('opens a fresh store and reports clean state', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: 'node-1',
    });
    try {
      const result = state.kv.put('/xinas/v1/cluster', { mode: 'single_node' });
      expect(result.ok).toBe(true);
      const fetched = state.kv.get('/xinas/v1/cluster');
      expect(fetched).not.toBeNull();
    } finally {
      await state.close();
    }
  });

  it('reopens cleanly after close (round-trip)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const dbPath = join(dir, 'xinas.db');
    const auditPath = join(dir, 'audit.jsonl');

    const s1 = await openStateStore({ databasePath: dbPath, auditJsonlPath: auditPath, nodeId: 'node-1' });
    s1.kv.put('/k', { x: 1 });
    await s1.close();

    const s2 = await openStateStore({ databasePath: dbPath, auditJsonlPath: auditPath, nodeId: 'node-1' });
    expect(s2.kv.get<{ x: number }>('/k')?.value).toEqual({ x: 1 });
    await s2.close();
  });

  it('factory awaits drainer.recover() and drains a genuinely pending row', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const dbPath = join(dir, 'xinas.db');
    const auditPath = join(dir, 'audit.jsonl');

    // Seed via raw DB — bypass openStateStore so we don't accidentally
    // drain on close().
    const seedDb = new Database(dbPath);
    runMigrations(seedDb);
    const seedAudit = new AuditAppender(seedDb, 'node-1');
    seedAudit.queue({
      kind: 'k',
      request_id: 'r',
      principal: 'p',
      client_type: 'rest',
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
    });
    const pendingBefore = seedDb.prepare(
      "SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'",
    ).get() as { n: number };
    expect(pendingBefore.n).toBe(1);
    seedDb.close();

    expect(existsSync(auditPath)).toBe(false);

    const state = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: 'node-1',
    });
    try {
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!).kind).toBe('k');

      const readDb = new Database(dbPath, { readonly: true });
      const pendingAfter = readDb.prepare(
        "SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'",
      ).get() as { n: number };
      expect(pendingAfter.n).toBe(0);
      const durable = readDb.prepare(
        "SELECT drain_state, durable_file, durable_offset FROM audit_outbox",
      ).get() as { drain_state: string; durable_file: string; durable_offset: number };
      expect(durable.drain_state).toBe('durable');
      expect(durable.durable_file).toBe('audit.jsonl');
      expect(durable.durable_offset).toBeGreaterThanOrEqual(0);
      readDb.close();
    } finally {
      await state.close();
    }
  });
});
