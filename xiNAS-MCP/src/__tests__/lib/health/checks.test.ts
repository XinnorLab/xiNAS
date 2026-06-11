import { describe, expect, it } from 'vitest';
import {
  QUICK_CHECKS,
  agentConnectivity,
  diskHealth,
  filesystemMounts,
  nfsExports,
  nfsServer,
  networkDuplicateNetplan,
  networkRdmaReadiness,
  systemdUnits,
  tuningSysctl,
  xiraidArrays,
} from '../../../lib/health/checks.js';
import { type HealthFacts, overallOf } from '../../../lib/health/engine.js';

export function emptyFacts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    agentState: 'healthy',
    arrays: [],
    disks: [],
    filesystems: [],
    systemdUnits: [],
    exportRules: [],
    desiredShares: [],
    desiredNetIfaces: [],
    networkIfaces: [],
    desiredNfsProfile: null,
    effectiveFiles: {},
    ...over,
  };
}

describe('overallOf', () => {
  it('folds the worst non-skipped status; empty/all-skipped → ok', () => {
    const c = (status: 'ok' | 'warning' | 'degraded' | 'critical' | 'skipped') => ({
      id: 'x',
      category: 'api' as const,
      status,
      symptom: '',
      impact: '',
      evidence: {},
      recommended_action: '',
    });
    expect(overallOf([])).toBe('ok');
    expect(overallOf([c('skipped'), c('skipped')])).toBe('ok');
    expect(overallOf([c('ok'), c('warning')])).toBe('warning');
    expect(overallOf([c('degraded'), c('warning')])).toBe('degraded');
    expect(overallOf([c('critical'), c('ok'), c('skipped')])).toBe('critical');
  });
});

