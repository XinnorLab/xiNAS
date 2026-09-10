/**
 * The agentic report contract and its pure validator (S19c; spec §11.1–§11.3,
 * REPORT-02, REPORT-03, D-12).
 *
 * `agentic-report.schema.json` (JSON Schema 2020-12, `report_schema_version`
 * "1") is what `GET /health/report-schema` serves and what the model is
 * asked to conform to. This module checks a report's shape against it,
 * resolves every reference the report makes (evidence ids, check ids) and
 * computes the deterministic verdict of §11.3 from the catalog's mandatory
 * rows — the model's own `health_status` / `coverage_status` are compared
 * with the computed ones, never trusted.
 *
 * Ledger integrity (§11.4) needs the run ledger and lives in the api
 * (`api/health/report-integrity.ts`); `lib/` stays free of api imports.
 */

import { readFileSync } from 'node:fs';
import addFormatsImport from 'ajv-formats';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { AgenticCatalog, Scope } from './agentic-catalog.js';
import { type Floor, type FloorInput, computeFloors, levelOf, outcomeAt } from './report-floor.js';

export const REPORT_SCHEMA_VERSION = '1';

/** The shipped schema, read once at module load (copied to dist/ by `npm run build`). */
export const REPORT_SCHEMA: Record<string, unknown> & { $schema?: string } = JSON.parse(
  readFileSync(new URL('./agentic-report.schema.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

export type CheckOutcome = 'pass' | 'warn' | 'fail' | 'unknown' | 'not_applicable';
export type CheckSeverity = 'warning' | 'degraded' | 'critical';
export type HealthStatus = 'ok' | 'warning' | 'degraded' | 'critical' | 'unknown';
export type CoverageStatus = 'complete' | 'partial' | 'none';
export type RunStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface ReportCheck {
  id: string;
  outcome: CheckOutcome;
  severity: CheckSeverity | null;
  reason: string;
  mandatory: boolean;
  evidence_refs: string[];
}

export interface ReportFinding {
  id: string;
  kind: 'observation' | 'hypothesis' | 'data_gap' | 'conflict';
  check_ids: string[];
  evidence_refs: string[];
}

export interface RawReport {
  tool: string;
  args: Record<string, unknown>;
  collected_at: string;
  digest: string;
  report: unknown;
}

/** The parts of a schema-valid report the validator reads. */
export interface AgenticReport {
  report_schema_version: string;
  run: { run_id: string; principal: string; versions: Record<string, unknown> };
  scope: { kind: Scope; declared_absent?: string[] };
  run_status: RunStatus;
  health_status: HealthStatus;
  coverage_status: CoverageStatus;
  raw_reports: RawReport[];
  checks: ReportCheck[];
  findings: ReportFinding[];
  evidence_manifest: Array<{ id: string; stale?: boolean }>;
  not_checked: Array<{ check_id: string; reason: string }>;
}

export interface SchemaError {
  path: string;
  message: string;
}

export interface ReportReferenceError {
  path: string;
  ref: string;
  message: string;
}

export interface Computed {
  health_status: HealthStatus;
  coverage_status: CoverageStatus;
}

export interface Verdict extends Computed {
  /** Rows whose effective outcome became `unknown` from another outcome (§11.3 steps 3, 5–8). */
  rewritten_to_unknown: string[];
}

/** One row the verdict raised or rewrote, and why (§11.3 steps 3, 5–8). */
export interface Adjustment {
  id: string;
  from: CheckOutcome;
  to: CheckOutcome;
  severity: CheckSeverity | null;
  reason:
    | 'floor'
    | 'no_source'
    | 'stale_evidence'
    | 'not_applicable_uncited'
    | 'declared_absent_unproven';
  detail: string;
}

/** What the verdict knows beyond the report itself (§11.3 steps 3, 5–8). */
export interface VerdictInput {
  /** Per check id, the most severe outcome its own raw reports support. */
  floors: ReadonlyMap<string, Floor>;
  /** null = unverifiable run (no ledger entry): the report's own `declared_absent` is taken as is. */
  provenAbsent: readonly string[] | null;
  /** `evidence_manifest` ids the report itself marked `stale`. */
  staleEvidenceIds: ReadonlySet<string>;
}

/** What `validateReportShape` may be told about the run; every field defaults. */
export interface ShapeInput {
  /** What the floor may trust; defaults to every raw report and no compromised tool. */
  floorInput?: FloorInput;
  /** Defaults to null — an unverifiable run proves nothing either way (SAFE-04). */
  provenAbsent?: readonly string[] | null;
}

export interface ShapeVerdict {
  schema_errors: SchemaError[];
  reference_errors: ReportReferenceError[];
  /** null when schema errors made the report unevaluable. */
  computed: Computed | null;
  status_errors: string[];
  mandatory_ids: string[];
  rewritten_to_unknown: string[];
  adjustments: Adjustment[];
}

// ── Ajv (CJS) under NodeNext: the default import is the constructor / plugin itself ──
interface AjvErrorObject {
  instancePath: string;
  message?: string;
}
interface ValidateFn {
  (data: unknown): boolean;
  errors?: AjvErrorObject[] | null;
}
interface AjvLike {
  compile(schema: unknown): ValidateFn;
}
const Ajv2020 = Ajv2020Import as unknown as new (opts: Record<string, unknown>) => AjvLike;
const addFormats = addFormatsImport as unknown as (ajv: AjvLike) => void;

let compiled: ValidateFn | null = null;
function schemaValidator(): ValidateFn {
  if (compiled === null) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    compiled = ajv.compile(REPORT_SCHEMA);
  }
  return compiled;
}

/** Schema errors only, as `{ path, message }`; empty when the report validates. */
export function schemaErrorsOf(report: unknown): SchemaError[] {
  const validate = schemaValidator();
  if (validate(report)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? 'invalid',
  }));
}

