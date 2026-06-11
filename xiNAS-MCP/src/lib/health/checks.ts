/**
 * The quick-profile health checks (S7 T2, ADR-0009 catalog) — pure
 * functions over {@link HealthFacts}. The two drift quick checks join
 * from drift.ts (T3); the standard/deep checks consume probe results
 * and live in the route integration (T6).
 */

import type { HealthCheckResult, HealthFacts, QuickCheck } from './engine.js';

const ok = (
  id: string,
  category: HealthCheckResult['category'],
  symptom: string,
  evidence: Record<string, unknown> = {},
): HealthCheckResult => ({
  id,
  category,
  status: 'ok',
  symptom,
  impact: 'none',
  evidence,
  recommended_action: 'no action required',
});

const skipped = (
  id: string,
  category: HealthCheckResult['category'],
  symptom: string,
): HealthCheckResult => ({
  id,
  category,
  status: 'skipped',
  symptom,
  impact: 'none',
  evidence: {},
  recommended_action: 'no action required',
});

export const apiAlive: QuickCheck = () =>
  ok('xinas-api.alive', 'api', 'xinas-api is responding');

export const agentConnectivity: QuickCheck = (facts) => {
  // The tracker's actual vocabulary: healthy | degraded | offline.
  // 'untracked' = no HeartbeatTracker wired (read-only contexts) —
  // that is "not measured", not "agent down".
  if (facts.agentState === 'untracked') {
    return skipped('agent.connectivity', 'agent', 'heartbeat tracker not wired');
  }
  if (facts.agentState === 'healthy') {
    return ok('agent.connectivity', 'agent', 'xinas-agent heartbeat healthy');
  }
  const offline = facts.agentState === 'offline';
  return {
    id: 'agent.connectivity',
    category: 'agent',
    status: offline ? 'critical' : 'degraded',
    symptom: `xinas-agent heartbeat is ${facts.agentState}`,
    impact: offline
      ? 'no observation refresh; all mutating operations unavailable'
      : 'observation refresh delayed; mutations may be slow',
    evidence: { agent_state: facts.agentState },
    recommended_action: 'systemctl status xinas-agent; journalctl -u xinas-agent',
  };
};

const ARRAY_DEGRADED_STATES = new Set(['initializing', 'init', 'rebuilding', 'reconstructing', 'restriping']);
const ARRAY_CRITICAL_STATES = new Set(['degraded', 'failed', 'offline', 'unknown', 'need_recon', 'read_only']);

export const xiraidArrays: QuickCheck = (facts) => {
  if (facts.arrays.length === 0) {
    return skipped('xiraid.arrays', 'xiraid', 'no xiRAID arrays observed');
  }
  const critical = facts.arrays.filter((a) =>
    ARRAY_CRITICAL_STATES.has((a.state ?? 'unknown').toLowerCase()),
  );
  const degraded = facts.arrays.filter((a) =>
    ARRAY_DEGRADED_STATES.has((a.state ?? '').toLowerCase()),
  );
  if (critical.length > 0) {
    return {
      id: 'xiraid.arrays',
      category: 'xiraid',
      status: 'critical',
      symptom: `${critical.length} array(s) unhealthy: ${critical.map((a) => `${a.id}=${a.state}`).join(', ')}`,
      impact: 'data redundancy reduced or lost on the listed arrays',
      evidence: { arrays: critical },
      recommended_action: 'inspect the array (GET /arrays/{id}); replace failed drives',
    };
  }
  if (degraded.length > 0) {
    return {
      id: 'xiraid.arrays',
      category: 'xiraid',
      status: 'degraded',
      symptom: `${degraded.length} array(s) busy: ${degraded.map((a) => `${a.id}=${a.state}`).join(', ')}`,
      impact: 'performance reduced while the operation completes',
      evidence: { arrays: degraded },
      recommended_action: 'wait for the operation to complete',
    };
  }
  return ok('xiraid.arrays', 'xiraid', `${facts.arrays.length} array(s) optimal`);
};

