import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestOf } from '../../api/health/run-ledger.js';
import { AGENTIC_CATALOG } from '../../lib/health/agentic-catalog.js';
import { REPORT_SCHEMA } from '../../lib/health/report-validate.js';
import { OPERATOR_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

const T0 = '2026-09-09T10:00:00.000Z';
const mandatoryFor = (kind: 'node' | 'service_path'): string[] =>
  AGENTIC_CATALOG.checks.filter((c) => c.mandatory_for.includes(kind)).map((c) => c.id);
const mandatoryNode = mandatoryFor('node');

/**
 * What the evidence floor (§11.3 step 5) forces on this test node. Its quick
 * report says `agent.connectivity: critical` (no agent is running) and
 * `skipped` for every other check, so a row fed by those raw results may not
 * claim `pass` — a report that does is exactly the F01 defect.
 */
const FLOORED: Record<string, { outcome: string; severity: string | null }> = {
  'HC-01.agent-trust': { outcome: 'fail', severity: 'critical' },
  'HC-02.drift': { outcome: 'unknown', severity: null },
  'HC-03.arrays': { outcome: 'unknown', severity: null },
  'HC-05.filesystems': { outcome: 'unknown', severity: null },
  'HC-06.nfs-service': { outcome: 'unknown', severity: null },
  'HC-06.nfs-exports': { outcome: 'unknown', severity: null },
  'HC-07.network-rdma': { outcome: 'unknown', severity: null },
  'HC-08.host-services': { outcome: 'unknown', severity: null },
};

/** The identity `buildReport`'s `run` block claims — F03: must match the ledger entry. */
interface RunIdentity {
  principal: string;
  versions: Record<string, unknown>;
}

const scopeBlock = (kind: 'node' | 'service_path', declared_absent: string[] = []) => ({
  kind,
  targets: [],
  client_path_in_scope: kind === 'service_path',
  time_window: { requested_seconds: 3600, covered: { from: T0, to: T0 } },
  declared_absent,
});

const checkRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  outcome: 'pass',
  severity: null,
  reason: 'ok',
  mandatory: true,
  evidence_refs: ['ev-1'],
  ...over,
});

/** A valid node-scope report around one raw `health.check` result; every row `pass`. */
function buildReport(
  runId: string,
  raw: Record<string, unknown>,
  over: Record<string, unknown> = {},
  identity: RunIdentity,
) {
  return {
    report_schema_version: '1',
    run: {
      run_id: runId,
      started_at: T0,
      completed_at: T0,
      principal: identity.principal,
      node: { hostname: 'h', controller_id: 'c', xinas_version: '1.0.0' },
      versions: identity.versions,
      execution: {
        mode: 'sequential',
        roles_ran: [],
        model: null,
        budget: { tool_calls: 2, elapsed_seconds: 1 },
        errors: [],
      },
    },
    scope: scopeBlock('node'),
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
    checks: mandatoryNode.map((id) => checkRow(id)),
    findings: [],
    evidence_manifest: [
      { id: 'ev-1', source: 'health.check', collected_at: T0, observed_at: null, stale: false },
    ],
    not_checked: [],
    human_readable: 'ok',
    ...over,
  };
}

