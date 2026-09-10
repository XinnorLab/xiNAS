/**
 * The evidence floor (S19 spec §11.3 steps 5–6; validation F01).
 *
 * A model's verdict may never be more favourable than the raw reports its
 * own report carries. For every catalog row, each of its `inputs` that
 * appears in a usable raw `health.check`, `health.baseline` or
 * `health.probe.run` result contributes a floor, mapped through the
 * catalog's own `outcome_map` / `severity_map` — so the floor says what
 * xiNAS measured, not what this module thinks a status means. The row's
 * floor is the most severe contribution; the verdict then takes the more
 * severe of the model's outcome and the floor.
 *
 * Two things never contribute: an input absent from every raw report (the
 * model simply did not consume it), and a raw report integrity rejected.
 * A tool whose latest ledger row the report omitted or tampered with is
 * `compromised` instead: every input of that tool floors to `unknown`,
 * because a check fed by hidden or edited evidence is not measured.
 *
 * Pure over the report and the catalog — `lib/` imports nothing from
 * `api/`; which raw reports are usable and which tools are compromised is
 * decided by the ledger side and handed in as data (`FloorInput`).
 */

import type {
  AgenticCatalog,
  AgenticCheck,
  AgenticCheckInput,
  CheckOutcome,
  CheckSeverity,
} from './agentic-catalog.js';
import type { AgenticReport, RawReport } from './report-validate.js';

/** none < unknown < warn (= fail/warning) < fail/degraded < fail/critical. */
export type FloorLevel = 0 | 1 | 2 | 3 | 4;

export interface Floor {
  level: FloorLevel;
  detail: string;
}

export interface FloorInput {
  /** Indices into `report.raw_reports` the floor may trust (not tampered). */
  usableRawReports: ReadonlySet<number>;
  /** Ledger tools whose latest row the report omitted or tampered: their inputs floor to unknown. */
  compromisedTools: ReadonlySet<string>;
}

/** The three input families that name a ledger-writing tool; everything else never floors. */
function toolOf(source: string): string | null {
  if (source === 'mcp:health.check') return 'health.check';
  if (source === 'baseline') return 'health.baseline';
  if (source === 'probe:health.probe.run') return 'health.probe.run';
  return null;
}

/** A raw row whose collection failed is a data gap, never a finding (AC-03). */
const FAILED_COLLECTION: ReadonlySet<string> = new Set(['error', 'timeout', 'permission_denied']);

/** outcome + severity → floor level. */
export function levelOf(outcome: CheckOutcome, severity: CheckSeverity | null): FloorLevel {
  if (outcome === 'unknown') return 1;
  if (outcome === 'warn') return 2;
  if (outcome === 'fail') return severity === 'critical' ? 4 : severity === 'degraded' ? 3 : 2;
  return 0;
}

/** floor level → the outcome/severity it forces. */
export function outcomeAt(level: FloorLevel): {
  outcome: CheckOutcome;
  severity: CheckSeverity | null;
} {
  if (level === 4) return { outcome: 'fail', severity: 'critical' };
  if (level === 3) return { outcome: 'fail', severity: 'degraded' };
  if (level === 2) return { outcome: 'warn', severity: 'warning' };
  if (level === 1) return { outcome: 'unknown', severity: null };
  return { outcome: 'pass', severity: null };
}

/**
 * A JSON scalar as text; objects, arrays and null are '' — never a coercion
 * that can throw. `raw_reports[].report` is `true` in the report schema, so
 * a model-supplied `id`/`status`/`name`/`section`/`probe` may be any JSON
 * value, including an object carrying a non-callable `toString`/`valueOf`
 * member — `String(...)` on that throws `TypeError: Cannot convert object
 * to primitive value` (fix round 2, finding 1).
 */
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