const COVERED: ReadonlySet<CheckOutcome> = new Set(['pass', 'warn', 'fail', 'not_applicable']);
const SCOPE_EXCLUSION_RE = /out of scope|not in scope|scope exclusion|excluded from (?:the )?scope/;

/**
 * §11.3 steps 1–3 and 5–8. `mandatoryIds` are the catalog rows whose
 * `mandatory_for` includes the declared scope; a mandatory row missing from
 * `checks` counts as unknown.
 *
 * Each row is walked through the rules in order before the verdict is taken
 * over the *effective* outcomes: an uncited `not_applicable` becomes
 * `unknown` (step 3), a `no_source` row may not claim a measurement (step
 * 7), stale evidence cannot back a `pass` (step 8), and the evidence floor
 * (steps 5–6) raises whatever is left below what the raw reports say. Every
 * change is listed in `adjustments`; every one but step 3's is also a
 * status error, since step 3's rewrite already shows up as a verdict
 * mismatch.
 */
export function computeVerdict(
  checks: ReportCheck[],
  mandatoryIds: ReadonlySet<string>,
  declaredAbsent: readonly string[],
  _scopeKind: Scope,
  catalog: AgenticCatalog,
  input: VerdictInput,
): Verdict & { adjustments: Adjustment[]; errors: string[] } {
  const absent = declaredAbsent.map((s) => s.toLowerCase()).filter((s) => s.length > 0);
  const provenList = input.provenAbsent;
  // An unverifiable run proves nothing either way, so the report's own list
  // stands (SAFE-04); a known run's ledger entry is the only other proof.
  const proven =
    provenList === null
      ? absent
      : absent.filter((a) => provenList.some((p) => p.toLowerCase() === a));
  const adjustments: Adjustment[] = [];
  const errors: string[] = [];
  for (const a of absent) {
    if (!proven.includes(a)) {
      errors.push(`scope.declared_absent '${a}' is not proven by the run's inventory`);
    }
  }
  const noSource = new Set(catalog.checks.filter((c) => c.no_source).map((c) => c.id));

  const rewritten_to_unknown: string[] = [];
  const effective: ReportCheck[] = checks.map((c) => {
    let outcome = c.outcome;
    let severity = c.severity;
    const adjust = (
      to: CheckOutcome,
      sev: CheckSeverity | null,
      reason: Adjustment['reason'],
      detail: string,
    ) => {
      adjustments.push({ id: c.id, from: outcome, to, severity: sev, reason, detail });
      outcome = to;
      severity = sev;
    };
    const reasonText = c.reason.toLowerCase();
    let cited = false;

    // step 3 — a not_applicable must cite an absence the run proved
    if (outcome === 'not_applicable') {
      cited =
        proven.some((a) => reasonText.includes(a)) ||
        (!mandatoryIds.has(c.id) && SCOPE_EXCLUSION_RE.test(reasonText));
      if (!cited) {
        const unproven = absent.find((a) => reasonText.includes(a) && !proven.includes(a));
        if (unproven === undefined) {
          adjust(
            'unknown',
            null,
            'not_applicable_uncited',
            'the reason cites no component the run proved absent',
          );
        } else {
          adjust(
            'unknown',
            null,
            'declared_absent_unproven',
            `the reason cites '${unproven}', which the run's inventory did not prove absent`,
          );
        }
      }
    }

    // step 7 — a row with no producer may not claim a measurement
    if (noSource.has(c.id) && (outcome === 'pass' || outcome === 'warn' || outcome === 'fail')) {
      errors.push(`check '${c.id}' has no source in this release and cannot be '${outcome}'`);
      adjust('unknown', null, 'no_source', 'the catalog row has no producer in this release');
    }

    // step 8 — stale evidence cannot back a pass
    const stale = c.evidence_refs.find((ref) => input.staleEvidenceIds.has(ref));
    if (outcome === 'pass' && stale !== undefined) {
      errors.push(`check '${c.id}' cannot be 'pass': evidence '${stale}' is stale`);
      adjust('unknown', null, 'stale_evidence', `evidence '${stale}' is stale`);
    }

    // steps 5–6 — the evidence floor
    const floor = input.floors.get(c.id);
    if (floor !== undefined) {
      // A validly cited absence explains a skipped input, nothing worse.
      const waived = floor.level === 1 && outcome === 'not_applicable' && cited;
      if (!waived && floor.level > levelOf(outcome, severity)) {
        const forced = outcomeAt(floor.level);
        errors.push(
          `check '${c.id}' outcome '${outcome}' is below the evidence floor '${forced.outcome}' (${floor.detail})`,
        );
        adjust(forced.outcome, forced.severity, 'floor', floor.detail);
      }
    }

    if (outcome === 'unknown' && c.outcome !== 'unknown') rewritten_to_unknown.push(c.id);
    return { ...c, outcome, severity };
  });

  const byId = new Map(effective.map((c) => [c.id, c]));
  const ids = [...mandatoryIds];
  const coveredCount = ids.filter((id) => {
    const c = byId.get(id);
    return c !== undefined && COVERED.has(c.outcome);
  }).length;
  const coverage_status: CoverageStatus =
    ids.length === 0 || coveredCount === ids.length
      ? 'complete'
      : coveredCount === 0
        ? 'none'
        : 'partial';

  const fails = effective.filter((c) => c.outcome === 'fail');
  let health_status: HealthStatus;
  if (fails.some((c) => c.severity === 'critical')) health_status = 'critical';
  else if (fails.length > 0) health_status = 'degraded';
  else if (effective.some((c) => c.outcome === 'warn')) health_status = 'warning';
  else health_status = coverage_status === 'complete' ? 'ok' : 'unknown';

  return { health_status, coverage_status, rewritten_to_unknown, adjustments, errors };
}