export const diskHealth: QuickCheck = (facts) => {
  const withHealth = facts.disks.filter((d) => d.health !== undefined);
  if (withHealth.length === 0) {
    return skipped('disk.health', 'xiraid', 'no disks report a health block');
  }
  const failed = withHealth.filter((d) => d.health?.ok === false);
  const worn = withHealth.filter(
    (d) => d.health?.ok !== false && (d.health?.wear_pct ?? 0) > 90,
  );
  if (failed.length > 0) {
    return {
      id: 'disk.health',
      category: 'xiraid',
      status: 'critical',
      symptom: `${failed.length} disk(s) report unhealthy: ${failed.map((d) => d.id).join(', ')}`,
      impact: 'imminent disk failure risk; arrays using them may degrade',
      evidence: { disks: failed.map((d) => ({ id: d.id, ...d.health })) },
      recommended_action: 'replace the listed disks',
    };
  }
  if (worn.length > 0) {
    return {
      id: 'disk.health',
      category: 'xiraid',
      status: 'warning',
      symptom: `${worn.length} disk(s) past 90% wear: ${worn.map((d) => d.id).join(', ')}`,
      impact: 'plan replacement before wear-out',
      evidence: { disks: worn.map((d) => ({ id: d.id, ...d.health })) },
      recommended_action: 'schedule disk replacement',
    };
  }
  return ok('disk.health', 'xiraid', `${withHealth.length} disk(s) healthy`);
};

export const filesystemMounts: QuickCheck = (facts) => {
  if (facts.filesystems.length === 0) {
    return skipped('filesystem.mounts', 'filesystem', 'no managed filesystems observed');
  }
  const broken = facts.filesystems.filter(
    (f) => f.mount_unit_enabled === true && f.mounted !== true,
  );
  if (broken.length > 0) {
    return {
      id: 'filesystem.mounts',
      category: 'filesystem',
      status: 'degraded',
      symptom: `${broken.length} enabled filesystem(s) not mounted: ${broken.map((f) => f.id).join(', ')}`,
      impact: 'exports on those mountpoints are unavailable',
      evidence: { filesystems: broken },
      recommended_action: 'PATCH /filesystems/{id} {mounted: true} or inspect journalctl',
    };
  }
  return ok('filesystem.mounts', 'filesystem', `${facts.filesystems.length} filesystem(s) consistent`);
};

export const nfsServer: QuickCheck = (facts) => {
  const unit = facts.systemdUnits.find((u) => u.id === 'nfs-server.service');
  if (unit === undefined) {
    return skipped('nfs.server', 'nfs', 'nfs-server.service not yet observed');
  }
  if (unit.active_state !== 'active') {
    return {
      id: 'nfs.server',
      category: 'nfs',
      status: 'critical',
      symptom: `nfs-server.service is ${unit.active_state ?? 'unknown'}`,
      impact: 'all NFS exports are unavailable',
      evidence: { unit },
      recommended_action: 'systemctl start nfs-server; journalctl -u nfs-server',
    };
  }
  return ok('nfs.server', 'nfs', 'nfs-server.service active');
};

export const nfsExports: QuickCheck = (facts) => {
  if (facts.desiredShares.length === 0) {
    return skipped('nfs.exports', 'nfs', 'no shares under management');
  }
  const exported = new Set(facts.exportRules.map((r) => r.export_path));
  const missing = facts.desiredShares.filter((s) => !exported.has(s.path));
  if (missing.length > 0) {
    return {
      id: 'nfs.exports',
      category: 'nfs',
      status: 'degraded',
      symptom: `${missing.length} share(s) not exported: ${missing.map((s) => s.id).join(', ')}`,
      impact: 'clients cannot mount the listed shares',
      evidence: { shares: missing.map((s) => ({ id: s.id, path: s.path })) },
      recommended_action: 'replan/apply the share or inspect the nfs-helper journal',
    };
  }
  return ok('nfs.exports', 'nfs', `${facts.desiredShares.length} share(s) exported`);
};

