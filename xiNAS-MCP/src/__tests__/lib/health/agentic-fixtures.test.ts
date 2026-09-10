import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Integrity,
  UNVERIFIABLE,
  checkIntegrity,
  floorInputFrom,
} from '../../../api/health/report-integrity.js';
import { type RunEntry, RunLedger, digestOf } from '../../../api/health/run-ledger.js';
import { CATALOG } from '../../../api/mcp/catalog.js';
import { AGENTIC_CATALOG, type Scope } from '../../../lib/health/agentic-catalog.js';
import {
  type ShapeVerdict,
  evaluateReport,
  isReportValid,
} from '../../../lib/health/report-validate.js';

/**
 * S19d — the agentic acceptance fixtures (requirements §10, spec §15/§16).
 *
 * Each JSON file under `src/__tests__/fixtures/agentic/` is one anonymized
 * incident: the raw reports xiNAS produced for the run (`ledger`), the
 * calls the model made (`tool_log`), the model's report (`report`) and
 * what the validator and the tool log must say about it (`expected`).
 * The runner asserts semantics — verdict, integrity, outcomes, finding
 * kinds and references, forbidden calls — never prose. See the README
 * next to the fixtures for the format and the three placeholders.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../../fixtures/agentic');
const REQUIRED = [
  'AC-01',
  'AC-02',
  'AC-03',
  'AC-04',
  'AC-05',
  'AC-06',
  'AC-08',
  'AC-09',
  'AC-10',
  'AC-11',
  'AC-13',
  'AC-18',
  'AC-19',
  'AC-20',
];

const NOW_MS = Date.parse('2026-09-09T10:30:00.000Z');
const T0 = '2026-09-09T10:00:00.000Z';
const T1 = '2026-09-09T10:03:00.000Z';
const VERSIONS = {
  prompt: '1.0.0',
  template_sha256: 'b'.repeat(64),
  policy: '1',
  catalog: '1',
  report_schema: '1',
  server: '1.0.0',
};
const LIMITS = {
  analysis_seconds: 180,
  tool_calls: 40,
  roles: 3,
  active_probes_per_node: 1 as const,
  probes_per_run: 4,
  retries: 2,
  run_ttl_seconds: 900,
};

type Json = Record<string, unknown>;

interface LedgerItem {
  tool: string;
  args: Json;
  collected_at?: string;
  report: unknown;
}

interface ToolCall {
  tool: string;
  args?: Json;
}

interface ForbiddenCall {
  tool?: string;
  args?: Json;
}

interface Expected {
  valid: boolean;
  computed: { health_status: string; coverage_status: string } | null;
  integrity: Integrity['status'];
  integrity_reasons?: string[];
  reference_errors?: number;
  status_errors?: number;
  rewritten_to_unknown?: string[];
  /** Rows the verdict raised or rewrote (§11.3 steps 3, 5–8); subset match. */
  adjustments_include?: Array<{ id: string; to: string; reason: string }>;
  run_status?: string;
  checks?: Record<string, string>;
  checks_forbid_outcomes?: { ids: string[]; outcomes: string[] };
  findings?: {
    min?: number;
    kinds_include?: string[];
    resource_ids_include?: string[];
    check_ids_include?: string[];
  };
  not_checked_mentions?: string[];
  not_checked_min?: number;
  evidence_excerpt_includes?: string[];
  forbidden_calls?: ForbiddenCall[];
  tools_from_catalog?: boolean;
  max_calls_per_tool?: number;
  ledger_preserves?: Array<{ key: string; pointer: string; equals: unknown }>;
  execution_roles_ran_length?: number;
  run_ids_differ?: boolean;
}

interface Scenario {
  id: string;
  title: string;
  scope: Scope;
  declared_absent?: string[];
  ledger: Record<string, LedgerItem>;
  tool_log: ToolCall[];
  report: Json;
  expected: Expected;
  /** The same report with an overlay (top-level replace; checks merged by id) and its own expectation. */
  variant_uncited?: { report: Json; expected: Expected };
  /** An earlier run of the same node (AC-20). */
  previous?: Scenario;
}

interface Evaluated {
  entry: RunEntry;
  report: Json;
  shape: ShapeVerdict;
  integrity: Integrity;
  valid: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

function pointerGet(value: unknown, pointer: string): unknown {
  let cur: unknown = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (cur !== null && typeof cur === 'object') cur = (cur as Json)[key];
    else return undefined;
  }
  return cur;
}

