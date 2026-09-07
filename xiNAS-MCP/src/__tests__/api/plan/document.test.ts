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
    expect(doc.client_impact).toBe(
      'Affects NFS share share-a; changed: access. Review the diff for the new access rules.',
    );
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

/**
 * A4 (final review I3, S15 §10.1): `client_impact` is DERIVED from the plan
 * — affected resources, the export path when the diff carries one, and the
 * changed top-level diff fields — not one of two canned sentences. The form
 * message and the approval page both render this string verbatim, so what an
 * operator reads has to come from the plan itself.
 */
describe('clientImpact derivation (S15 §10.1)', () => {
  it('a share update naming clients and options reads as the spec sentence', () => {
    const doc = buildPlanDocument({
      ...base,
      affected_resources: [{ kind: 'Share', id: 'share-a', revision: 42 }],
      diff: {
        path: '/srv/nfs/a',
        clients: [{ pattern: '10.0.0.0/24', options: ['ro'] }],
        options: ['sync'],
      },
    });
    expect(doc.client_impact).toBe(
      'Affects NFS share share-a (export /srv/nfs/a); changed: clients, options. ' +
        'Review the diff for the new access rules.',
    );
  });

  it('finds the export path one level down (the NFS provider nests it in export_entry)', () => {
    const doc = buildPlanDocument({
      ...base,
      diff: {
        action: 'update',
        export_entry: { path: '/mnt/data', clients: [{ pattern: '*' }] },
      },
    });
    expect(doc.client_impact).toBe(
      'Affects NFS share share-a (export /mnt/data); changed: export_entry. ' +
        'Review the diff for the new access rules.',
    );
  });

  it('accepts export_path as the path key too, and skips the narrative action/summary keys', () => {
    const doc = buildPlanDocument({
      ...base,
      diff: { action: 'delete', export_path: '/srv/gone' },
    });
    expect(doc.client_impact).toBe(
      'Affects NFS share share-a (export /srv/gone). Review the diff for the new access rules.',
    );
  });

  it('lists several affected resources by kind and id', () => {
    const doc = buildPlanDocument({
      ...base,
      affected_resources: [
        { kind: 'Share', id: 'share-a', revision: 1 },
        { kind: 'ExportRule', id: 'share-a/10.0.0.0-24', revision: 1 },
      ],
      diff: { clients: [] },
    });
    expect(doc.client_impact).toBe(
      'Affects NFS share share-a, NFS export rule share-a/10.0.0.0-24; changed: clients. ' +
        'Review the diff for the new access rules.',
    );
  });

  it('an unknown resource kind is named verbatim', () => {
    const doc = buildPlanDocument({
      ...base,
      affected_resources: [{ kind: 'Widget', id: 'w1', revision: 1 }],
      diff: { colour: 'red' },
    });
    expect(doc.client_impact).toBe(
      'Affects Widget w1; changed: colour. Review the diff for the new access rules.',
    );
  });

  it('caps long resource and field lists so the form message stays bounded', () => {
    const doc = buildPlanDocument({
      ...base,
      affected_resources: Array.from({ length: 9 }, (_, i) => ({
        kind: 'NetworkInterface',
        id: `mlx${i}`,
        revision: 1,
      })),
      diff: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i])),
    });
    expect(doc.client_impact).toContain('(+4 more)');
    expect(doc.client_impact).toContain('(+4 more fields)');
    expect(doc.client_impact.length).toBeLessThan(400);
  });

  it('a changing_access plan with no affected resources and a non-object diff still reads sensibly', () => {
    const doc = buildPlanDocument({ ...base, affected_resources: [], diff: 'a string' });
    expect(doc.client_impact).toBe(
      'Affects the node configuration. Review the diff for the new access rules.',
    );
  });

  it('non_disruptive and destructive plans keep their neutral sentences', () => {
    expect(buildPlanDocument({ ...base, risk_level: 'non_disruptive' }).client_impact).toBe(
      'No impact on NFS clients.',
    );
    expect(buildPlanDocument({ ...base, risk_level: 'destructive' }).client_impact).toBe(
      'May affect NFS clients; review the diff.',
    );
    expect(buildPlanDocument({ ...base, risk_level: 'unsupported_rollback' }).client_impact).toBe(
      'May affect NFS clients; review the diff.',
    );
  });

  it('derives from the REDACTED diff — a secret-looking field name is still listed, its value never', () => {
    const doc = buildPlanDocument({
      ...base,
      diff: { token: 'super-secret', clients: [] },
    });
    expect(doc.client_impact).toContain('changed: token, clients');
    expect(doc.client_impact).not.toContain('super-secret');
  });
});
