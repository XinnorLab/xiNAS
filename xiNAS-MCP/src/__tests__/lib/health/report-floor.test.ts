import { describe, expect, it } from 'vitest';
import { AGENTIC_CATALOG } from '../../../lib/health/agentic-catalog.js';
import { computeFloors, levelOf, outcomeAt } from '../../../lib/health/report-floor.js';
import type { AgenticReport } from '../../../lib/health/report-validate.js';

/**
 * S19 §11.3 steps 5–6 (validation F01): what the raw reports a report
 * carries force on every check row that consumes them.
 */

const T = '2026-09-10T10:00:00.000Z';
const quick = (checks: Array<Record<string, unknown>>) => ({
  tool: 'health.check',
  args: { profile: 'quick' },
  collected_at: T,
  digest: `sha256:${'0'.repeat(64)}`,
  report: { profile: 'quick', overall: 'ok', checks },
});
const report = (raw: unknown[]): AgenticReport =>
  ({
    report_schema_version: '1',
    run: { run_id: 'r', principal: 'op:a', versions: {} },
    scope: { kind: 'node', declared_absent: [] },
    run_status: 'completed',
    health_status: 'ok',
    coverage_status: 'complete',
    raw_reports: raw,
    checks: [],
    findings: [],
    evidence_manifest: [],
    not_checked: [],
  }) as unknown as AgenticReport;
const all = (n: number) => new Set(Array.from({ length: n }, (_, i) => i));

describe('computeFloors (spec §11.3 steps 5–6)', () => {
  it('F01: a critical raw xiraid.arrays floors HC-03.arrays to fail/critical', () => {
    const floors = computeFloors(
      report([
        quick([
          {
            id: 'xiraid.arrays',
            status: 'critical',
            evidence: { collection: { status: 'success' } },
          },
        ]),
      ]),
      AGENTIC_CATALOG,
      { usableRawReports: all(1), compromisedTools: new Set() },
    );
    expect(floors.get('HC-03.arrays')).toEqual({
      level: 4,
      detail: 'health.check xiraid.arrays: critical',
    });
    expect(floors.has('HC-06.nfs-service')).toBe(false);
  });

  it('AC-03: a raw degraded caused by a collection failure floors to unknown, not fail', () => {
    const floors = computeFloors(
      report([
        quick([
          {
            id: 'xiraid.license',
            status: 'degraded',
            evidence: { collection: { status: 'timeout', code: 'TIMEOUT' } },
          },
        ]),
      ]),
      AGENTIC_CATALOG,
      { usableRawReports: all(1), compromisedTools: new Set() },
    );
    expect(floors.get('HC-03.arrays')?.level).toBe(1);
  });

  it('a raw skipped floors to unknown; baseline FAIL floors to fail/critical; a probe failure to fail/degraded', () => {
    const baseline = {
      tool: 'health.baseline',
      args: { profile: 'standard', max_age_s: 0 },
      collected_at: T,
      digest: `sha256:${'1'.repeat(64)}`,
      report: {
        collection: { status: 'success' },
        report: { checks: [{ section: 'Kernel', name: 'thp', status: 'FAIL' }] },
      },
    };
    const probe = {
      tool: 'health.probe.run',
      args: { probe: 'fs_io', target: 'fs-1', timeout_s: 20 },
      collected_at: T,
      digest: `sha256:${'2'.repeat(64)}`,
      report: { probe: 'fs_io', ok: false, cleanup: { status: 'clean' } },
    };
    const floors = computeFloors(
      report([
        quick([
          { id: 'nfs.server', status: 'skipped', evidence: { collection: { status: 'success' } } },
        ]),
        baseline,
        probe,
      ]),
      AGENTIC_CATALOG,
      { usableRawReports: all(3), compromisedTools: new Set() },
    );
    expect(floors.get('HC-06.nfs-service')?.level).toBe(1);
    expect(floors.get('HC-02.baseline-expectations')?.level).toBe(4);
    expect(floors.get('HC-08.host-services')?.level).toBe(4);
    expect(floors.get('HC-12.active-probe')?.level).toBe(3);
  });

  it('a baseline whose collection failed floors every baseline input to unknown', () => {
    const baseline = {
      tool: 'health.baseline',
      args: { profile: 'standard', max_age_s: 0 },
      collected_at: T,
      digest: `sha256:${'3'.repeat(64)}`,
      report: { collection: { status: 'error' }, report: null },
    };
    const floors = computeFloors(report([baseline]), AGENTIC_CATALOG, {
      usableRawReports: all(1),
      compromisedTools: new Set(),
    });
    expect(floors.get('HC-02.baseline-expectations')).toEqual({
      level: 1,
      detail: 'health.baseline: collection failed',
    });
    expect(floors.get('HC-04.drives')?.level).toBe(1);
    // a row with no baseline input is untouched
    expect(floors.has('HC-01.agent-trust')).toBe(false);
  });

  it('F01b: a compromised tool floors every check it feeds to unknown; a tampered raw report is ignored', () => {
    const floors = computeFloors(
      report([
        quick([
          {
            id: 'xiraid.arrays',
            status: 'critical',
            evidence: { collection: { status: 'success' } },
          },
        ]),
      ]),
      AGENTIC_CATALOG,
      { usableRawReports: new Set(), compromisedTools: new Set(['health.check']) },
    );
    expect(floors.get('HC-03.arrays')).toEqual({
      level: 1,
      detail: 'health.check: raw report omitted or tampered',
    });
    expect(floors.get('HC-05.filesystems')?.level).toBe(1);
    expect(floors.has('HC-02.baseline-expectations')).toBe(false);
  });

  it('an ok raw row and an unread raw report contribute nothing', () => {
    const ok = report([
      quick([
        { id: 'xiraid.arrays', status: 'ok', evidence: { collection: { status: 'success' } } },
      ]),
    ]);
    expect(
      computeFloors(ok, AGENTIC_CATALOG, {
        usableRawReports: all(1),
        compromisedTools: new Set(),
      }).size,
    ).toBe(0);
    // the same raw report, rejected by integrity: not read at all
    expect(
      computeFloors(
        report([
          quick([
            {
              id: 'xiraid.arrays',
              status: 'critical',
              evidence: { collection: { status: 'success' } },
            },
          ]),
        ]),
        AGENTIC_CATALOG,
        { usableRawReports: new Set(), compromisedTools: new Set() },
      ).size,
    ).toBe(0);
  });
});

