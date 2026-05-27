import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender, genesisHash, canonicalize } from '../../state/audit.js';
import type { AuditEntryInput } from '../../state/types.js';

function open() {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, audit: new AuditAppender(db, 'node-1') };
}

function makeEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    kind: 'share.create',
    request_id: 'req-1',
    principal: 'admin:test',
    client_type: 'rest',
    parameters_hash: 'sha256:p',
    result_hash: 'sha256:r',
    ...overrides,
  };
}

describe('AuditAppender', () => {
  let db: Database.Database;
  let audit: AuditAppender;

  beforeEach(() => {
    ({ db, audit } = open());
  });

  it('queues an entry: outbox row has computed hash and node_id+timestamp injected', () => {
    const queued = audit.queue(makeEntry());
    expect(queued.audit_seq).toBe(1);
    expect(queued.hash).toBeInstanceOf(Buffer);
    expect(queued.hash.length).toBe(32);

    const row = db.prepare('SELECT * FROM audit_outbox WHERE audit_seq = ?').get(1) as
      | { entry_json: Buffer; prev_hash: Buffer; hash: Buffer; drain_state: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.drain_state).toBe('pending');
    expect(row!.prev_hash).toEqual(genesisHash('node-1'));

    const stored = JSON.parse(row!.entry_json.toString('utf8'));
    expect(stored.node_id).toBe('node-1');
    expect(typeof stored.timestamp).toBe('number');
  });

  it('chains hashes: second prev_hash equals first hash', () => {
    const first = audit.queue(makeEntry({ request_id: 'r1' }));
    const second = audit.queue(makeEntry({ request_id: 'r2' }));
    const secondRow = db.prepare('SELECT prev_hash FROM audit_outbox WHERE audit_seq = ?').get(2) as {
      prev_hash: Buffer;
    };
    expect(secondRow.prev_hash).toEqual(first.hash);
    expect(second.prev_hash).toEqual(first.hash);
  });

  it('records request_id, operation_id, task_id in audit_index', () => {
    audit.queue(makeEntry({ request_id: 'r1', operation_id: 'op1', task_id: 'tk1' }));
    const idx = db.prepare('SELECT * FROM audit_index WHERE audit_seq = 1').get() as {
      request_id: string;
      operation_id: string;
      task_id: string;
    };
    expect(idx.request_id).toBe('r1');
    expect(idx.operation_id).toBe('op1');
    expect(idx.task_id).toBe('tk1');
  });

  it('canonicalize sorts keys recursively (JCS-style)', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it('hash chain depends on nested payload (not lost to shallow sort)', () => {
    const e1 = audit.queue(makeEntry({ payload: { nested: { z: 1 } } }));
    const e2 = audit.queue(makeEntry({ payload: { nested: { z: 2 } } }));
    expect(e1.hash).not.toEqual(e2.hash);
  });

  it('rollback of an outer transaction does NOT corrupt the chain', () => {
    const txn = db.transaction(() => {
      audit.queue(makeEntry({ request_id: 'will-rollback' }));
      throw new Error('boom');
    });
    expect(() => txn()).toThrow('boom');

    const after = db.prepare("SELECT COUNT(*) AS n FROM audit_outbox").get() as { n: number };
    expect(after.n).toBe(0);

    const next = audit.queue(makeEntry({ request_id: 'survives' }));
    expect(next.prev_hash).toEqual(genesisHash('node-1'));
  });
});
