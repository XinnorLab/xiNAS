import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestOf } from '../../api/health/run-ledger.js';
import { AGENTIC_CATALOG } from '../../lib/health/agentic-catalog.js';
import { REPORT_SCHEMA } from '../../lib/health/report-validate.js';
import { VIEWER_TOKEN, buildTestApp } from './_helpers.js';

const T0 = '2026-09-09T10:00:00.000Z';
const mandatoryNode = AGENTIC_CATALOG.checks
  .filter((c) => c.mandatory_for.includes('node'))
  .map((c) => c.id);

/** A valid node-scope report around one raw `health.check` result. */
function buildReport(
  runId: string,
  raw: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    report_schema_version: '1',
    run: {
      run_id: runId,
      started_at: T0,
      completed_at: T0,
      principal: 'viewer:test',
      node: { hostname: 'h', controller_id: 'c', xinas_version: '1.0.0' },
      versions: {
        prompt: '1.0.0',
        template_sha256: 'b'.repeat(64),
        policy: '1',
        catalog: '1',
        report_schema: '1',
      },
      execution: {
        mode: 'sequential',
        roles_ran: [],
        model: null,
        budget: { tool_calls: 2, elapsed_seconds: 1 },
        errors: [],
      },
    },
    scope: {
      kind: 'node',
      targets: [],
      client_path_in_scope: false,
      time_window: { requested_seconds: 3600, covered: { from: T0, to: T0 } },
      declared_absent: [],
    },
    run_status: 'completed',
    health_status: 'ok',
    coverage_status: 'complete',
    raw_reports: [
      {
        tool: 'health.check',
        args: { profile: 'quick' },
        collected_at: (raw.completed_at as string) ?? T0,
        digest: digestOf(raw),
        report: raw,
      },
    ],
    checks: mandatoryNode.map((id) => ({
      id,
      outcome: 'pass',
      severity: null,
      reason: 'ok',
      mandatory: true,
      evidence_refs: ['ev-1'],
    })),
    findings: [],
    evidence_manifest: [
      { id: 'ev-1', source: 'health.check', collected_at: T0, observed_at: null, stale: false },
    ],
    not_checked: [],
    human_readable: 'ok',
    ...over,
  };
}