/** The same report with every row set to what the floor allows: a valid report. */
function honestReport(
  runId: string,
  raw: Record<string, unknown>,
  identity: RunIdentity,
  over: Record<string, unknown> = {},
) {
  return buildReport(
    runId,
    raw,
    {
      health_status: 'critical',
      coverage_status: 'partial',
      checks: mandatoryNode.map((id) =>
        checkRow(id, {
          outcome: FLOORED[id]?.outcome ?? 'pass',
          severity: FLOORED[id]?.severity ?? null,
        }),
      ),
      ...over,
    },
    identity,
  );
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

  /**
   * Mint a run and take one quick report under it. `identity` is the
   * `run.principal` / `run.versions` `GET /health/context` minted this run
   * with — F03: a report claiming anything else fails run-identity checks.
   */
  async function runAndReport(): Promise<{
    runId: string;
    raw: Record<string, unknown>;
    identity: RunIdentity;
  }> {
    const ctx = await get('/api/v1/health/context');
    const run = ctx.body.result.run as { run_id: string; principal: string; versions: unknown };
    const health = await get(`/api/v1/health?profile=quick&run_id=${run.run_id}`);
    expect(health.status).toBe(200);
    return {
      runId: run.run_id,
      raw: health.body.result as Record<string, unknown>,
      identity: { principal: run.principal, versions: run.versions as Record<string, unknown> },
    };
  }

  it('GET /health/report-schema serves the v1 schema verbatim to a viewer', async () => {
    const res = await get('/api/v1/health/report-schema');
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(REPORT_SCHEMA);
    expect(res.body.result.properties.report_schema_version.const).toBe('1');
  });

  it('the ledger records what health.context proved absent about the run (§6.3)', async () => {
    const ctx = await get('/api/v1/health/context');
    const run = ctx.body.result.run as { run_id: string };
    const topology = ctx.body.result.topology as { declared_absent: string[] };
    const entry = setup.ctx.healthPrompt?.ledger.get(run.run_id);
    expect(entry?.declared_absent).toEqual(topology.declared_absent);
  });

  it('a report that matches the ledger and the evidence it carries is verified and valid', async () => {
    const { runId, raw, identity } = await runAndReport();
    const res = await validate(honestReport(runId, raw, identity));
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      valid: true,
      run_id: runId,
      schema_errors: [],
      reference_errors: [],
      integrity: { status: 'verified', checked: 1, mismatches: [], omitted: [] },
      computed: { health_status: 'critical', coverage_status: 'partial' },
      adjustments: [],
      status_errors: [],
      rewritten_to_unknown: [],
      report_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('F01: a verified critical raw RAID result cannot coexist with a pass row', async () => {
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/arr-data', {
      kind: 'XiraidArray',
      id: 'arr-data',
      spec: {},
      status: { state: 'degraded' },
    });
    const { runId, raw, identity } = await runAndReport();
    const rawChecks = raw.checks as Array<{ id: string; status: string }>;
    expect(rawChecks.find((c) => c.id === 'xiraid.arrays')?.status).toBe('critical');
    const res = await validate(buildReport(runId, raw, {}, identity));
    expect(res.body.result.integrity).toMatchObject({ status: 'verified', checked: 1 });
    expect(res.body.result.computed).toEqual({
      health_status: 'critical',
      coverage_status: 'partial',
    });
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({
        id: 'HC-03.arrays',
        from: 'pass',
        to: 'fail',
        severity: 'critical',
        reason: 'floor',
      }),
    );
    expect(res.body.result.status_errors).toContainEqual(
      expect.stringContaining("check 'HC-03.arrays' outcome 'pass' is below the evidence floor"),
    );
    expect(res.body.result.valid).toBe(false);
  });

  it('F01b: dropping every raw report is an omission, and stale evidence cannot carry a pass', async () => {
    const { runId, raw, identity } = await runAndReport();
    const res = await validate(
      buildReport(
        runId,
        raw,
        {
          raw_reports: [],
          evidence_manifest: [
            {
              id: 'ev-1',
              source: 'health.check',
              collected_at: T0,
              observed_at: null,
              stale: true,
            },
          ],
        },
        identity,
      ),
    );
    expect(res.body.result.integrity.status).toBe('mismatch');
    expect(res.body.result.integrity.omitted).toEqual([
      expect.objectContaining({
        tool: 'health.check',
        args_digest: digestOf({ profile: 'quick' }),
      }),
    ]);
    expect(res.body.result.computed).toEqual({
      health_status: 'unknown',
      coverage_status: 'none',
    });
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({ id: 'HC-03.arrays', to: 'unknown', reason: 'stale_evidence' }),
    );
    expect(res.body.result.valid).toBe(false);
  });

  it('F02: a no_source row cannot be pass; service_path coverage stays partial', async () => {
    const { runId, raw, identity } = await runAndReport();
    const res = await validate(
      buildReport(
        runId,
        raw,
        {
          scope: scopeBlock('service_path'),
          checks: mandatoryFor('service_path').map((id) => checkRow(id)),
        },
        identity,
      ),
    );
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({ id: 'HC-11.client-path', to: 'unknown', reason: 'no_source' }),
    );
    expect(res.body.result.computed).toEqual({
      health_status: 'critical',
      coverage_status: 'partial',
    });
    expect(res.body.result.valid).toBe(false);
  });

  it('F02b: a self-declared absence and a scope-exclusion phrase do not bypass unknown', async () => {
    const { runId, raw, identity } = await runAndReport();
    const res = await validate(
      buildReport(
        runId,
        raw,
        {
          scope: scopeBlock('node', ['raid']),
          checks: mandatoryNode.map((id) =>
            checkRow(id, {
              outcome: 'not_applicable',
              reason: id === 'HC-03.arrays' ? 'raid absent' : 'scope exclusion',
            }),
          ),
        },
        identity,
      ),
    );
    expect(res.body.result.status_errors).toContainEqual(
      expect.stringContaining("scope.declared_absent 'raid' is not proven"),
    );
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({ id: 'HC-03.arrays', reason: 'declared_absent_unproven' }),
    );
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({ id: 'HC-05.filesystems', reason: 'not_applicable_uncited' }),
    );
    // the floor still applies to a row rewritten to unknown
    expect(res.body.result.computed.health_status).toBe('critical');
    expect(res.body.result.valid).toBe(false);
  });

  it('an edited raw FAIL is a mismatch and the report is invalid (AC-19)', async () => {
    const { runId, raw, identity } = await runAndReport();
    const edited = { ...raw, overall: 'ok', checks: [] };
    const report = buildReport(runId, raw, {}, identity);
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
      omitted: [],
    });
    // F01b: the tampered source compromises every check it feeds
    expect(res.body.result.adjustments).toContainEqual(
      expect.objectContaining({
        id: 'HC-03.arrays',
        to: 'unknown',
        reason: 'floor',
        detail: 'health.check: raw report omitted or tampered',
      }),
    );
  });

  it('an invented raw report (consistent digest, never produced) is a mismatch', async () => {
    const { runId, raw, identity } = await runAndReport();
    const invented = { ...raw, overall: 'ok', profile: 'deep' };
    const report = buildReport(
      runId,
      raw,
      {
        raw_reports: [
          {
            tool: 'health.check',
            args: { profile: 'deep' },
            collected_at: T0,
            digest: digestOf(invented),
            report: invented,
          },
        ],
      },
      identity,
    );
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
    // and the quick report xiNAS really produced is missing from the report
    expect(res.body.result.integrity.omitted).toEqual([
      {
        tool: 'health.check',
        args_digest: digestOf({ profile: 'quick' }),
        collected_at: expect.any(String),
      },
    ]);
    expect(res.body.result.valid).toBe(false);
  });

  it('reports from tools that do not write the ledger are skipped; an unknown run is unverifiable but still valid', async () => {
    const { runId, raw, identity } = await runAndReport();
    const withExtra = honestReport(runId, raw, identity, {
      raw_reports: [
        ...buildReport(runId, raw, {}, identity).raw_reports,
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
    expect(ok.body.result.integrity).toEqual({
      status: 'verified',
      checked: 1,
      mismatches: [],
      omitted: [],
    });
    expect(ok.body.result.valid).toBe(true);

    const gone = await validate(
      honestReport('00000000-0000-4000-8000-000000000000', raw, identity),
    );
    expect(gone.body.result.integrity).toEqual({
      status: 'unverifiable',
      checked: 0,
      mismatches: [],
      omitted: [],
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
      omitted: [],
    });
    expect(res.body.result.adjustments).toEqual([]);
    expect(res.body.result.run_id).toBeNull();
    const notObject = await request(setup.app)
      .post('/api/v1/health/report/validate')
      .set('Authorization', VIEWER_TOKEN)
      .send([1, 2] as unknown as Record<string, unknown>);
    expect(notObject.status).toBe(400);
  });

  it('a status the model got wrong is reported against the computed verdict', async () => {
    const { runId, raw, identity } = await runAndReport();
    const res = await validate(honestReport(runId, raw, identity, { health_status: 'ok' }));
    expect(res.body.result.valid).toBe(false);
    expect(res.body.result.computed).toEqual({
      health_status: 'critical',
      coverage_status: 'partial',
    });
    expect(res.body.result.status_errors).toEqual([
      "health_status 'ok' does not match computed 'critical'",
    ]);
    expect(res.body.result.integrity.status).toBe('verified');
  });

  it('F03: another principal cannot validate against, or append to, a run it did not start', async () => {
    const { runId, raw, identity } = await runAndReport(); // mints + records as viewer
    const report = honestReport(runId, raw, identity);
    const read = await request(setup.app)
      .get(`/api/v1/health?profile=quick&run_id=${runId}`)
      .set('Authorization', OPERATOR_TOKEN);
    expect(read.status).toBe(200);
    expect(read.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
    const ledger = setup.ctx.healthPrompt?.ledger;
    expect(ledger?.get(runId)?.reports).toHaveLength(1);
    const res = await request(setup.app)
      .post('/api/v1/health/report/validate')
      .set('Authorization', OPERATOR_TOKEN)
      .send(report);
    expect(res.body.result.integrity.status).toBe('unverifiable');
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
  });

  it('F03: claimed versions and principal must match the ledger', async () => {
    const { runId, raw, identity } = await runAndReport();
    const tampered = structuredClone(honestReport(runId, raw, identity));
    tampered.run.principal = 'invented:identity';
    (tampered.run.versions as Record<string, unknown>).prompt = '999.0.0';
    (tampered.run.versions as Record<string, unknown>).template_sha256 = '0'.repeat(64);
    const res = await validate(tampered);
    expect(res.body.result.valid).toBe(false);
    expect(res.body.result.integrity.status).toBe('verified');
    expect(res.body.result.status_errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("run.principal 'invented:identity'"),
        expect.stringContaining("run.versions.prompt '999.0.0'"),
        expect.stringContaining('run.versions.template_sha256'),
      ]),
    );
  });
});
