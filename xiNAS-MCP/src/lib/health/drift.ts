/**
 * Drift comparisons (S7 T3, ADR-0009 §Drift).
 *
 * Three desired-vs-observed comparisons; pure functions, evidence-rich.
 *
 *  - nfs-exports: SEMANTIC entry compare (compiled desired Shares vs
 *    observed ExportRule rows) — /etc/exports bytes are written by the
 *    python helper, so a byte-hash would couple two writers; and the
 *    observed effective_files set does not cover /etc/exports anyway.
 *  - netplan: render(desired) hash vs the observed xinas_file_hash
 *    (both sides from the ONE TS renderer — S6's anchor).
 *  - nfs-conf: helper dry-render checksums (same renderer as the live
 *    files) vs observed effective_files — evaluated only when the
 *    probe supplied a render (standard profile).
 */

import { createHash } from 'node:crypto';
import { type DesiredIfaceSpec, renderNetplan } from '../net/render.js';
import type { ExportEntry } from '../nfs-exports.js';
import type { HealthCheckResult } from './engine.js';

export interface ObservedExportRuleRow {
  export_path: string;
  rules: Array<{ host_pattern: string; options: string[] }>;
}

/**
 * Options exportfs displays that the compile never emits — kernel-side
 * display artifacts, ignored by the semantic compare (both raw lists
 * stay in the evidence so a false positive is diagnosable).
 */
const KERNEL_NOISE_OPTIONS = new Set(['wdelay', 'no_wdelay', 'hide', 'nohide', 'pnfs', 'no_pnfs']);

function canonicalOptions(options: string[]): string {
  return [...new Set(options.filter((o) => !KERNEL_NOISE_OPTIONS.has(o)))].sort().join(',');
}

export interface ExportsDrift {
  /** Desired paths with no observed export. */
  missing: string[];
  /** Observed exported paths with no desired share. */
  extra: string[];
  /** Shared paths whose host set or canonical options differ. */
  changed: Array<{
    path: string;
    detail: string;
    desired: ExportEntry['clients'];
    observed: ObservedExportRuleRow['rules'];
  }>;
}

export function compareExports(
  desired: ExportEntry[],
  observed: ObservedExportRuleRow[],
): ExportsDrift {
  const observedByPath = new Map(observed.map((r) => [r.export_path, r]));
  const desiredPaths = new Set(desired.map((e) => e.path));

  const missing = desired.filter((e) => !observedByPath.has(e.path)).map((e) => e.path);
  const extra = observed.filter((r) => !desiredPaths.has(r.export_path)).map((r) => r.export_path);

  const changed: ExportsDrift['changed'] = [];
  for (const entry of desired) {
    const row = observedByPath.get(entry.path);
    if (row === undefined) continue;
    const desiredHosts = new Map(entry.clients.map((c) => [c.host, canonicalOptions(c.options)]));
    const observedHosts = new Map(
      row.rules.map((r) => [r.host_pattern, canonicalOptions(r.options)]),
    );
    const details: string[] = [];
    for (const [host, opts] of desiredHosts) {
      const obs = observedHosts.get(host);
      if (obs === undefined) details.push(`host ${host} not exported`);
      else if (obs !== opts) details.push(`host ${host} options differ (${opts} vs ${obs})`);
    }
    for (const host of observedHosts.keys()) {
      if (!desiredHosts.has(host)) details.push(`host ${host} exported but not desired`);
    }
    if (details.length > 0) {
      changed.push({
        path: entry.path,
        detail: details.join('; '),
        desired: entry.clients,
        observed: row.rules,
      });
    }
  }

  return { missing, extra, changed };
}

export function driftNfsExportsCheck(
  desired: ExportEntry[],
  observed: ObservedExportRuleRow[],
): HealthCheckResult {
  if (desired.length === 0) {
    return {
      id: 'drift.nfs-exports',
      category: 'drift',
      status: 'skipped',
      symptom: 'no shares under management',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  const drift = compareExports(desired, observed);
  const clean =
    drift.missing.length === 0 && drift.extra.length === 0 && drift.changed.length === 0;
  if (clean) {
    return {
      id: 'drift.nfs-exports',
      category: 'drift',
      status: 'ok',
      symptom: 'exports match the desired shares',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  return {
    id: 'drift.nfs-exports',
    category: 'drift',
    status: 'degraded',
    symptom: `exports drifted from desired state (${drift.missing.length} missing, ${drift.extra.length} extra, ${drift.changed.length} changed)`,
    impact: 'clients may see wrong or missing exports; rollback safety reduced',
    evidence: { ...drift },
    recommended_action: 're-apply the affected shares (plan/apply) or remove out-of-band exports',
  };
}

export function driftNetplanCheck(
  desiredRows: DesiredIfaceSpec[],
  xinasFileHash: string | undefined,
): HealthCheckResult {
  const base = { id: 'drift.netplan', category: 'drift' as const };
  if (desiredRows.length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no network interfaces under desired-state management',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  if (xinasFileHash === undefined) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'netplan summary not yet observed',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  const expected = createHash('sha256').update(renderNetplan(desiredRows), 'utf8').digest('hex');
  if (expected === xinasFileHash) {
    return {
      ...base,
      status: 'ok',
      symptom: '99-xinas.yaml matches the desired render',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  return {
    ...base,
    status: 'degraded',
    symptom: '/etc/netplan/99-xinas.yaml differs from the desired-state render',
    impact: 'an out-of-band edit will be overwritten by the next network apply',
    evidence: { expected_hash: expected, observed_hash: xinasFileHash },
    recommended_action:
      're-apply network state (PATCH /network/interfaces/{id}) or adopt the manual edit into desired state',
  };
}

/**
 * drift.nfs-conf — consumes the probe's dry-render checksums when the
 * profile ran at `standard`/`deep`; `render === undefined` means the
 * probe did not run (quick) and `render === null` means it ran but the
 * helper section failed.
 */
export function driftNfsConfCheck(
  desiredProfile: Record<string, unknown> | null,
  render: Record<string, string> | null | undefined,
  effectiveFiles: Record<string, string>,
): HealthCheckResult {
  const base = { id: 'drift.nfs-conf', category: 'drift' as const };
  if (desiredProfile === null) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no NFS profile under desired-state management',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  if (render === undefined) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'requires the standard profile (helper dry-render oracle)',
      impact: 'none',
      evidence: {},
      recommended_action: 'GET /health?profile=standard',
    };
  }
  if (render === null) {
    return {
      ...base,
      status: 'degraded',
      symptom: 'the helper dry render failed — drift cannot be evaluated',
      impact: 'NFS profile drift is invisible until the helper recovers',
      evidence: {},
      recommended_action: 'systemctl status xinas-nfs-helper',
    };
  }
  const diffs: Array<{ path: string; expected: string; observed: string | null }> = [];
  for (const [path, expected] of Object.entries(render)) {
    const observed = effectiveFiles[path] ?? null;
    if (observed !== expected) diffs.push({ path, expected, observed });
  }
  if (diffs.length === 0) {
    return {
      ...base,
      status: 'ok',
      symptom: 'effective NFS files match the desired profile render',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  return {
    ...base,
    status: 'degraded',
    symptom: `${diffs.length} effective file(s) differ from the desired profile render`,
    impact: 'the running NFS configuration is not what the profile intends',
    evidence: { diffs },
    recommended_action: 're-apply the NFS profile (PATCH /nfs-profiles/default)',
  };
}
