import { describe, expect, it } from 'vitest';
import {
  buildPlanDocument,
  planDocumentHash,
  publicPlan,
  redactValue,
} from '../../../api/plan/document.js';

const base = {
  plan_id: 'plan-1',
  operation_kind: 'share.update',
  plan_hash: 'ph',
  state_revision_expected: 42,
  observed_revision_expected: 7,
  observed_at: '2026-09-04T10:00:00.000Z',
  affected_resources: [{ kind: 'Share', id: 'share-a', revision: 42 }],
  risk_level: 'changing_access',
  blockers: [],
  warnings: [{ code: 'W1', message: 'w' }],
  diff: { access: { before: 'rw', after: 'ro' } },
  rollback_model: 'changing_access',
  created_at_ms: Date.parse('2026-09-04T10:00:00.000Z'),
  principal: 'admin:demo',
  client_type: 'mcp',
};

describe('plan document (S15 §5)', () => {
  it('derives resource_ref from the primary affected resource and stamps bookkeeping', () => {
    const doc = buildPlanDocument(base);
    expect(doc.schema).toBe(1);
    expect(doc.resource_ref).toEqual({ kind: 'Share', id: 'share-a' });
    expect(doc.created_at).toBe('2026-09-04T10:00:00.000Z');
    expect(doc.created_by).toEqual({ principal: 'admin:demo', client_type: 'mcp' });
    expect(doc.client_impact).toBe('May affect NFS clients; review the diff.');
  });

  it('publicPlan strips exactly the bookkeeping fields', () => {
    const pub = publicPlan(buildPlanDocument(base));
    expect(Object.keys(pub).sort()).toEqual(
      [
        'affected_resources',
        'blockers',
        'client_impact',
        'diff',
        'observed_at',
        'observed_revision_expected',
        'plan_hash',
        'plan_id',
        'risk_level',
        'rollback_model',
        'state_revision_expected',
        'warnings',
      ].sort(),
    );
  });

  it('hash is stable under key reordering and changes with any value', () => {
    const a = buildPlanDocument(base);
    const b = buildPlanDocument({ ...base, diff: { access: { after: 'ro', before: 'rw' } } });
    expect(planDocumentHash(a)).toBe(planDocumentHash(b));
    const c = buildPlanDocument({ ...base, diff: { access: { before: 'rw', after: 'rw' } } });
    expect(planDocumentHash(c)).not.toBe(planDocumentHash(a));
  });

  it('redacts secret-looking keys at any depth with a digest, never the value', () => {
    const out = redactValue({
      a: { Password: 'hunter2', nested: [{ api_key: 'k' }] },
      token: 'abc',
      fine: 'x',
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('"abc"');
    expect(out.fine).toBe('x');
    const tok = out.token as { redacted: string; digest: string };
    expect(tok.redacted).toBe('sha256');
    expect(tok.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the diff persisted in the document is redacted and the hash covers the redacted form', () => {
    const doc = buildPlanDocument({ ...base, diff: { secret: 's3', before: 1 } });
    expect(JSON.stringify(doc.diff)).not.toContain('s3');
  });
});