/** `args` subset match: every key in the pattern equals the call's value. */
function argsMatch(pattern: Json | undefined, args: Json | undefined): boolean {
  if (pattern === undefined) return true;
  return Object.entries(pattern).every(
    (entry) => JSON.stringify((args ?? {})[entry[0]]) === JSON.stringify(entry[1]),
  );
}

const mandatoryFor = (scope: Scope): string[] =>
  AGENTIC_CATALOG.checks.filter((c) => c.mandatory_for.includes(scope)).map((c) => c.id);

/** Resolve the placeholders and defaults of a fixture report into a full report. */
function resolveReport(sc: Scenario, entry: RunEntry, source: Json): Json {
  const report = clone(source);
  report.report_schema_version ??= '1';
  const run = { ...(report.run as Json | undefined) };
  if (run.run_id === undefined || run.run_id === '$run') run.run_id = entry.run_id;
  report.run = {
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
      model: { provider: 'example', name: 'model-x' },
      budget: { tool_calls: sc.tool_log.length, elapsed_seconds: 60 },
      errors: [],
    },
    ...run,
  };
  report.scope = {
    kind: sc.scope,
    targets: ['nas-01'],
    client_path_in_scope: sc.scope === 'service_path',
    time_window: { requested_seconds: 3600, covered: { from: T0, to: T1 } },
    declared_absent: sc.declared_absent ?? [],
    ...(report.scope as Json | undefined),
  };
  report.findings ??= [];
  report.evidence_manifest ??= [];
  report.not_checked ??= [];
  report.human_readable ??= sc.title;

  report.raw_reports = ((report.raw_reports as Json[] | undefined) ?? []).map((item) => {
    const key = item.$ledger;
    if (typeof key === 'string') {
      const src = sc.ledger[key];
      if (src === undefined)
        throw new Error(`${sc.id}: raw report refers to unknown ledger key ${key}`);
      return {
        tool: src.tool,
        args: clone(src.args),
        collected_at: src.collected_at ?? T0,
        digest: digestOf(src.report),
        report: item.report !== undefined ? clone(item.report) : clone(src.report),
      };
    }
    if (item.digest === '$auto') return { ...item, digest: digestOf(item.report) };
    return item;
  });

  const rows = (report.checks as Json[] | undefined) ?? [];
  const star = rows.find((r) => r['*'] !== undefined);
  const explicit = rows.filter((r) => r['*'] === undefined);
  if (star !== undefined) {
    const listed = new Set(explicit.map((r) => r.id as string));
    for (const id of mandatoryFor(sc.scope)) {
      if (listed.has(id)) continue;
      explicit.push({
        id,
        outcome: star['*'],
        severity: star.severity ?? null,
        reason: star.reason ?? 'no anomaly in the cited evidence',
        mandatory: true,
        evidence_refs: star.evidence_refs ?? [],
      });
    }
  }
  report.checks = explicit;
  return report;
}

function evaluate(sc: Scenario, source: Json = sc.report): Evaluated {
  const ledger = new RunLedger({ now: () => NOW_MS, ttlMs: 900_000 });
  const entry = ledger.mint({
    principal: 'op:alice',
    role: 'operator',
    versions: VERSIONS,
    limits: LIMITS,
  });
  for (const item of Object.values(sc.ledger)) {
    ledger.record(entry.run_id, item.tool, item.args, item.report, item.collected_at ?? T0);
  }
  // §6.3: what `health.context` proved absent for this run — the verdict's
  // only proof for a `not_applicable` row (§11.3 step 3).
  ledger.setDeclaredAbsent(entry.run_id, sc.declared_absent ?? []);
  const report = resolveReport(sc, entry, source);
  let checked: Integrity = UNVERIFIABLE;
  // The same composition the route uses: one schema pass, then the ledger
  // facts for the report it accepted (§11.3 steps 5–6).
  const shape = evaluateReport(report, AGENTIC_CATALOG, (r) => {
    checked = checkIntegrity(entry, r.raw_reports);
    return {
      floorInput: floorInputFrom(checked, r.raw_reports),
      provenAbsent: entry.declared_absent,
    };
  });
  const integrity = shape.computed === null ? UNVERIFIABLE : checked;
  return { entry, report, shape, integrity, valid: isReportValid(shape, integrity.status) };
}

