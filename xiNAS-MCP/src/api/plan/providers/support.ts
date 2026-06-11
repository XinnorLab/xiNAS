/**
 * support.bundle plan provider (S7 T7, ADR-0009 §Bundle).
 *
 * Read-only diagnostic collection — no blockers, risk non_disruptive.
 * `affected_resources` is EMPTY (the public ResourceRef.kind enum is
 * closed and a bundle mutates no managed resource); serialization
 * rides the INTERNAL `lease_resources` override with the singleton
 * `SupportBundle/default` lease, so two bundle requests queue behind
 * each other instead of racing the work directory.
 *
 * The route injects `bundle_dir` (api config) into the spec; the
 * enriched spec adds the journal unit list + retention so the agent
 * executor needs no KV or config access.
 */

import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

/** Journal units collected into the bundle (60 min tail each). */
export const BUNDLE_JOURNAL_UNITS = [
  'xinas-api.service',
  'xinas-agent.service',
  'xinas-nfs-helper.service',
  'nfs-server.service',
  'xiraid.service',
];

/** Config files copied (redacted) into the bundle. */
export const BUNDLE_CONFIG_PATHS = [
  '/etc/exports',
  '/etc/nfs.conf',
  '/etc/nfs/nfsd.conf',
  '/etc/default/nfs-kernel-server',
  '/etc/modprobe.d/lockd.conf',
  '/etc/default/nfs-common',
  '/etc/netplan/99-xinas.yaml',
];

const BUNDLE_RETENTION = 3;

export interface SupportBundleSpec {
  bundle_dir: string;
}

export const supportBundleProvider: PlanProvider = {
  operation_kind: 'support.bundle',

  async preflight(_ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const spec = (rawSpec ?? {}) as Partial<SupportBundleSpec>;
    const bundleDir =
      typeof spec.bundle_dir === 'string' && spec.bundle_dir.length > 0
        ? spec.bundle_dir
        : '/var/log/xinas/bundles';

    return {
      affected_resources: [],
      blockers: [],
      warnings: [],
      diff: {
        collects: {
          journals: BUNDLE_JOURNAL_UNITS,
          configs: BUNDLE_CONFIG_PATHS,
          xiraid: ['license (parsed only)', 'raid show', 'pool show'],
          api: ['tasks', 'audit', 'observed state', 'desired state', 'health report'],
        },
        excludes: ['/etc/xinas-api', '/etc/xinas-agent', 'raw license material'],
      },
      risk_level: 'non_disruptive',
      rollback_model: 'executor_managed',
      lease_resources: [{ kind: 'SupportBundle', id: 'default' }],
      enriched_spec: {
        bundle_dir: bundleDir,
        journal_units: BUNDLE_JOURNAL_UNITS,
        config_paths: BUNDLE_CONFIG_PATHS,
        retention: BUNDLE_RETENTION,
      },
    };
  },
};
