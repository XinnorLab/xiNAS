/**
 * Standard/deep probe-backed checks (S7 T6, ADR-0009 catalog; S19a T1,
 * spec §7.2).
 *
 * Pure builders over the `health.probe` schema-2 sections (structural
 * types — lib/ imports nothing from the agent). Every builder starts with
 * {@link collectionFailureCheck}: a `not_supported` section (the tool is
 * not installed) is the ONLY one that becomes `skipped`; `error`,
 * `timeout` and `permission_denied` become `degraded` with the collection
 * status in the evidence, so a failed query never reads like an absent
 * component and never disappears from `overall`. A successful section
 * runs the check's own logic over `section.value` and still carries the
 * collection evidence, so "asked and found none" stays distinguishable
 * from "could not ask". When the agent is unreachable the route calls
 * {@link probeUnavailable} instead.
 */

import { type Section, collectionEvidence, isCollectionFailure } from './collection.js';
import type { HealthCheckResult } from './engine.js';

export interface ProbeLicense {
  status: 'active' | 'expired' | 'absent';
  days_left: number | null;
  features: string[];
}

export interface ProbeRdmaLink {
  netdev?: string;
  ifname?: string;
  state?: string;
  physical_state?: string;
}

export interface ProbeDeepResults {
  fs_io: Array<{ mountpoint: string; ok: boolean; error?: string }>;
  nfs_loopback: { attempted: boolean; export?: string; ok: boolean; error?: string } | null;
}

const STANDARD_CHECK_IDS = [
  'xiraid.license',
  'xiraid.service',
  'network.rdma-live',
  'agent.collectors',
  'drift.nfs-conf',
] as const;
const DEEP_CHECK_IDS = ['filesystem.io', 'nfs.loopback'] as const;

const CATEGORY_BY_ID: Record<string, HealthCheckResult['category']> = {
  'xiraid.license': 'xiraid',
  'xiraid.service': 'xiraid',
  'network.rdma-live': 'network',
  'agent.collectors': 'agent',
  'drift.nfs-conf': 'drift',
  'filesystem.io': 'filesystem',
  'nfs.loopback': 'nfs',
};

const RECOMMENDED_BY_STATUS: Record<string, string> = {
  timeout: 'the source did not answer in time; re-run the profile and check agent load',
  permission_denied: 'the agent lacks permission to read this source; check the unit capabilities',
  error: 'inspect the agent journal (journalctl -u xinas-agent) for the collection error',
};

/**
 * Spec §7.2 — the shared prelude of every probe-backed builder. Returns
 * the check to emit for a section that did not collect successfully, or
 * `undefined` so the builder can run its own logic over `section.value`.
 */