/**
 * §11.2: a report is valid iff it has no schema, reference or status errors
 * and its raw reports did not mismatch the ledger; `unverifiable` (an
 * unknown or expired run) never invalidates (SAFE-04, AC-18).
 */
export function isReportValid(
  shape: Pick<ShapeVerdict, 'schema_errors' | 'reference_errors' | 'status_errors'>,
  integrity: 'verified' | 'mismatch' | 'unverifiable',
): boolean {
  return (
    shape.schema_errors.length === 0 &&
    shape.reference_errors.length === 0 &&
    shape.status_errors.length === 0 &&
    integrity !== 'mismatch'
  );
}

/**
 * Schema, references and the §11.3 verdict; pure over the report, the
 * catalog and what the caller knows about the run (`input`). With no
 * `input` the floor is computed from every raw report the report carries
 * and nothing is proven absent — the honest default for a caller with no
 * ledger.
 */
export function validateReportShape(
  report: unknown,
  catalog: AgenticCatalog,
  input?: ShapeInput,
): ShapeVerdict {
  const schema_errors = schemaErrorsOf(report);
  if (schema_errors.length > 0) {
    return {
      schema_errors,
      reference_errors: [],
      computed: null,
      status_errors: [],
      mandatory_ids: [],
      rewritten_to_unknown: [],
      adjustments: [],
    };
  }
  const r = report as AgenticReport;
  const scopeKind = r.scope.kind;
  const catalogIds = new Set(catalog.checks.map((c) => c.id));
  const mandatory_ids = catalog.checks
    .filter((c) => c.mandatory_for.includes(scopeKind))
    .map((c) => c.id);
  const evidenceIds = new Set(r.evidence_manifest.map((e) => e.id));
  const checkIds = new Set(r.checks.map((c) => c.id));

  const reference_errors: ReportReferenceError[] = [];
  const unknownEvidence = (path: string, ref: string) => {
    if (!evidenceIds.has(ref)) reference_errors.push({ path, ref, message: 'unknown evidence id' });
  };
  r.checks.forEach((c, i) => {
    if (!catalogIds.has(c.id)) {
      reference_errors.push({ path: `/checks/${i}/id`, ref: c.id, message: 'unknown check id' });
    }
    c.evidence_refs.forEach((ref, j) => unknownEvidence(`/checks/${i}/evidence_refs/${j}`, ref));
  });
  r.findings.forEach((f, i) => {
    f.check_ids.forEach((id, j) => {
      if (!checkIds.has(id) && !catalogIds.has(id)) {
        reference_errors.push({
          path: `/findings/${i}/check_ids/${j}`,
          ref: id,
          message: 'unknown check id',
        });
      }
    });
    f.evidence_refs.forEach((ref, j) => unknownEvidence(`/findings/${i}/evidence_refs/${j}`, ref));
  });
  r.not_checked.forEach((n, i) => {
    if (!catalogIds.has(n.check_id)) {
      reference_errors.push({
        path: `/not_checked/${i}/check_id`,
        ref: n.check_id,
        message: 'unknown check id',
      });
    }
  });

  const floorInput: FloorInput = input?.floorInput ?? {
    usableRawReports: new Set(r.raw_reports.map((_, i) => i)),
    compromisedTools: new Set<string>(),
  };
  const verdict = computeVerdict(
    r.checks,
    new Set(mandatory_ids),
    r.scope.declared_absent ?? [],
    scopeKind,
    catalog,
    {
      floors: computeFloors(r, catalog, floorInput),
      provenAbsent: input?.provenAbsent ?? null,
      staleEvidenceIds: new Set(
        r.evidence_manifest.filter((e) => e.stale === true).map((e) => e.id),
      ),
    },
  );
  const status_errors: string[] = [...verdict.errors];
  if (r.health_status !== verdict.health_status) {
    status_errors.push(
      `health_status '${r.health_status}' does not match computed '${verdict.health_status}'`,
    );
  }
  if (r.coverage_status !== verdict.coverage_status) {
    status_errors.push(
      `coverage_status '${r.coverage_status}' does not match computed '${verdict.coverage_status}'`,
    );
  }
  if ((r.run_status === 'failed' || r.run_status === 'cancelled') && r.health_status === 'ok') {
    status_errors.push(`run_status '${r.run_status}' cannot coexist with health_status 'ok'`);
  }
  const mandatorySet = new Set(mandatory_ids);
  for (const c of r.checks) {
    if (!catalogIds.has(c.id)) continue;
    const expected = mandatorySet.has(c.id);
    if (c.mandatory !== expected) {
      status_errors.push(
        expected
          ? `check '${c.id}' is mandatory for scope '${scopeKind}' but the report says mandatory: false`
          : `check '${c.id}' is not mandatory for scope '${scopeKind}' but the report says mandatory: true`,
      );
    }
  }

  return {
    schema_errors,
    reference_errors,
    computed: { health_status: verdict.health_status, coverage_status: verdict.coverage_status },
    status_errors,
    mandatory_ids,
    rewritten_to_unknown: verdict.rewritten_to_unknown,
    adjustments: verdict.adjustments,
  };
}

/**
 * The api's composition: shape, references and the verdict with the floor
 * the ledger side allows (`floorInputFrom`) and the absences the run's
 * ledger entry proved (`null` when there is no entry). The one place a
 * caller with a ledger should go through (validation F01).
 */
export function evaluateReport(
  report: unknown,
  catalog: AgenticCatalog,
  floorInput: FloorInput,
  provenAbsent: readonly string[] | null,
): ShapeVerdict {
  return validateReportShape(report, catalog, { floorInput, provenAbsent });
}
