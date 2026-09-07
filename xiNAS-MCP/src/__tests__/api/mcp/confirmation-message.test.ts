import { describe, expect, it } from 'vitest';
import {
  renderConfirmationMessage,
  renderSummary,
  summarizeDiff,
} from '../../../api/mcp/confirmation/message.js';
import type { ConfirmationRecord } from '../../../api/mcp/confirmation/types.js';
import { type PlanDocument, buildPlanDocument } from '../../../api/plan/document.js';
import { canonicalize } from '../../../lib/canonical-json.js';

/**
 * A4: built through `buildPlanDocument` — the production path — so
 * `client_impact` is whatever `clientImpact()` actually derives. Pinning a
 * hand-written sentence here let the §10.1 claim drift away from what an
 * operator is really shown.
 */
const document: PlanDocument = buildPlanDocument({
  plan_id: '0d7f6c2e-1111-4222-8333-444455556666',
  operation_kind: 'share.update',
  plan_hash: '9f3c1a2b7e4d'.padEnd(64, '0'),
  state_revision_expected: 42,
  observed_revision_expected: 17,
  observed_at: '2026-09-04T10:00:00.000Z',
  affected_resources: [
    { kind: 'Share', id: 'share-a' },
    { kind: 'ExportRule', id: 'share-a/10.0.0.0/24' },
  ],
  risk_level: 'changing_access',
  blockers: [],
  warnings: [
    {
      code: 'NFS_SESSIONS_ACTIVE',
      message: '3 active sessions from 10.0.0.12, 10.0.0.15, 10.0.0.31',
    },
  ],
  diff: {
    path: '/srv/share-a',
    access_mode: { before: 'rw', after: 'ro' },
    clients: ['10.0.0.0/24'],
  },
  rollback_model: 'changing_access',
  created_at_ms: Date.parse('2026-09-04T10:00:00.000Z'),
  principal: 'admin:demo',
  client_type: 'mcp',
});

const record = {
  confirmation_id: 'c-1',
  status: 'pending',
  mode: 'form',
  principal: 'admin:demo',
  role: 'admin',
  tool_name: 'shares.update',
  operation_kind: 'share.update',
  arguments_hash: 'ah',
  plan_id: document.plan_id,
  plan_hash: document.plan_hash,
  plan_document_hash: 'dh',
  idempotency_key: 'ik',
  expected_revision: 42,
  risk_level: 'changing_access',
  rollback_model: 'changing_access',
  request_state_nonce_hash: 'nh',
  round: 1,
  created_at: Date.parse('2026-09-04T10:00:00Z'),
  expires_at: Date.parse('2026-09-04T10:05:00Z'),
  correlation_id: 'corr',
  request_id: 'req',
  node_id: '00000000-0000-0000-0000-000000000778',
} as ConfirmationRecord;