export function collectionFailureCheck(
  base: { id: string; category: HealthCheckResult['category'] },
  section: Section<unknown>,
): HealthCheckResult | undefined {
  if (section.status === 'success') return undefined;
  const collection = collectionEvidence(section);
  if (section.status === 'not_supported') {
    return {
      ...base,
      status: 'skipped',
      symptom: `${section.error?.code === 'TOOL_ABSENT' ? 'tool' : (section.error?.code ?? 'source')} not installed`,
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  if (!isCollectionFailure(section.status)) return undefined;
  return {
    ...base,
    status: 'degraded',
    symptom: `collection failed: ${section.error?.code ?? section.status}`,
    impact: 'the state behind this check is unknown',
    evidence: { collection },
    recommended_action: RECOMMENDED_BY_STATUS[section.status] ?? RECOMMENDED_BY_STATUS.error,
  };
}

/** Every probe-backed check degraded — the agent did not answer. */
export function probeUnavailable(level: 'standard' | 'deep', reason: string): HealthCheckResult[] {
  const ids: string[] = [...STANDARD_CHECK_IDS, ...(level === 'deep' ? DEEP_CHECK_IDS : [])];
  return ids.map((id) => ({
    id,
    category: CATEGORY_BY_ID[id] ?? 'agent',
    status: 'degraded',
    symptom: 'the agent probe did not answer',
    impact: 'probe-backed health is unknown; KV-derived checks remain valid',
    evidence: {
      code: 'EXECUTOR_UNAVAILABLE',
      reason,
      collection: {
        status: 'error',
        observed_at: null,
        code: 'EXECUTOR_UNAVAILABLE',
        message: reason,
      },
    },
    recommended_action: 'systemctl status xinas-agent',
  }));
}

export function xiraidLicenseCheck(section: Section<ProbeLicense | null>): HealthCheckResult {
  const base = { id: 'xiraid.license', category: 'xiraid' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const license = section.value ?? null;
  if (license === null) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'xicli printed no license record',
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  if (license.status !== 'active') {
    return {
      ...base,
      status: 'critical',
      symptom: `xiRAID license is ${license.status}`,
      impact: 'arrays keep running but management operations may be refused',
      evidence: { ...license, collection },
      recommended_action: 'renew and install the xiRAID license',
    };
  }
  if (license.days_left !== null && license.days_left < 30) {
    return {
      ...base,
      status: 'warning',
      symptom: `xiRAID license expires in ${license.days_left} day(s)`,
      impact: 'management operations will be refused after expiry',
      evidence: { ...license, collection },
      recommended_action: 'renew the xiRAID license before expiry',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'xiRAID license active',
    impact: 'none',
    evidence: { days_left: license.days_left, collection },
    recommended_action: 'no action required',
  };
}

export function xiraidServiceCheck(section: Section<Record<string, string>>): HealthCheckResult {
  const base = { id: 'xiraid.service', category: 'xiraid' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const collectors = section.value ?? {};
  const state = collectors['XiraidArray'] ?? collectors['xiraid'];
  if (state === undefined) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no xiraid collector registered',
      impact: 'none',
      evidence: { collectors: Object.keys(collectors), collection },
      recommended_action: 'no action required',
    };
  }
  if (state.startsWith('error')) {
    return {
      ...base,
      status: 'critical',
      symptom: 'the xiRAID daemon/API is unreachable from the agent',
      impact: 'array state is stale; RAID operations will fail',
      evidence: { collector_state: state, collection },
      recommended_action: 'systemctl status xiraid; check the gRPC endpoint',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'xiRAID API reachable',
    impact: 'none',
    evidence: { collector_state: state, collection },
    recommended_action: 'no action required',
  };
}

export function rdmaLiveCheck(section: Section<ProbeRdmaLink[]>): HealthCheckResult {
  const base = { id: 'network.rdma-live', category: 'network' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const links = section.value ?? [];
  if (links.length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no RDMA links reported',
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  const down = links.filter((l) => (l.state ?? '').toUpperCase() !== 'ACTIVE');
  if (down.length > 0) {
    return {
      ...base,
      status: 'degraded',
      symptom: `${down.length} RDMA link(s) not ACTIVE right now: ${down
        .map((l) => l.ifname ?? l.netdev ?? 'unknown')
        .join(', ')}`,
      impact: 'a link dropped since the last observation sweep',
      evidence: { links: down, collection },
      recommended_action: 'check cabling/SM; compare against network.rdma-readiness',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `${links.length} RDMA link(s) ACTIVE (fresh)`,
    impact: 'none',
    evidence: { collection },
    recommended_action: 'no action required',
  };
}

export function agentCollectorsCheck(section: Section<Record<string, string>>): HealthCheckResult {
  const base = { id: 'agent.collectors', category: 'agent' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const collectors = section.value ?? {};
  const errored = Object.entries(collectors).filter(([, state]) => state.startsWith('error'));
  if (Object.keys(collectors).length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no collector health reported',
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  if (errored.length > 0) {
    return {
      ...base,
      status: 'degraded',
      symptom: `${errored.length} collector(s) erroring: ${errored.map(([n]) => n).join(', ')}`,
      impact: 'the affected observed resources are stale',
      evidence: { collectors: Object.fromEntries(errored), collection },
      recommended_action: 'journalctl -u xinas-agent',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'all collectors running',
    impact: 'none',
    evidence: { collection },
    recommended_action: 'no action required',
  };
}

export function filesystemIoCheck(section: Section<ProbeDeepResults>): HealthCheckResult {
  const base = { id: 'filesystem.io', category: 'filesystem' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const fsIo = section.value?.fs_io ?? [];
  if (fsIo.length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no mounted managed filesystems to probe',
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  const failedRows = fsIo.filter((r) => !r.ok);
  if (failedRows.length > 0) {
    return {
      ...base,
      status: 'critical',
      symptom: `I/O probe failed on: ${failedRows.map((r) => r.mountpoint).join(', ')}`,
      impact: 'the listed filesystems do not accept writes',
      evidence: { failed: failedRows, collection },
      recommended_action: 'check dmesg/journal for filesystem or RAID errors',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `I/O probe passed on ${fsIo.length} filesystem(s)`,
    impact: 'none',
    evidence: { collection },
    recommended_action: 'no action required',
  };
}

export function nfsLoopbackCheck(section: Section<ProbeDeepResults>): HealthCheckResult {
  const base = { id: 'nfs.loopback', category: 'nfs' as const };
  const failed = collectionFailureCheck(base, section);
  if (failed !== undefined) return failed;
  const collection = collectionEvidence(section);
  const loopback = section.value?.nfs_loopback ?? null;
  if (loopback === null || !loopback.attempted) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no exports to loopback-mount',
      impact: 'none',
      evidence: { collection },
      recommended_action: 'no action required',
    };
  }
  if (!loopback.ok) {
    return {
      ...base,
      status: 'critical',
      symptom: `loopback NFS mount of ${loopback.export ?? '?'} failed`,
      impact: 'clients likely cannot mount this server',
      evidence: { ...loopback, collection },
      recommended_action: 'journalctl -u nfs-server; exportfs -v',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `loopback NFS mount of ${loopback.export ?? '?'} succeeded`,
    impact: 'none',
    evidence: { collection },
    recommended_action: 'no action required',
  };
}
