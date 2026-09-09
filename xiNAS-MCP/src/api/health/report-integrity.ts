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
 * (SAFE-04, AC-18).
 */

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

export interface Integrity {
  status: 'verified' | 'mismatch' | 'unverifiable';
  /** How many raw reports were checkable (ledger-writing tools). */
  checked: number;
  mismatches: IntegrityMismatch[];
}

export const UNVERIFIABLE: Integrity = { status: 'unverifiable', checked: 0, mismatches: [] };

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
  return { status: mismatches.length > 0 ? 'mismatch' : 'verified', checked, mismatches };
}