/** S19c T6 — spec §11.2, §11.4: the report schema route and the validator with ledger integrity. */
describe('health report schema and validation (S19c)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const get = (path: string) => request(setup.app).get(path).set('Authorization', VIEWER_TOKEN);
  const validate = (body: unknown) =>
    request(setup.app)
      .post('/api/v1/health/report/validate')
      .set('Authorization', VIEWER_TOKEN)
      .send(body as Record<string, unknown>);

  /** Mint a run and take one quick report under it. */
  async function runAndReport(): Promise<{ runId: string; raw: Record<string, unknown> }> {
    const ctx = await get('/api/v1/health/context');
    const runId = ctx.body.result.run.run_id as string;
    const health = await get(`/api/v1/health?profile=quick&run_id=${runId}`);
    expect(health.status).toBe(200);
    return { runId, raw: health.body.result as Record<string, unknown> };
  }

  it('GET /health/report-schema serves the v1 schema verbatim to a viewer', async () => {
    const res = await get('/api/v1/health/report-schema');
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(REPORT_SCHEMA);
    expect(res.body.result.properties.report_schema_version.const).toBe('1');
  });

  it('a report whose raw health.check result matches the ledger is verified and valid', async () => {
    const { runId, raw } = await runAndReport();
    const res = await validate(buildReport(runId, raw));
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      valid: true,
      run_id: runId,
      schema_errors: [],
      reference_errors: [],
      integrity: { status: 'verified', checked: 1, mismatches: [] },
      computed: { health_status: 'ok', coverage_status: 'complete' },
      status_errors: [],
      rewritten_to_unknown: [],
      report_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('an edited raw FAIL is a mismatch and the report is invalid (AC-19)', async () => {
    const { runId, raw } = await runAndReport();
    const edited = { ...raw, overall: 'ok', checks: [] };
    const report = buildReport(runId, raw);
    (report.raw_reports[0] as { report: unknown }).report = edited; // digest still claims the original
    const res = await validate(report);
    expect(res.body.result.valid).toBe(false);
    expect(res.body.result.integrity).toEqual({
      status: 'mismatch',
      checked: 1,
      mismatches: [
        {
          raw_report_index: 0,
          reason: 'report_rehash_mismatch',
          expected_digest: digestOf(raw),
          actual_digest: digestOf(edited),
        },
      ],
    });
  });

  it('an invented raw report (consistent digest, never produced) is a mismatch', async () => {
    const { runId, raw } = await runAndReport();
    const invented = { ...raw, overall: 'ok', profile: 'deep' };
    const report = buildReport(runId, raw, {
      raw_reports: [
        {
          tool: 'health.check',
          args: { profile: 'deep' },
          collected_at: T0,
          digest: digestOf(invented),
          report: invented,
        },
      ],
    });
    const res = await validate(report);
    expect(res.body.result.integrity.status).toBe('mismatch');
    expect(res.body.result.integrity.mismatches).toEqual([
      {
        raw_report_index: 0,
        reason: 'not_in_ledger',
        expected_digest: null,
        actual_digest: digestOf(invented),
      },
    ]);
    expect(res.body.result.valid).toBe(false);
  });

  it('reports from tools that do not write the ledger are skipped; an unknown run is unverifiable but still valid', async () => {
    const { runId, raw } = await runAndReport();
    const withExtra = buildReport(runId, raw, {
      raw_reports: [
        ...buildReport(runId, raw).raw_reports,
        {
          tool: 'arrays.list',
          args: {},
          collected_at: T0,
          digest: digestOf({ items: [] }),
          report: { items: [] },
        },
      ],
    });
    const ok = await validate(withExtra);
    expect(ok.body.result.integrity).toEqual({ status: 'verified', checked: 1, mismatches: [] });
    expect(ok.body.result.valid).toBe(true);

    const gone = await validate(buildReport('00000000-0000-4000-8000-000000000000', raw));
    expect(gone.body.result.integrity).toEqual({
      status: 'unverifiable',
      checked: 0,
      mismatches: [],
    });
    expect(gone.body.result.valid).toBe(true);
    expect(gone.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
  });

  it('a malformed body is 200 with valid: false and the schema errors; the verdict is not computed', async () => {
    const res = await validate({ report_schema_version: '1' });
    expect(res.status).toBe(200);
    expect(res.body.result.valid).toBe(false);
    expect(res.body.result.schema_errors.length).toBeGreaterThan(0);
    expect(res.body.result.computed).toBeNull();
    expect(res.body.result.integrity).toEqual({
      status: 'unverifiable',
      checked: 0,
      mismatches: [],
    });
    expect(res.body.result.run_id).toBeNull();
    const notObject = await request(setup.app)
      .post('/api/v1/health/report/validate')
      .set('Authorization', VIEWER_TOKEN)
      .send([1, 2] as unknown as Record<string, unknown>);
    expect(notObject.status).toBe(400);
  });

  it('a status the model got wrong is reported against the computed verdict', async () => {
    const { runId, raw } = await runAndReport();
    const report = buildReport(runId, raw);
    (report.checks[0] as { outcome: string; severity: string | null }).outcome = 'fail';
    (report.checks[0] as { outcome: string; severity: string | null }).severity = 'critical';
    const res = await validate(report);
    expect(res.body.result.valid).toBe(false);
    expect(res.body.result.computed).toEqual({
      health_status: 'critical',
      coverage_status: 'complete',
    });
    expect(res.body.result.status_errors).toEqual([
      "health_status 'ok' does not match computed 'critical'",
    ]);
    expect(res.body.result.integrity.status).toBe('verified');
  });
});
