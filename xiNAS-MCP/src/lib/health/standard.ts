/**
 * Standard/deep probe-backed checks (S7 T6, ADR-0009 catalog).
 *
 * Pure builders over the `health.probe` RPC result (structural types —
 * lib/ imports nothing from the agent). When the agent is unreachable
 * the route calls {@link probeUnavailable} instead: every probe-backed
 * check degrades with EXECUTOR_UNAVAILABLE evidence while the KV
 * checks still answer.
 */

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

/** Every probe-backed check degraded — the agent did not answer. */
export function probeUnavailable(level: 'standard' | 'deep', reason: string): HealthCheckResult[] {
  const ids: string[] = [...STANDARD_CHECK_IDS, ...(level === 'deep' ? DEEP_CHECK_IDS : [])];
  return ids.map((id) => ({
    id,
    category: CATEGORY_BY_ID[id] ?? 'agent',
    status: 'degraded',
    symptom: 'the agent probe did not answer',
    impact: 'probe-backed health is unknown; KV-derived checks remain valid',
    evidence: { code: 'EXECUTOR_UNAVAILABLE', reason },
    recommended_action: 'systemctl status xinas-agent',
  }));
}

export function xiraidLicenseCheck(license: ProbeLicense | null): HealthCheckResult {
  const base = { id: 'xiraid.license', category: 'xiraid' as const };
  if (license === null) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'xicli unavailable (xiRAID not installed?)',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  if (license.status !== 'active') {
    return {
      ...base,
      status: 'critical',
      symptom: `xiRAID license is ${license.status}`,
      impact: 'arrays keep running but management operations may be refused',
      evidence: { ...license },
      recommended_action: 'renew and install the xiRAID license',
    };
  }
  if (license.days_left !== null && license.days_left < 30) {
    return {
      ...base,
      status: 'warning',
      symptom: `xiRAID license expires in ${license.days_left} day(s)`,
      impact: 'management operations will be refused after expiry',
      evidence: { ...license },
      recommended_action: 'renew the xiRAID license before expiry',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'xiRAID license active',
    impact: 'none',
    evidence: { days_left: license.days_left },
    recommended_action: 'no action required',
  };
}

export function xiraidServiceCheck(collectors: Record<string, string>): HealthCheckResult {
  const base = { id: 'xiraid.service', category: 'xiraid' as const };
  const state = collectors['XiraidArray'] ?? collectors['xiraid'];
  if (state === undefined) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no xiraid collector registered',
      impact: 'none',
      evidence: { collectors: Object.keys(collectors) },
      recommended_action: 'no action required',
    };
  }
  if (state.startsWith('error')) {
    return {
      ...base,
      status: 'critical',
      symptom: 'the xiRAID daemon/API is unreachable from the agent',
      impact: 'array state is stale; RAID operations will fail',
      evidence: { collector_state: state },
      recommended_action: 'systemctl status xiraid; check the gRPC endpoint',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'xiRAID API reachable',
    impact: 'none',
    evidence: { collector_state: state },
    recommended_action: 'no action required',
  };
}

export function rdmaLiveCheck(links: ProbeRdmaLink[]): HealthCheckResult {
  const base = { id: 'network.rdma-live', category: 'network' as const };
  if (links.length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no RDMA links reported',
      impact: 'none',
      evidence: {},
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
      evidence: { links: down },
      recommended_action: 'check cabling/SM; compare against network.rdma-readiness',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `${links.length} RDMA link(s) ACTIVE (fresh)`,
    impact: 'none',
    evidence: {},
    recommended_action: 'no action required',
  };
}

export function agentCollectorsCheck(collectors: Record<string, string>): HealthCheckResult {
  const base = { id: 'agent.collectors', category: 'agent' as const };
  const errored = Object.entries(collectors).filter(([, state]) => state.startsWith('error'));
  if (Object.keys(collectors).length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no collector health reported',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  if (errored.length > 0) {
    return {
      ...base,
      status: 'degraded',
      symptom: `${errored.length} collector(s) erroring: ${errored.map(([n]) => n).join(', ')}`,
      impact: 'the affected observed resources are stale',
      evidence: { collectors: Object.fromEntries(errored) },
      recommended_action: 'journalctl -u xinas-agent',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: 'all collectors running',
    impact: 'none',
    evidence: {},
    recommended_action: 'no action required',
  };
}

export function filesystemIoCheck(fsIo: ProbeDeepResults['fs_io']): HealthCheckResult {
  const base = { id: 'filesystem.io', category: 'filesystem' as const };
  if (fsIo.length === 0) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no mounted managed filesystems to probe',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  const failed = fsIo.filter((r) => !r.ok);
  if (failed.length > 0) {
    return {
      ...base,
      status: 'critical',
      symptom: `I/O probe failed on: ${failed.map((r) => r.mountpoint).join(', ')}`,
      impact: 'the listed filesystems do not accept writes',
      evidence: { failed },
      recommended_action: 'check dmesg/journal for filesystem or RAID errors',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `I/O probe passed on ${fsIo.length} filesystem(s)`,
    impact: 'none',
    evidence: {},
    recommended_action: 'no action required',
  };
}

export function nfsLoopbackCheck(loopback: ProbeDeepResults['nfs_loopback']): HealthCheckResult {
  const base = { id: 'nfs.loopback', category: 'nfs' as const };
  if (loopback === null || !loopback.attempted) {
    return {
      ...base,
      status: 'skipped',
      symptom: 'no exports to loopback-mount',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  if (!loopback.ok) {
    return {
      ...base,
      status: 'critical',
      symptom: `loopback NFS mount of ${loopback.export ?? '?'} failed`,
      impact: 'clients likely cannot mount this server',
      evidence: { ...loopback },
      recommended_action: 'journalctl -u nfs-server; exportfs -v',
    };
  }
  return {
    ...base,
    status: 'ok',
    symptom: `loopback NFS mount of ${loopback.export ?? '?'} succeeded`,
    impact: 'none',
    evidence: {},
    recommended_action: 'no action required',
  };
}
