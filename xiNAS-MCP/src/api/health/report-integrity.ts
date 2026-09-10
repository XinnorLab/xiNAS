/**
 * Raw-report integrity against the run ledger (S19c; spec §11.4, AC-19).
 *
 * For every `raw_reports[i]` produced by a ledger-writing tool
 * (`health.check`, `health.baseline`, `health.probe.run`): the report
 * re-hashed must equal its claimed `digest`, and a ledger row for the same
 * tool and arguments must carry that digest. A model that edits a raw
 * FAIL, or invents a report xiNAS never produced, is a `mismatch`.
 * Reports from tools that do not write the ledger (`arrays.list`,
 * `system.logs`, …) cannot be checked and do not count. An unknown or
 * expired run is `unverifiable` — reported, never treated as invalid
 * (SAFE-04, AC-18); so is a report that carries nothing checkable at all
 * (`checked === 0`), because `verified` would claim a check that never
 * happened (final review, §11.4).
 *
 * Completeness is the other half: the LATEST result of every `(tool,
 * args)` the ledger holds must appear in `raw_reports`. One that does not
 * is `omitted` and makes the report a `mismatch` — hiding a result xiNAS
 * produced is the same lie as editing it. `floorInputFrom` turns that
 * verdict into what the evidence floor may read (§11.3 steps 5–6).
 *
 * `runIdentityErrors` is the companion §11.4 check: the report's
 * `run.principal` / `run.versions` must equal the ledger entry's. Since the
 * ledger itself refuses a cross-principal read (`RunLedger.get`, F03), the
 * caller only ever reaches this with its own run's entry.
 */

import type { FloorInput } from '../../lib/health/report-floor.js';
import type { RawReport } from '../../lib/health/report-validate.js';
import { type RunEntry, digestOf } from './run-ledger.js';

export const LEDGER_TOOLS: ReadonlySet<string> = new Set([
  'health.check',
  'health.baseline',
  'health.probe.run',
]);

export interface IntegrityMismatch {
  raw_report_index: number;
  reason: 'report_rehash_mismatch' | 'not_in_ledger' | 'digest_mismatch';
  /** The digest the ledger (or the report itself) claims; null when no ledger row matched. */
  expected_digest: string | null;
  actual_digest: string;
}

/** A result xiNAS produced for this run that the report does not carry (§11.4 completeness). */
export interface IntegrityOmission {
  tool: string;
  args_digest: string;
  collected_at: string;
}

export interface Integrity {
  status: 'verified' | 'mismatch' | 'unverifiable';
  /** How many raw reports were checkable (ledger-writing tools). */
  checked: number;
  mismatches: IntegrityMismatch[];
  omitted: IntegrityOmission[];
}

export const UNVERIFIABLE: Integrity = {
  status: 'unverifiable',
  checked: 0,
  mismatches: [],
  omitted: [],
};

/** The `RunVersions` keys the report's `run.versions` is compared against (`server` excluded — spec §11.4). */
const VERSION_KEYS = ['prompt', 'template_sha256', 'policy', 'catalog', 'report_schema'] as const;

/**
 * §11.4 identity: the report's `run` block must be the ledger's (F03). One
 * string per mismatch; called only when `entry` is this caller's own run —
 * a foreign or unknown run never reaches here (§6.3: it is `RUN_UNKNOWN`
 * and `unverifiable` before identity is ever checked).
 */
export function runIdentityErrors(
  entry: RunEntry,
  run: { principal: string; versions: Record<string, unknown> },
): string[] {
  const errors: string[] = [];
  if (run.principal !== entry.principal) {
    errors.push(
      `run.principal '${run.principal}' does not match the ledger ('${entry.principal}')`,
    );
  }
  for (const key of VERSION_KEYS) {
    const claimed = run.versions[key];
    const stamped = entry.versions[key];
    if (claimed !== stamped) {
      errors.push(
        `run.versions.${key} '${String(claimed)}' does not match the ledger ('${stamped}')`,
      );
    }
  }
  return errors;
}

export function checkIntegrity(entry: RunEntry, rawReports: RawReport[]): Integrity {
  let checked = 0;
  const mismatches: IntegrityMismatch[] = [];
  rawReports.forEach((raw, i) => {
    if (!LEDGER_TOOLS.has(raw.tool)) return;
    checked += 1;
    const actual = digestOf(raw.report);
    if (actual !== raw.digest) {
      mismatches.push({
        raw_report_index: i,
        reason: 'report_rehash_mismatch',
        expected_digest: raw.digest,
        actual_digest: actual,
      });
      return;
    }
    const argsDigest = digestOf(raw.args);
    const rows = entry.reports.filter((r) => r.tool === raw.tool && r.args_digest === argsDigest);
    if (rows.length === 0) {
      mismatches.push({
        raw_report_index: i,
        reason: 'not_in_ledger',
        expected_digest: null,
        actual_digest: actual,
      });
      return;
    }
    if (!rows.some((r) => r.report_digest === raw.digest)) {
      mismatches.push({
        raw_report_index: i,
        reason: 'digest_mismatch',
        expected_digest: rows[rows.length - 1]?.report_digest ?? null,
        actual_digest: actual,
      });
    }
  });

  // §11.4 completeness: the LATEST row of every (tool, args) the ledger
  // holds must be in the report. An earlier one is superseded; a missing
  // latest one is a result the model hid (validation F01b).
  const latest = new Map<string, (typeof entry.reports)[number]>();
  for (const row of entry.reports) latest.set(`${row.tool} ${row.args_digest}`, row);
  const omitted: IntegrityOmission[] = [];
  for (const row of latest.values()) {
    const carried = rawReports.some(
      (raw) =>
        raw.tool === row.tool &&
        digestOf(raw.args) === row.args_digest &&
        raw.digest === row.report_digest,
    );
    if (!carried) {
      omitted.push({
        tool: row.tool,
        args_digest: row.args_digest,
        collected_at: row.collected_at,
      });
    }
  }

  // `verified` is a claim about a check that was actually performed. A
  // report that carries no raw report from a ledger-writing tool verified
  // nothing, so it is `unverifiable` — which never invalidates on its own
  // (SAFE-04). Completeness still comes first: a ledger row the report left
  // out is a `mismatch` whatever `checked` says (§11.4).
  const status: Integrity['status'] =
    mismatches.length > 0 || omitted.length > 0
      ? 'mismatch'
      : checked === 0
        ? 'unverifiable'
        : 'verified';
  return { status, checked, mismatches, omitted };
}

/**
 * What the evidence floor may trust, from the integrity verdict (§11.3
 * steps 5–6): every raw report integrity did not reject, and the tools
 * whose latest result the report omitted or tampered with.
 */
export function floorInputFrom(integrity: Integrity, rawReports: RawReport[]): FloorInput {
  const mismatched = new Set(integrity.mismatches.map((m) => m.raw_report_index));
  const compromisedTools = new Set<string>([
    ...integrity.omitted.map((o) => o.tool),
    ...integrity.mismatches.map((m) => rawReports[m.raw_report_index]?.tool ?? ''),
  ]);
  compromisedTools.delete('');
  return {
    usableRawReports: new Set(rawReports.map((_, i) => i).filter((i) => !mismatched.has(i))),
    compromisedTools,
  };
}
