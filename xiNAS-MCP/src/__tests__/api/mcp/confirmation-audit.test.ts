import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  queueConfirmationEvent,
  queueConfirmationEventRaw,
} from '../../../api/mcp/confirmation/audit.js';
import {
  type CreateConfirmationInput,
  ConfirmationStore,
} from '../../../api/mcp/confirmation/store.js';
import { AuditAppender } from '../../../state/audit.js';
import { runMigrations } from '../../../state/migrations.js';

function harness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = new ConfirmationStore({ db, now: () => 1_000_000, newId: () => 'c-1' });
  const audit = new AuditAppender(db, 'node-1');
  return { db, store, audit };
}

const input: CreateConfirmationInput = {
  mode: 'form',
  principal: 'admin:demo',
  role: 'admin',
  tool_name: 'shares.update',
  operation_kind: 'share.update',
  arguments_hash: 'ah-abc',
  plan_id: 'plan-1',
  plan_hash: 'ph-abc',
  plan_document_hash: 'dh-abc',
  idempotency_key: 'ik',
  expected_revision: 42,
  risk_level: 'changing_access',
  rollback_model: 'changing_access',
  request_state_nonce_hash: 'nonce-hash-must-not-leak',
  ttl_ms: 300_000,
  correlation_id: 'corr',
  request_id: 'req-1',
  node_id: 'node-1',
};

describe('queueConfirmationEvent (S15 §12.1)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('queues mcp.confirmation.<event> rows whose payload carries the confirmation identity, extra.detail, and never leaks the nonce hash (F2)', () => {
    const record = h.store.create(input);
    const events = ['requested', 'approved', 'break_glass_used'] as const;
    for (const event of events) {
      queueConfirmationEvent(h.audit, event, record, {
        detail: { approved_by: 'admin:other', approval_channel: 'bearer' },
      });
    }

    const rows = h.db
      .prepare('SELECT audit_seq, entry_json FROM audit_outbox ORDER BY audit_seq')
      .all() as Array<{ audit_seq: number; entry_json: Buffer }>;
    expect(rows).toHaveLength(3);

    const entries = rows.map(
      (r) => JSON.parse(r.entry_json.toString('utf8')) as Record<string, unknown>,
    );
    expect(entries.map((e) => e.kind)).toEqual([
      'mcp.confirmation.requested',
      'mcp.confirmation.approved',
      'mcp.confirmation.break_glass_used',
    ]);

    for (const entry of entries) {
      expect(entry.payload).toMatchObject({
        confirmation_id: record.confirmation_id,
        plan_id: record.plan_id,
        plan_hash: record.plan_hash,
        plan_document_hash: record.plan_document_hash,
        arguments_hash: record.arguments_hash,
        principal: record.principal,
        status: record.status,
        mode: record.mode,
        round: record.round,
        detail: { approved_by: 'admin:other', approval_channel: 'bearer' },
      });

      const serializedPayload = JSON.stringify(entry.payload);
      expect(serializedPayload).not.toContain(record.request_state_nonce_hash);
      expect(serializedPayload).not.toContain('request_state_nonce_hash');

      // operation_id / task_id are exactly what the helper sets: operation_id
      // is always the confirmation_id; task_id is absent because extra.task_id
      // was not passed in this call.
      expect(entry.operation_id).toBe(record.confirmation_id);
      expect(entry.task_id).toBeUndefined();
    }
  });

  it('sets task_id on the entry (top level and in audit_index) and in the payload only when extra.task_id is passed (F2)', () => {
    const record = h.store.create(input);
    queueConfirmationEvent(h.audit, 'consumed', record, { task_id: 'task-9' });

    const row = h.db.prepare('SELECT entry_json FROM audit_outbox WHERE audit_seq = 1').get() as {
      entry_json: Buffer;
    };
    const entry = JSON.parse(row.entry_json.toString('utf8')) as Record<string, unknown>;
    expect(entry.task_id).toBe('task-9');
    expect((entry.payload as Record<string, unknown>).task_id).toBe('task-9');

    const idx = h.db.prepare('SELECT task_id FROM audit_index WHERE audit_seq = 1').get() as {
      task_id: string | null;
    };
    expect(idx.task_id).toBe('task-9');
  });
});

describe('queueConfirmationEventRaw (S15 §7.3, §12.1, F2)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('queues a record-less mcp.confirmation.<event> row, passes the payload through verbatim, and carries no nonce key', () => {
    queueConfirmationEventRaw(h.audit, 'verification_failed', {
      principal: 'admin:demo',
      tool_name: 'shares.update',
      correlation_id: 'corr-9',
      reason: 'mac',
    });

    const row = h.db.prepare('SELECT entry_json FROM audit_outbox WHERE audit_seq = 1').get() as {
      entry_json: Buffer;
    };
    const entry = JSON.parse(row.entry_json.toString('utf8')) as Record<string, unknown>;
    expect(entry.kind).toBe('mcp.confirmation.verification_failed');
    expect(entry.payload).toEqual({
      principal: 'admin:demo',
      tool_name: 'shares.update',
      correlation_id: 'corr-9',
      reason: 'mac',
    });

    const serializedPayload = JSON.stringify(entry.payload);
    expect(serializedPayload).not.toContain('nonce');
    expect(serializedPayload.toLowerCase()).not.toContain('mac.');
  });

  it('aligns operation_id to payload.confirmation_id when present, and omits it otherwise', () => {
    queueConfirmationEventRaw(h.audit, 'replay_rejected', {
      presented_by: 'admin:two',
      record_principal: 'admin:demo',
      confirmation_id: 'c-42',
      reason: 'binding_mismatch',
    });
    queueConfirmationEventRaw(h.audit, 'capability_missing', {
      principal: 'admin:demo',
      tool_name: 'shares.update',
      plan_id: 'plan-1',
      required_mode: 'url',
    });

    const rows = h.db
      .prepare('SELECT entry_json FROM audit_outbox ORDER BY audit_seq')
      .all() as Array<{ entry_json: Buffer }>;
    const entries = rows.map(
      (r) => JSON.parse(r.entry_json.toString('utf8')) as Record<string, unknown>,
    );
    expect(entries[0]?.operation_id).toBe('c-42');
    expect(entries[1]?.operation_id).toBeUndefined();
  });
});