export const networkDuplicateNetplan: QuickCheck = (facts) => {
  const duplicates = facts.networkConfig?.duplicates ?? {};
  const entries = Object.entries(duplicates).filter(([, files]) => files.length > 0);
  if (facts.networkConfig === undefined) {
    return skipped('network.duplicate-netplan', 'network', 'netplan summary not yet observed');
  }
  if (entries.length > 0) {
    return {
      id: 'network.duplicate-netplan',
      category: 'network',
      status: 'critical',
      symptom: `managed interface(s) defined in foreign netplan files: ${entries
        .map(([iface, files]) => `${iface} (${files.join(', ')})`)
        .join('; ')}`,
      impact: 'netplan merges duplicate stanzas — phantom IPs and conflicting PBR rules',
      evidence: { duplicates },
      recommended_action: 'PATCH /network/interfaces/{id} with cleanup: true (audited repair)',
    };
  }
  return ok('network.duplicate-netplan', 'network', 'no duplicate netplan definitions');
};

export const networkRdmaReadiness: QuickCheck = (facts) => {
  const managed = facts.networkIfaces.filter((i) => i.rdma_capable === true);
  if (managed.length === 0) {
    return skipped('network.rdma-readiness', 'network', 'no RDMA-capable interfaces observed');
  }
  // Evidence shape preserved from the S6 route implementation: ALL
  // managed interfaces with `name`/state/address (the NFS-RDMA enable
  // gate consumes this list).
  const perIface = managed.map((i) => ({
    name: i.id,
    rdma_link_state: i.rdma_link_state ?? 'unknown',
    has_address: (i.current_addresses ?? []).length > 0,
  }));
  const notReady = perIface.filter((e) => e.rdma_link_state !== 'up' || !e.has_address);
  if (notReady.length > 0) {
    return {
      id: 'network.rdma-readiness',
      category: 'network',
      status: 'degraded',
      symptom: `${notReady.length} of ${perIface.length} RDMA interface(s) not ready: ${notReady
        .map((e) => e.name)
        .join(', ')}`,
      impact: 'NFS-RDMA mounts via the unready interfaces will fail or fall back to TCP',
      evidence: { interfaces: perIface },
      recommended_action: 'check cabling/SM and interface addressing',
    };
  }
  return {
    id: 'network.rdma-readiness',
    category: 'network',
    status: 'ok',
    symptom: `${perIface.length} RDMA interface(s) up and addressed`,
    impact: 'none',
    evidence: { interfaces: perIface },
    recommended_action: 'no action required',
  };
};

export const systemdUnits: QuickCheck = (facts) => {
  if (facts.systemdUnits.length === 0) {
    return skipped('systemd.units', 'systemd', 'no allow-listed units observed yet');
  }
  const failed = facts.systemdUnits.filter((u) => u.active_state === 'failed');
  if (failed.length > 0) {
    return {
      id: 'systemd.units',
      category: 'systemd',
      status: 'critical',
      symptom: `failed unit(s): ${failed.map((u) => u.id).join(', ')}`,
      impact: 'the listed services are down',
      evidence: { units: failed },
      recommended_action: 'journalctl -u <unit>; systemctl restart <unit>',
    };
  }
  return ok('systemd.units', 'systemd', `${facts.systemdUnits.length} unit(s) healthy`);
};

export const tuningSysctl: QuickCheck = (facts) => {
  const entries = facts.tuning?.entries ?? [];
  if (facts.tuning === undefined || entries.length === 0) {
    return skipped('tuning.sysctl', 'tuning', 'no xiNAS sysctl drop-ins observed');
  }
  const mismatched = entries.filter((e) => e.actual !== e.expected);
  if (mismatched.length > 0) {
    return {
      id: 'tuning.sysctl',
      category: 'tuning',
      status: 'warning',
      symptom: `${mismatched.length} sysctl(s) differ from the installed drop-ins`,
      impact: 'performance tuning partially inactive',
      evidence: { mismatched },
      recommended_action: 'sysctl --system (reload drop-ins) or re-run the perf_tuning role',
    };
  }
  return ok('tuning.sysctl', 'tuning', `${entries.length} sysctl(s) match the drop-ins`);
};

/** The non-drift quick catalog (drift checks join from drift.ts, T3). */
export const QUICK_CHECKS: QuickCheck[] = [
  apiAlive,
  agentConnectivity,
  xiraidArrays,
  diskHealth,
  filesystemMounts,
  nfsServer,
  nfsExports,
  networkDuplicateNetplan,
  networkRdmaReadiness,
  systemdUnits,
  tuningSysctl,
];