describe('quick checks (table)', () => {
  it('agent.connectivity uses the tracker vocabulary', () => {
    expect(agentConnectivity(emptyFacts()).status).toBe('ok');
    expect(agentConnectivity(emptyFacts({ agentState: 'degraded' })).status).toBe('degraded');
    expect(agentConnectivity(emptyFacts({ agentState: 'offline' })).status).toBe('critical');
  });

  it('xiraid.arrays: optimal ok, rebuild degraded, failed critical, none skipped', () => {
    expect(xiraidArrays(emptyFacts()).status).toBe('skipped');
    expect(xiraidArrays(emptyFacts({ arrays: [{ id: 'a', state: 'online' }] })).status).toBe('ok');
    expect(xiraidArrays(emptyFacts({ arrays: [{ id: 'a', state: 'rebuilding' }] })).status).toBe(
      'degraded',
    );
    const critical = xiraidArrays(
      emptyFacts({
        arrays: [
          { id: 'a', state: 'degraded' },
          { id: 'b', state: 'online' },
        ],
      }),
    );
    expect(critical.status).toBe('critical');
    expect(critical.symptom).toContain('a=degraded');
  });

  it('disk.health: ok=false critical, wear>90 warning, no health blocks skipped', () => {
    expect(diskHealth(emptyFacts({ disks: [{ id: 'd1' }] })).status).toBe('skipped');
    expect(
      diskHealth(emptyFacts({ disks: [{ id: 'd1', health: { ok: true, wear_pct: 12 } }] })).status,
    ).toBe('ok');
    expect(
      diskHealth(emptyFacts({ disks: [{ id: 'd1', health: { ok: true, wear_pct: 95 } }] })).status,
    ).toBe('warning');
    expect(diskHealth(emptyFacts({ disks: [{ id: 'd1', health: { ok: false } }] })).status).toBe(
      'critical',
    );
  });

  it('filesystem.mounts: enabled-but-unmounted degraded', () => {
    expect(filesystemMounts(emptyFacts()).status).toBe('skipped');
    expect(
      filesystemMounts(
        emptyFacts({
          filesystems: [{ id: 'a.mount', mounted: true, mount_unit_enabled: true }],
        }),
      ).status,
    ).toBe('ok');
    const broken = filesystemMounts(
      emptyFacts({
        filesystems: [{ id: 'a.mount', mounted: false, mount_unit_enabled: true }],
      }),
    );
    expect(broken.status).toBe('degraded');
    expect(broken.symptom).toContain('a.mount');
  });

  it('nfs.server from the observed unit; nfs.exports from desired-vs-ExportRule', () => {
    expect(nfsServer(emptyFacts()).status).toBe('skipped');
    expect(
      nfsServer(
        emptyFacts({ systemdUnits: [{ id: 'nfs-server.service', active_state: 'active' }] }),
      ).status,
    ).toBe('ok');
    expect(
      nfsServer(
        emptyFacts({ systemdUnits: [{ id: 'nfs-server.service', active_state: 'inactive' }] }),
      ).status,
    ).toBe('critical');

    expect(nfsExports(emptyFacts()).status).toBe('skipped');
    const facts = emptyFacts({
      desiredShares: [{ id: 's1', path: '/mnt/a' }],
      exportRules: [],
    });
    expect(nfsExports(facts).status).toBe('degraded');
    facts.exportRules = [{ export_path: '/mnt/a', options: ['rw'] }];
    expect(nfsExports(facts).status).toBe('ok');
  });

  it('network checks mirror the S6 logic over facts', () => {
    expect(networkDuplicateNetplan(emptyFacts()).status).toBe('skipped');
    expect(networkDuplicateNetplan(emptyFacts({ networkConfig: { duplicates: {} } })).status).toBe(
      'ok',
    );
    expect(
      networkDuplicateNetplan(
        emptyFacts({ networkConfig: { duplicates: { ibp0: ['/etc/netplan/50-x.yaml'] } } }),
      ).status,
    ).toBe('critical');

    expect(networkRdmaReadiness(emptyFacts()).status).toBe('skipped');
    expect(
      networkRdmaReadiness(
        emptyFacts({
          networkIfaces: [
            {
              id: 'ib0',
              rdma_capable: true,
              rdma_link_state: 'up',
              current_addresses: ['10.0.0.1/24'],
            },
          ],
        }),
      ).status,
    ).toBe('ok');
    expect(
      networkRdmaReadiness(
        emptyFacts({
          networkIfaces: [
            {
              id: 'ib0',
              rdma_capable: true,
              rdma_link_state: 'down',
              current_addresses: ['10.0.0.1/24'],
            },
          ],
        }),
      ).status,
    ).toBe('degraded');
  });

  it('systemd.units failed critical; tuning mismatches warn', () => {
    expect(systemdUnits(emptyFacts()).status).toBe('skipped');
    expect(
      systemdUnits(
        emptyFacts({ systemdUnits: [{ id: 'rpcbind.service', active_state: 'failed' }] }),
      ).status,
    ).toBe('critical');

    expect(tuningSysctl(emptyFacts()).status).toBe('skipped');
    expect(
      tuningSysctl(
        emptyFacts({
          tuning: { entries: [{ key: 'vm.swappiness', expected: '1', actual: '1' }] },
        }),
      ).status,
    ).toBe('ok');
    const warn = tuningSysctl(
      emptyFacts({
        tuning: { entries: [{ key: 'vm.swappiness', expected: '1', actual: '60' }] },
      }),
    );
    expect(warn.status).toBe('warning');
    expect(warn.evidence.mismatched).toEqual([
      { key: 'vm.swappiness', expected: '1', actual: '60' },
    ]);
  });

  it('every quick check returns the full contract shape on empty facts', () => {
    for (const check of QUICK_CHECKS) {
      const r = check(emptyFacts());
      expect(r.id).toBeTruthy();
      expect(r.category).toBeTruthy();
      expect(['ok', 'warning', 'degraded', 'critical', 'skipped']).toContain(r.status);
      expect(typeof r.symptom).toBe('string');
      expect(typeof r.impact).toBe('string');
      expect(typeof r.recommended_action).toBe('string');
    }
  });
});
