import { describe, expect, it } from 'vitest';
import { AGENTIC_CATALOG } from '../../../lib/health/agentic-catalog.js';
import {
  REPORT_SCHEMA,
  REPORT_SCHEMA_VERSION,
  type ReportCheck,
  computeVerdict,
  validateReportShape,
} from '../../../lib/health/report-validate.js';

const T0 = '2026-09-09T10:00:00.000Z';
const T1 = '2026-09-09T10:03:00.000Z';
const SHA = `sha256:${'a'.repeat(64)}`;

const mandatoryFor = (kind: 'node' | 'service_path'): string[] =>
  AGENTIC_CATALOG.checks.filter((c) => c.mandatory_for.includes(kind)).map((c) => c.id);

const check = (id: string, over: Partial<ReportCheck> = {}): ReportCheck => ({
  id,
  outcome: 'pass',
  severity: null,
  reason: 'all good',
  mandatory: true,
  evidence_refs: ['ev-1'],
  ...over,
});

/** A minimal, valid node-scope report: every mandatory row passes. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    run: {
      run_id: '11111111-2222-4333-8444-555555555555',
      started_at: T0,
      completed_at: T1,
      principal: 'op:alice',
      node: {
        hostname: 'nas-01',
        controller_id: '00000000-0000-0000-0000-0000000000aa',
        xinas_version: '1.0.0',
      },
      versions: {
        prompt: '1.0.0',
        template_sha256: 'b'.repeat(64),
        policy: '1',
        catalog: '1',
        report_schema: '1',
      },
      execution: {
        mode: 'sequential',
        roles_ran: ['storage', 'network', 'system'],
        model: { provider: 'anthropic', name: 'claude' },
        budget: { tool_calls: 12, elapsed_seconds: 41.5 },
        errors: [],
      },
    },
    scope: {
      kind: 'node',
      targets: ['nas-01'],
      client_path_in_scope: false,
      time_window: { requested_seconds: 3600, covered: { from: T0, to: T1 } },
      declared_absent: [],
    },
    run_status: 'completed',
    health_status: 'ok',
    coverage_status: 'complete',
    raw_reports: [
      {
        tool: 'health.check',
        args: { profile: 'quick' },
        collected_at: T0,
        digest: SHA,
        report: { overall: 'ok' },
      },
    ],
    checks: mandatoryFor('node').map((id) => check(id)),
    findings: [],
    evidence_manifest: [
      {
        id: 'ev-1',
        source: 'health.check',
        args: { profile: 'quick' },
        request_id: 'req-1',
        observed_at: T0,
        collected_at: T0,
        revision: 3,
        units: null,
        value: 'ok',
        excerpt: 'overall: ok',
        stale: false,
      },
    ],
    not_checked: [],
    human_readable: 'Result: ok. Scope: nas-01. Coverage: complete.',
    ...over,
  };
}

const withChecks = (mutate: (c: ReportCheck) => ReportCheck | null, extra: ReportCheck[] = []) =>
  report({
    checks: [
      ...mandatoryFor('node')
        .map((id) => mutate(check(id)))
        .filter((c): c is ReportCheck => c !== null),
      ...extra,
    ],
  });

/** S19c T5 — spec §11.1 schema and §11.3 verdict. */
describe('agentic report schema', () => {
  it('is JSON Schema 2020-12 v1 and accepts the minimal valid report', () => {
    expect(REPORT_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(REPORT_SCHEMA_VERSION).toBe('1');
    const v = validateReportShape(report(), AGENTIC_CATALOG);
    expect(v.schema_errors).toEqual([]);
    expect(v.reference_errors).toEqual([]);
    expect(v.status_errors).toEqual([]);
    expect(v.computed).toEqual({ health_status: 'ok', coverage_status: 'complete' });
    expect(v.mandatory_ids.sort()).toEqual(mandatoryFor('node').sort());
  });

  it.each([
    [report({ report_schema_version: '2' }), '/report_schema_version'],
    [report({ run_status: 'done' }), '/run_status'],
    [report({ health_status: 'fine' }), '/health_status'],
    [
      withChecks((c) => (c.id === 'HC-03.arrays' ? { ...c, outcome: 'maybe' as never } : c)),
      '/outcome',
    ],
    [
      report({
        raw_reports: [{ tool: 'x', args: {}, collected_at: T0, digest: 'nope', report: {} }],
      }),
      '/raw_reports/0/digest',
    ],
    [
      report({
        findings: [
          {
            id: 'f-1',
            kind: 'hypothesis',
            severity: 'warning',
            check_ids: ['HC-03.arrays'],
            resource_ids: [],
            symptom: 's',
            impact: 'i',
            evidence_refs: ['ev-1'],
            confidence: { level: 'low', basis: 'one sample' },
            alternatives: [],
            next_check: '',
            proposed_action: null,
          },
        ],
      }),
      '/findings/0',
    ],
    [report({ human_readable: 42 }), '/human_readable'],
    [report({ scope: undefined }), ''],
  ])('reports schema errors with a path (%#)', (bad, pathNeedle) => {
    const v = validateReportShape(bad, AGENTIC_CATALOG);
    expect(v.schema_errors.length).toBeGreaterThan(0);
    expect(v.schema_errors.map((e) => e.path).join('\n')).toContain(pathNeedle);
    expect(v.computed).toBeNull();
  });

  it('reports dangling references with their path', () => {
    const v = validateReportShape(
      report({
        checks: [check('HC-03.arrays', { evidence_refs: ['ev-9'] }), check('HC-99.nope')],
        findings: [
          {
            id: 'f-1',
            kind: 'observation',
            severity: 'warning',
            check_ids: ['HC-77.x'],
            resource_ids: ['arr-1'],
            symptom: 's',
            impact: 'i',
            evidence_refs: ['ev-1', 'ev-17'],
            confidence: { level: 'high', basis: 'two sources' },
            alternatives: [],
            next_check: 'n',
            proposed_action: null,
          },
        ],
        not_checked: [{ check_id: 'HC-88.zzz', reason: 'r' }],
      }),
      AGENTIC_CATALOG,
    );
    expect(v.schema_errors).toEqual([]);
    expect(v.reference_errors).toEqual([
      { path: '/checks/0/evidence_refs/0', ref: 'ev-9', message: 'unknown evidence id' },
      { path: '/checks/1/id', ref: 'HC-99.nope', message: 'unknown check id' },
      { path: '/findings/0/check_ids/0', ref: 'HC-77.x', message: 'unknown check id' },
      { path: '/findings/0/evidence_refs/1', ref: 'ev-17', message: 'unknown evidence id' },
      { path: '/not_checked/0/check_id', ref: 'HC-88.zzz', message: 'unknown check id' },
    ]);
  });
});

describe('computeVerdict (spec §11.3)', () => {
  const mandatory = new Set(mandatoryFor('node'));
  const all = (mutate: (c: ReportCheck) => ReportCheck) =>
    mandatoryFor('node').map((id) => mutate(check(id)));
  const verdict = (checks: ReportCheck[], declaredAbsent: string[] = []) =>
    computeVerdict(checks, mandatory, declaredAbsent, 'node');

  it('every mandatory row passing is ok and complete', () => {
    expect(verdict(all((c) => c))).toEqual({
      health_status: 'ok',
      coverage_status: 'complete',
      rewritten_to_unknown: [],
    });
  });

  it('a critical fail is critical; a plain fail degraded; a warn warning — regardless of other rows', () => {
    const critical = all((c) =>
      c.id === 'HC-03.arrays' ? { ...c, outcome: 'fail', severity: 'critical' } : c,
    );
    expect(verdict(critical).health_status).toBe('critical');
    const degraded = all((c) =>
      c.id === 'HC-03.arrays' ? { ...c, outcome: 'fail', severity: 'degraded' } : c,
    );
    expect(verdict(degraded).health_status).toBe('degraded');
    const warning = all((c) =>
      c.id === 'HC-05.filesystems' ? { ...c, outcome: 'warn', severity: 'warning' } : c,
    );
    expect(verdict(warning).health_status).toBe('warning');
    // AC-01: the RAID failure survives missing data elsewhere
    const mixed = all((c) => {
      if (c.id === 'HC-03.arrays') return { ...c, outcome: 'fail', severity: 'critical' };
      if (c.id === 'HC-08.host-services') return { ...c, outcome: 'unknown' };
      return c;
    });
    expect(verdict(mixed)).toEqual({
      health_status: 'critical',
      coverage_status: 'partial',
      rewritten_to_unknown: [],
    });
  });

  it('an unknown mandatory row makes coverage partial and health unknown when nothing failed (AC-02)', () => {
    const one = all((c) => (c.id === 'HC-01.agent-trust' ? { ...c, outcome: 'unknown' } : c));
    expect(verdict(one)).toEqual({
      health_status: 'unknown',
      coverage_status: 'partial',
      rewritten_to_unknown: [],
    });
    // a mandatory row that is simply missing counts as unknown too
    const missing = all((c) => c).filter((c) => c.id !== 'HC-02.drift');
    expect(verdict(missing).coverage_status).toBe('partial');
    expect(verdict(missing).health_status).toBe('unknown');
    expect(verdict([]).coverage_status).toBe('none');
    expect(verdict([]).health_status).toBe('unknown');
    expect(verdict(all((c) => ({ ...c, outcome: 'unknown' }))).coverage_status).toBe('none');
  });

  it('not_applicable needs a declared-absent component or a scope exclusion in its reason (REPORT-02)', () => {
    const bare = all((c) =>
      c.id === 'HC-06.nfs-exports' ? { ...c, outcome: 'not_applicable', reason: 'no shares' } : c,
    );
    expect(verdict(bare)).toEqual({
      health_status: 'unknown',
      coverage_status: 'partial',
      rewritten_to_unknown: ['HC-06.nfs-exports'],
    });
    const cited = all((c) =>
      c.id === 'HC-06.nfs-exports'
        ? { ...c, outcome: 'not_applicable', reason: 'nfs is declared absent by the inventory' }
        : c,
    );
    expect(verdict(cited, ['nfs'])).toEqual({
      health_status: 'ok',
      coverage_status: 'complete',
      rewritten_to_unknown: [],
    });
    // the component must actually be declared absent, naming it is not enough
    expect(verdict(cited, []).rewritten_to_unknown).toEqual(['HC-06.nfs-exports']);
    const excluded = all((c) =>
      c.id === 'HC-06.nfs-exports'
        ? { ...c, outcome: 'not_applicable', reason: 'shares are out of scope for this run' }
        : c,
    );
    expect(verdict(excluded).coverage_status).toBe('complete');
  });

  it('service_path scope makes HC-11.client-path mandatory, so v1 coverage is partial (AC-08)', () => {
    const sp = new Set(mandatoryFor('service_path'));
    expect(sp.has('HC-11.client-path')).toBe(true);
    const checks = mandatoryFor('service_path')
      .filter((id) => id !== 'HC-11.client-path')
      .map((id) => check(id));
    expect(computeVerdict(checks, sp, [], 'service_path')).toEqual({
      health_status: 'unknown',
      coverage_status: 'partial',
      rewritten_to_unknown: [],
    });
  });
});

describe('validateReportShape status errors (spec §11.2, §11.3 step 4)', () => {
  it('a declared status that disagrees with the computed one is an error, and the computed one is reported', () => {
    const v = validateReportShape(
      withChecks((c) =>
        c.id === 'HC-03.arrays' ? { ...c, outcome: 'fail', severity: 'degraded' } : c,
      ),
      AGENTIC_CATALOG,
    );
    expect(v.computed).toEqual({ health_status: 'degraded', coverage_status: 'complete' });
    expect(v.status_errors).toEqual(["health_status 'ok' does not match computed 'degraded'"]);
  });

  it('run_status failed or cancelled cannot coexist with health_status ok', () => {
    const v = validateReportShape(report({ run_status: 'failed' }), AGENTIC_CATALOG);
    expect(v.status_errors).toEqual(["run_status 'failed' cannot coexist with health_status 'ok'"]);
  });

  it('a mandatory flag that disagrees with the catalog is an error', () => {
    const v = validateReportShape(
      withChecks(
        (c) => (c.id === 'HC-03.arrays' ? { ...c, mandatory: false } : c),
        [check('HC-09.trend', { mandatory: true, outcome: 'unknown' })],
      ),
      AGENTIC_CATALOG,
    );
    expect(v.status_errors).toEqual([
      "check 'HC-03.arrays' is mandatory for scope 'node' but the report says mandatory: false",
      "check 'HC-09.trend' is not mandatory for scope 'node' but the report says mandatory: true",
    ]);
  });
});
