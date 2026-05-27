import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender } from '../../state/audit.js';
import { AuditDrainer } from '../../state/audit-drainer.js';

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

describe('AuditDrainer — crash recovery', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-audit-rec-'));
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recover() drains rows left pending from a prior process (clean case)', async () => {
    const audit = new AuditAppender(db, 'node-1');
    audit.queue(entry({ kind: 'a' }));
    audit.queue(entry({ kind: 'b' }));

    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.recover();

    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('recover() does NOT re-append rows that already made it to JSONL', async () => {
    const audit = new AuditAppender(db, 'node-1');
    const queued = audit.queue(entry({ kind: 'a' }));

    // Simulate the crash-after-fsync-before-mark window.
    const fakeLine =
      JSON.stringify({
        audit_seq: queued.audit_seq,
        prev_hash: queued.prev_hash.toString('hex'),
        hash: queued.hash.toString('hex'),
        kind: 'a',
        timestamp: Date.now(),
        node_id: 'node-1',
        principal: 'p',
        client_type: 'rest',
        request_id: 'r',
        parameters_hash: 'sha256:p',
        result_hash: 'sha256:r',
      }) + '\n';
    writeFileSync(join(dir, 'audit.jsonl'), fakeLine);

    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.recover();

    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
    const row = db
      .prepare('SELECT drain_state FROM audit_outbox WHERE audit_seq = ?')
      .get(queued.audit_seq) as { drain_state: string };
    expect(row.drain_state).toBe('durable');
  });

  it('AuditAppender.reloadTailHash extracts the tail hash from the JSONL', async () => {
    const audit1 = new AuditAppender(db, 'node-1');
    const first = audit1.queue(entry({ kind: 'a' }));
    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.drainNow();

    // Simulate restart: outbox empty, new AuditAppender.
    db.prepare('DELETE FROM audit_outbox').run();
    const audit2 = new AuditAppender(db, 'node-1');
    audit2.reloadTailHash(join(dir, 'audit.jsonl'));

    const next = audit2.queue(entry({ kind: 'b' }));
    expect(next.prev_hash).toEqual(first.hash);
  });
});