/** Baseline sections are compared case- and separator-insensitively ('NVMe Health' → 'nvme_health'). */
const norm = (s: unknown): string =>
  str(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');

/** The level the catalog row itself assigns to a producer status; null when it maps nothing. */
function mapped(check: AgenticCheck, key: string): FloorLevel | null {
  const outcome = check.outcome_map[key];
  if (outcome === undefined) return null;
  return levelOf(outcome, check.severity_map[key] ?? null);
}

interface RawIndex {
  mcp: Array<{ id: string; status: string; collection: string | null }>;
  baseline: Array<{ ok: boolean; rows: Array<{ section: string; name: string; status: string }> }>;
  probe: Array<{ probe: string; ok: boolean; cleanupFailed: boolean }>;
}

/**
 * `raw_reports[].report` is `true` in the report schema — any JSON value
 * passes. Parsing is therefore total: a shape this index cannot read
 * contributes nothing, never an exception (a crash here would be a 500 on
 * `POST /health/report/validate` instead of a verdict).
 */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Flatten the usable raw reports into the three shapes the input families read. */
function indexRaw(raw: RawReport[], usable: ReadonlySet<number>): RawIndex {
  const out: RawIndex = { mcp: [], baseline: [], probe: [] };
  raw.forEach((r, i) => {
    if (!usable.has(i)) return;
    const body = asRecord(r.report);
    if (body === null) return;
    if (r.tool === 'health.check') {
      if (!Array.isArray(body.checks)) return;
      for (const item of body.checks as unknown[]) {
        const c = asRecord(item);
        if (c === null) continue;
        const collection = asRecord(asRecord(c.evidence)?.collection)?.status;
        out.mcp.push({
          id: str(c.id),
          status: str(c.status),
          collection: typeof collection === 'string' ? collection : null,
        });
      }
    } else if (r.tool === 'health.baseline') {
      const engine = asRecord(body.report);
      const ok = asRecord(body.collection)?.status === 'success' && engine !== null;
      const rows: Array<{ section: string; name: string; status: string }> = [];
      if (ok && engine !== null && Array.isArray(engine.checks)) {
        for (const item of engine.checks as unknown[]) {
          const x = asRecord(item);
          if (x === null) continue;
          rows.push({ section: norm(x.section), name: str(x.name), status: str(x.status) });
        }
      }
      out.baseline.push({ ok, rows });
    } else if (r.tool === 'health.probe.run') {
      out.probe.push({
        probe: str(body.probe),
        ok: body.ok === true,
        cleanupFailed: asRecord(body.cleanup)?.status === 'failed',
      });
    }
  });
  return out;
}

type Raise = (id: string, level: FloorLevel | null, detail: string) => void;

/** One input's contributions, over every usable raw report of its family. */
function contribute(
  check: AgenticCheck,
  inp: AgenticCheckInput,
  idx: RawIndex,
  raise: Raise,
): void {
  if (inp.source === 'mcp:health.check') {
    for (const row of idx.mcp) {
      if (row.id !== inp.check_id) continue;
      if (row.collection !== null && FAILED_COLLECTION.has(row.collection)) {
        raise(check.id, 1, `health.check ${row.id}: collection ${row.collection}`);
      } else {
        raise(
          check.id,
          mapped(check, `mcp:${row.status}`),
          `health.check ${row.id}: ${row.status}`,
        );
      }
    }
  } else if (inp.source === 'baseline') {
    for (const b of idx.baseline) {
      if (!b.ok) {
        raise(check.id, 1, 'health.baseline: collection failed');
        continue;
      }
      const row = b.rows.find((x) => x.section === norm(inp.section) && x.name === inp.check);
      if (row !== undefined) {
        raise(
          check.id,
          mapped(check, `baseline:${row.status}`),
          `health.baseline ${inp.section}/${inp.check}: ${row.status}`,
        );
      }
    }
  } else if (inp.source === 'probe:health.probe.run') {
    for (const p of idx.probe) {
      if (p.probe !== inp.probe) continue;
      const key = !p.ok ? 'probe:failed' : p.cleanupFailed ? 'probe:cleanup_failed' : 'probe:ok';
      raise(
        check.id,
        mapped(check, key),
        `health.probe.run ${p.probe}: ${key.slice('probe:'.length)}`,
      );
    }
  }
}

/**
 * The floor of every catalog row the report's raw reports say something
 * about; rows with no contribution are absent from the map.
 */
export function computeFloors(
  report: AgenticReport,
  catalog: AgenticCatalog,
  input: FloorInput,
): Map<string, Floor> {
  const idx = indexRaw(report.raw_reports, input.usableRawReports);
  const floors = new Map<string, Floor>();
  const raise: Raise = (id, level, detail) => {
    if (level === null || level === 0) return;
    const cur = floors.get(id);
    if (cur === undefined || level > cur.level) floors.set(id, { level, detail });
  };
  for (const check of catalog.checks) {
    for (const inp of check.inputs) {
      const tool = toolOf(inp.source);
      if (tool === null) continue; // read:/resource: inputs never floor
      if (input.compromisedTools.has(tool)) {
        raise(check.id, 1, `${tool}: raw report omitted or tampered`);
        continue;
      }
      contribute(check, inp, idx, raise);
    }
  }
  return floors;
}