/**
 * `raw_reports[].report` is `true` in the schema: every shape below passes
 * Ajv, so the floor parser must be total. A crash here is a 500 on
 * `POST /health/report/validate` instead of a verdict (fix round 1, F01).
 */
describe('computeFloors over raw JSON the schema permits', () => {
  const floorsOf = (raw: unknown[]) =>
    computeFloors(report(raw), AGENTIC_CATALOG, {
      usableRawReports: all(raw.length),
      compromisedTools: new Set(),
    });
  const baseline = (body: unknown) => ({
    tool: 'health.baseline',
    args: { profile: 'standard', max_age_s: 0 },
    collected_at: T,
    digest: `sha256:${'4'.repeat(64)}`,
    report: body,
  });

  it('skips a null element in a raw health.check checks[]', () => {
    const bad = [null] as unknown as Array<Record<string, unknown>>;
    expect(floorsOf([quick(bad)]).size).toBe(0);
    // the sound rows next to it are still read
    const mixed = [
      null,
      { id: 'xiraid.arrays', status: 'critical', evidence: { collection: { status: 'success' } } },
    ] as unknown as Array<Record<string, unknown>>;
    expect(floorsOf([quick(mixed)]).get('HC-03.arrays')?.level).toBe(4);
  });

  it('skips a baseline whose checks is not an array', () => {
    const floors = floorsOf([
      baseline({ collection: { status: 'success' }, report: { checks: 'oops' } }),
    ]);
    expect(floors.size).toBe(0);
  });

  it('skips a null baseline row', () => {
    const floors = floorsOf([
      baseline({ collection: { status: 'success' }, report: { checks: [null] } }),
    ]);
    expect(floors.size).toBe(0);
  });

  it('treats a non-object evidence, collection, report or cleanup as absent', () => {
    const odd = [{ id: 'xiraid.arrays', status: 'critical', evidence: 'nope' }] as unknown as Array<
      Record<string, unknown>
    >;
    expect(floorsOf([quick(odd)]).get('HC-03.arrays')?.level).toBe(4);
    expect(floorsOf([baseline('nope')]).size).toBe(0);
    expect(
      floorsOf([baseline({ collection: 'nope', report: null })]).get('HC-04.drives')?.level,
    ).toBe(1);
    const probe = {
      tool: 'health.probe.run',
      args: { probe: 'fs_io', target: 'fs-1', timeout_s: 20 },
      collected_at: T,
      digest: `sha256:${'5'.repeat(64)}`,
      report: { probe: 'fs_io', ok: true, cleanup: 'nope' },
    };
    expect(floorsOf([probe]).size).toBe(0);
  });
});

describe('levelOf / outcomeAt (the §11.3 step 5 ordering)', () => {
  it('orders pass < unknown < warn = fail/warning < fail/degraded < fail/critical', () => {
    expect(levelOf('pass', null)).toBe(0);
    expect(levelOf('not_applicable', null)).toBe(0);
    expect(levelOf('unknown', null)).toBe(1);
    expect(levelOf('warn', 'warning')).toBe(2);
    expect(levelOf('fail', 'warning')).toBe(2);
    expect(levelOf('fail', null)).toBe(2);
    expect(levelOf('fail', 'degraded')).toBe(3);
    expect(levelOf('fail', 'critical')).toBe(4);
  });

  it('maps a level back to the outcome it forces', () => {
    expect(outcomeAt(0)).toEqual({ outcome: 'pass', severity: null });
    expect(outcomeAt(1)).toEqual({ outcome: 'unknown', severity: null });
    expect(outcomeAt(2)).toEqual({ outcome: 'warn', severity: 'warning' });
    expect(outcomeAt(3)).toEqual({ outcome: 'fail', severity: 'degraded' });
    expect(outcomeAt(4)).toEqual({ outcome: 'fail', severity: 'critical' });
  });
});