/** Apply a variant overlay: top-level keys replace, `checks` merge by id. */
function overlay(base: Json, over: Json): Json {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k === 'checks') {
      const rows = clone((out.checks as Json[] | undefined) ?? []);
      for (const row of v as Json[]) {
        const i = rows.findIndex((r) => r.id === row.id);
        if (i === -1) rows.push(row);
        else rows[i] = row;
      }
      out.checks = rows;
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

const CATALOG_TOOLS = new Set([...CATALOG.map((e) => e.name), 'prompts/get']);

function assertExpected(sc: Scenario, ev: Evaluated, exp: Expected, label: string): void {
  const why = `${sc.id} ${label}: schema=${JSON.stringify(ev.shape.schema_errors)} refs=${JSON.stringify(
    ev.shape.reference_errors,
  )} status=${JSON.stringify(ev.shape.status_errors)} integrity=${JSON.stringify(ev.integrity)}`;
  expect(ev.shape.schema_errors, why).toEqual([]);
  expect(ev.valid, why).toBe(exp.valid);
  expect(ev.shape.computed, why).toEqual(exp.computed);
  expect(ev.integrity.status, why).toBe(exp.integrity);
  if (exp.integrity_reasons !== undefined) {
    expect(ev.integrity.mismatches.map((m) => m.reason)).toEqual(exp.integrity_reasons);
  }
  if (exp.reference_errors !== undefined) {
    expect(ev.shape.reference_errors.length, why).toBe(exp.reference_errors);
  }
  if (exp.status_errors !== undefined)
    expect(ev.shape.status_errors.length, why).toBe(exp.status_errors);
  if (exp.rewritten_to_unknown !== undefined) {
    expect(ev.shape.rewritten_to_unknown).toEqual(exp.rewritten_to_unknown);
  }
  for (const a of exp.adjustments_include ?? []) {
    expect(ev.shape.adjustments, `${sc.id}: adjustment ${a.id}`).toContainEqual(
      expect.objectContaining(a),
    );
  }
  if (exp.run_status !== undefined) expect(ev.report.run_status).toBe(exp.run_status);

  const checks = ev.report.checks as Array<{ id: string; outcome: string }>;
  const outcomeOf = new Map(checks.map((c) => [c.id, c.outcome]));
  for (const [id, outcome] of Object.entries(exp.checks ?? {})) {
    expect(outcomeOf.get(id), `${sc.id}: check ${id}`).toBe(outcome);
  }
  if (exp.checks_forbid_outcomes !== undefined) {
    for (const id of exp.checks_forbid_outcomes.ids) {
      expect(exp.checks_forbid_outcomes.outcomes, `${sc.id}: check ${id}`).not.toContain(
        outcomeOf.get(id),
      );
    }
  }

  const findings = ev.report.findings as Array<{
    kind: string;
    resource_ids: string[];
    check_ids: string[];
  }>;
  const f = exp.findings;
  if (f?.min !== undefined)
    expect(findings.length, `${sc.id}: findings`).toBeGreaterThanOrEqual(f.min);
  for (const kind of f?.kinds_include ?? []) {
    expect(
      findings.map((x) => x.kind),
      `${sc.id}: finding kind ${kind}`,
    ).toContain(kind);
  }
  for (const rid of f?.resource_ids_include ?? []) {
    expect(
      findings.flatMap((x) => x.resource_ids),
      `${sc.id}: resource ${rid}`,
    ).toContain(rid);
  }
  for (const cid of f?.check_ids_include ?? []) {
    expect(
      findings.flatMap((x) => x.check_ids),
      `${sc.id}: finding check ${cid}`,
    ).toContain(cid);
  }

  const notChecked = ev.report.not_checked as Array<{ check_id: string; reason: string }>;
  for (const needle of exp.not_checked_mentions ?? []) {
    expect(
      notChecked.some((n) =>
        `${n.check_id} ${n.reason}`.toLowerCase().includes(needle.toLowerCase()),
      ),
      `${sc.id}: not_checked mentions ${needle}`,
    ).toBe(true);
  }
  if (exp.not_checked_min !== undefined)
    expect(notChecked.length).toBeGreaterThanOrEqual(exp.not_checked_min);
  const excerpts = (ev.report.evidence_manifest as Array<{ excerpt?: string }>).map(
    (e) => e.excerpt ?? '',
  );
  for (const needle of exp.evidence_excerpt_includes ?? []) {
    expect(
      excerpts.some((x) => x.includes(needle)),
      `${sc.id}: evidence excerpt ${needle}`,
    ).toBe(true);
  }

  for (const forbidden of exp.forbidden_calls ?? []) {
    const hit = sc.tool_log.find(
      (call) =>
        (forbidden.tool === undefined || forbidden.tool === '*' || forbidden.tool === call.tool) &&
        argsMatch(forbidden.args, call.args),
    );
    expect(hit, `${sc.id}: forbidden call ${JSON.stringify(forbidden)}`).toBeUndefined();
  }
  if (exp.tools_from_catalog === true) {
    for (const call of sc.tool_log)
      expect(CATALOG_TOOLS.has(call.tool), `${sc.id}: tool ${call.tool}`).toBe(true);
  }
  if (exp.max_calls_per_tool !== undefined) {
    const counts = new Map<string, number>();
    for (const call of sc.tool_log) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
    for (const [tool, n] of counts)
      expect(n, `${sc.id}: ${tool} called ${n} times`).toBeLessThanOrEqual(exp.max_calls_per_tool);
  }
  for (const p of exp.ledger_preserves ?? []) {
    expect(
      pointerGet(sc.ledger[p.key]?.report, p.pointer),
      `${sc.id}: ledger ${p.key}${p.pointer}`,
    ).toEqual(p.equals);
  }
  if (exp.execution_roles_ran_length !== undefined) {
    expect(
      (ev.report.run as { execution: { roles_ran: string[] } }).execution.roles_ran,
    ).toHaveLength(exp.execution_roles_ran_length);
  }
}

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .sort();
const scenarios: Scenario[] = files.map(
  (f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Scenario,
);

describe('agentic acceptance fixtures (S19d)', () => {
  it.each(REQUIRED)('has a fixture for %s', (id) => {
    expect(scenarios.map((s) => s.id)).toContain(id);
  });

  it('fixture ids are unique and each file name carries its id', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    files.forEach((f, i) => expect(f.startsWith(`${scenarios[i]?.id.toLowerCase()}-`)).toBe(true));
  });

  describe.each(scenarios.map((s) => [s.id, s] as const))('%s', (_id, sc) => {
    it(sc.title, () => {
      const ev = evaluate(sc);
      assertExpected(sc, ev, sc.expected, 'main');
      if (sc.variant_uncited !== undefined) {
        const variant = evaluate(sc, overlay(sc.report, sc.variant_uncited.report));
        assertExpected(sc, variant, sc.variant_uncited.expected, 'variant_uncited');
      }
      if (sc.previous !== undefined) {
        const prev = evaluate(sc.previous);
        assertExpected(sc.previous, prev, sc.previous.expected, 'previous');
        if (sc.expected.run_ids_differ === true) {
          expect(prev.entry.run_id).not.toBe(ev.entry.run_id);
          expect(prev.report.run).not.toEqual(ev.report.run);
        }
      }
    });
  });
});

describe('isReportValid (spec §11.2)', () => {
  const clean: ShapeVerdict = {
    schema_errors: [],
    reference_errors: [],
    computed: { health_status: 'ok', coverage_status: 'complete' },
    status_errors: [],
    mandatory_ids: [],
    rewritten_to_unknown: [],
    adjustments: [],
  };
  it('is true only with no schema, reference or status errors and no integrity mismatch', () => {
    expect(isReportValid(clean, 'verified')).toBe(true);
    expect(isReportValid(clean, 'unverifiable')).toBe(true);
    expect(isReportValid(clean, 'mismatch')).toBe(false);
    expect(
      isReportValid({ ...clean, schema_errors: [{ path: '', message: 'x' }] }, 'verified'),
    ).toBe(false);
    expect(
      isReportValid(
        { ...clean, reference_errors: [{ path: '', ref: 'r', message: 'x' }] },
        'verified',
      ),
    ).toBe(false);
    expect(isReportValid({ ...clean, status_errors: ['x'] }, 'verified')).toBe(false);
  });
});
