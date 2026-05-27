import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender } from '../../state/audit.js';
import { AuditDrainer } from '../../state/audit-drainer.js';

describe('AuditDrainer', () => {
  let dir: string;
  let db: Database.Database;
  let audit: AuditAppender;
  let drainer: AuditDrainer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-audit-'));
    db = new Database(':memory:');
    runMigrations(db);
    audit = new AuditAppender(db, 'node-1');
    drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
  });

  afterEach(async () => {
    await drainer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function entry(over: Record<string, unknown> = {}) {
    return {
      kind: 'k',
      request_id: 'r',
      principal: 'p',
      client_type: 'rest' as const,
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
      ...over,
    };
  }

  it('drains pending rows to JSONL with one line per entry, including chain metadata', async () => {
    audit.queue(entry({ kind: 'a', request_id: 'r1' }));
    audit.queue(entry({ kind: 'b', request_id: 'r2' }));

    await drainer.drainNow();

    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const l0 = JSON.parse(lines[0]!);
    expect(l0.kind).toBe('a');
    expect(l0.audit_seq).toBe(1);
    expect(typeof l0.prev_hash).toBe('string');
    expect(typeof l0.hash).toBe('string');
    expect(l0.node_id).toBe('node-1');
    expect(typeof l0.timestamp).toBe('number');

    const l1 = JSON.parse(lines[1]!);
    expect(l1.kind).toBe('b');
    expect(l1.audit_seq).toBe(2);
    expect(l1.prev_hash).toBe(l0.hash);
  });

  it('marks outbox rows as durable atomically with audit_index update', async () => {
    audit.queue(entry());
    await drainer.drainNow();

    const row = db
      .prepare(
        'SELECT drain_state, durable_file, durable_offset FROM audit_outbox WHERE audit_seq = 1',
      )
      .get() as {
      drain_state: string;
      durable_file: string;
      durable_offset: number;
    };
    expect(row.drain_state).toBe('durable');
    expect(row.durable_file).toBe('audit.jsonl');
    expect(typeof row.durable_offset).toBe('number');

    const idx = db
      .prepare('SELECT durable_file, durable_offset FROM audit_index WHERE audit_seq = 1')
      .get() as {
      durable_file: string;
      durable_offset: number;
    };
    expect(idx.durable_file).toBe(row.durable_file);
    expect(idx.durable_offset).toBe(row.durable_offset);
  });

  it('drainNow is a no-op when no pending rows', async () => {
    await drainer.drainNow();
    await drainer.drainNow();
    const row = db.prepare('SELECT COUNT(*) AS n FROM audit_outbox').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('notifyJsonlAdvanced keeps the chain valid across outbox pruning', async () => {
    const wiredDrainer = new AuditDrainer(db, {
      path: join(dir, 'audit-wired.jsonl'),
      audit,
    });

    const first = audit.queue(entry({ kind: 'first' }));
    await wiredDrainer.drainNow();
    db.prepare('DELETE FROM audit_outbox').run();

    const second = audit.queue(entry({ kind: 'second' }));
    expect(second.prev_hash).toEqual(first.hash);
  });

  it('recover() refuses startup when JSONL is gapped relative to outbox', async () => {
    const e1 = audit.queue(entry({ kind: 'a' }));
    const e2 = audit.queue(entry({ kind: 'b' }));

    const line2 =
      JSON.stringify({
        audit_seq: e2.audit_seq,
        prev_hash: e2.prev_hash.toString('hex'),
        hash: e2.hash.toString('hex'),
        kind: 'b',
        timestamp: Date.now(),
        node_id: 'node-1',
        principal: 'p',
        client_type: 'rest',
        request_id: 'r',
        parameters_hash: 'sha256:p',
        result_hash: 'sha256:r',
      }) + '\n';
    writeFileSync(join(dir, 'audit-gap.jsonl'), line2);

    const gappedDrainer = new AuditDrainer(db, {
      path: join(dir, 'audit-gap.jsonl'),
      audit,
    });

    await expect(gappedDrainer.recover()).rejects.toThrow(/audit chain corrupt/);
    void e1;
  });
});