describe('confirmation message (S15 §10)', () => {
  it('contains every mandated line, built from the document only', () => {
    const msg = renderConfirmationMessage({
      record,
      document,
      hostname: 'nas-01',
      now: Date.parse('2026-09-04T10:00:02Z'),
    });
    for (const needle of [
      'xiNAS node nas-01',
      '000000000778',
      'shares.update (share.update)',
      'Share "share-a"',
      'Risk: changing_access',
      'Rollback: changing_access',
      // A4: the DERIVED sentence, exactly as buildPlanDocument produced it.
      'Client impact: Affects NFS share share-a, NFS export rule share-a/10.0.0.0/24 ' +
        '(export /srv/share-a); changed: access_mode, clients. ' +
        'Review the diff for the new access rules.',
      'ExportRule share-a/10.0.0.0/24',
      'NFS_SESSIONS_ACTIVE',
      '10.0.0.12',
      'access_mode',
      'rw',
      'ro',
      `Plan ${document.plan_id}`,
      'hash 9f3c1a2b7e4d',
      'expires 2026-09-04T10:05:00',
      'in 4m58s',
      'Choose APPLY',
    ]) {
      expect(msg, needle).toContain(needle);
    }
    expect(msg).not.toMatch(/https?:\/\//);
  });

  it('summarizeDiff caps at 600 chars with a tail note', () => {
    const big = { list: Array.from({ length: 200 }, (_, i) => `entry-${i}`) };
    const s = summarizeDiff(big);
    expect(s.length).toBeLessThanOrEqual(640);
    expect(s).toMatch(/… \(\d+ more characters; see the plan\)$/);
  });

  it('summarizeDiff pluralizes the overflow count (F2)', () => {
    const diff = { a: 'x'.repeat(700) };
    const full = canonicalize(diff);
    const s1 = summarizeDiff(diff, full.length - 1);
    expect(s1).toContain('(1 more character; see the plan)');
    const s2 = summarizeDiff(diff, full.length - 2);
    expect(s2).toContain('(2 more characters; see the plan)');
  });

  it('renders "Affected: (none listed)" when affected_resources is empty (F3)', () => {
    const d = { ...document, affected_resources: [] };
    const msg = renderConfirmationMessage({
      record,
      document: d,
      hostname: 'nas-01',
      now: Date.parse('2026-09-04T10:00:02Z'),
    });
    expect(msg).toContain('Affected: (none listed)');
  });

  it('renderSummary spells out destructive consequences and rollback limitation', () => {
    const d = { ...document, risk_level: 'destructive', rollback_model: 'destructive' };
    const r = {
      ...record,
      risk_level: 'destructive',
      rollback_model: 'destructive',
    } as ConfirmationRecord;
    const now = r.created_at + 240_000;
    const s = renderSummary({ record: r, document: d, hostname: 'nas-01', now });
    expect(s.consequences).toBe(
      'This operation destroys data on Share share-a, ExportRule share-a/10.0.0.0/24. Data on them may be permanently lost.',
    );
    expect(s.rollback_limitation).toContain('destructive');
    expect(s.message).toContain('nas-01');
    expect(s.message.split(r.node_id).length - 1).toBe(1);
    expect(s.message).toContain('1m00s');
    const u = renderSummary({
      record: { ...r, rollback_model: 'unsupported' } as ConfirmationRecord,
      document: { ...d, rollback_model: 'unsupported' },
      hostname: 'nas-01',
      now,
    });
    expect(u.rollback_limitation).toBe('xiNAS cannot roll this operation back automatically.');
  });

  it('renderSummary spells out destructive consequences with no affected resources (F3)', () => {
    const d = {
      ...document,
      risk_level: 'destructive',
      rollback_model: 'destructive',
      affected_resources: [],
    };
    const r = {
      ...record,
      risk_level: 'destructive',
      rollback_model: 'destructive',
    } as ConfirmationRecord;
    const s = renderSummary({
      record: r,
      document: d,
      hostname: 'nas-01',
      now: r.created_at + 1000,
    });
    expect(s.consequences).toBe(
      'This operation destroys data on the affected resources. Data may be permanently lost.',
    );
  });

  /**
   * A5 (final review I5, S15 §10.2) — `unsupported_rollback` is a risk level
   * in its own right (`confirmationModeFor` sends it to url mode), but the
   * page used to describe it with the generic "changes the node
   * configuration" line and, when `rollback_model` was something other than
   * `unsupported`, with a rollback sentence that contradicted the risk.
   */
  describe('A5: unsupported_rollback operator text', () => {
    const unsupported = (rollbackModel: string) => {
      const d = {
        ...document,
        risk_level: 'unsupported_rollback',
        rollback_model: rollbackModel,
      };
      const r = {
        ...record,
        risk_level: 'unsupported_rollback',
        rollback_model: rollbackModel,
      } as ConfirmationRecord;
      return renderSummary({ record: r, document: d, hostname: 'nas-01', now: r.created_at });
    };

    it('consequences name the manual recovery, whatever the rollback_model says', () => {
      for (const model of ['unsupported', 'changing_access', 'non_disruptive', 'destructive']) {
        expect(unsupported(model).consequences).toBe(
          'This operation cannot be rolled back automatically: if it fails or must be undone, manual recovery is required.',
        );
      }
    });

    it('rollback_limitation is the no-automatic-rollback sentence for the risk level alone', () => {
      for (const model of ['unsupported', 'changing_access', 'non_disruptive', 'destructive']) {
        expect(unsupported(model).rollback_limitation).toBe(
          'xiNAS cannot roll this operation back automatically.',
        );
      }
    });

    it('the unsupported_rollback branch is evaluated BEFORE changing_access', () => {
      // A changing_access rollback_model must not win the consequences line.
      expect(unsupported('changing_access').consequences).not.toContain('changes client access');
    });

    it('a changing_access risk still gets its own consequences and rollback sentences', () => {
      const s = renderSummary({
        record,
        document,
        hostname: 'nas-01',
        now: record.created_at,
      });
      expect(s.consequences).toBe(
        `This operation changes client access: ${document.client_impact}`,
      );
      expect(s.rollback_limitation).toBe(
        'Rollback restores the previous access rules; clients may see a brief interruption.',
      );
    });

    it('rollback_model: unsupported alone still wins over the model switch', () => {
      const d = { ...document, rollback_model: 'unsupported' };
      const r = { ...record, rollback_model: 'unsupported' } as ConfirmationRecord;
      const s = renderSummary({ record: r, document: d, hostname: 'nas-01', now: r.created_at });
      expect(s.rollback_limitation).toBe('xiNAS cannot roll this operation back automatically.');
      // …and the consequences line still follows the RISK level.
      expect(s.consequences).toBe(`This operation changes client access: ${d.client_impact}`);
    });
  });

  it('renders a url-mode message and never leaks secret hashes (F5)', () => {
    const secretRecord = {
      ...record,
      request_state_nonce_hash: 'nh-SECRET',
      idempotency_key: 'ik-SECRET',
      arguments_hash: 'ah-SECRET',
      plan_document_hash: 'dh-SECRET',
    } as ConfirmationRecord;
    for (const mode of ['form', 'url'] as const) {
      const msg = renderConfirmationMessage({
        record: { ...secretRecord, mode },
        document,
        hostname: 'nas-01',
        now: Date.parse('2026-09-04T10:00:02Z'),
      });
      expect(msg.length).toBeGreaterThan(0);
      for (const secret of ['nh-SECRET', 'ik-SECRET', 'ah-SECRET', 'dh-SECRET']) {
        expect(msg).not.toContain(secret);
      }
    }
  });
});
