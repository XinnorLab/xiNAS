import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nfsProducer, unitTransition } from '../../../api/events/producers/nfs.js';
import { type Harness, OBSERVED_AT, type Row, makeHarness, types } from './_engine-harness.js';

const unitRow = (id: string, active: string, load = 'loaded'): Row => ({
  kind: 'SystemdUnit',
  id,
  status: {
    load_state: load,
    active_state: active,
    sub_state: active === 'active' ? 'running' : 'dead',
    observed_at: OBSERVED_AT,
  },
});

interface Rule {
  host_pattern: string;
  options: string[];
  squash_mode?: string;
  anon_uid?: number;
}
const exportRow = (path: string, rules: Rule[]): Row => ({
  kind: 'ExportRule',
  id: path.replace(/^\//, ''),
  spec: { export_path: path },
  status: { rules, observed_at: OBSERVED_AT },
});

const fsRow = (
  id: string,
  mountpoint: string,
  o: { mounted?: boolean; unitState?: string; ro?: boolean } = {},
): Row => ({
  kind: 'Filesystem',
  id,
  status: {
    mountpoint,
    mounted: o.mounted ?? true,
    mount_unit_state: o.unitState ?? 'active',
    effective_mount_options: o.ro ? ['ro'] : ['rw'],
    observed_at: OBSERVED_AT,
  },
});

const profileRow = (listening: boolean): Row => ({
  kind: 'NfsProfile',
  id: 'default',
  status: { rdma_listening: listening, rdma_port: 20049, observed_at: OBSERVED_AT },
});

/** The same row with `effective_mount_options` absent (the collector could not read them). */
const fsRowNoOptions = (id: string, mountpoint: string, o: { mounted?: boolean } = {}): Row => {
  const row = fsRow(id, mountpoint, o);
  delete (row.status as Record<string, unknown>).effective_mount_options;
  return row;
};
const profileRowNoListener = (): Row => ({
  kind: 'NfsProfile',
  id: 'default',
  status: { rdma_port: 20049, observed_at: OBSERVED_AT },
});

const ifaceRow = (id: string, rdma: 'up' | 'down' | 'unknown', capable = true): Row => ({
  kind: 'NetworkInterface',
  id,
  status: {
    name: id,
    rdma_capable: capable,
    rdma_link_state: rdma,
    link_state: 'up',
    observed_at: OBSERVED_AT,
  },
});

describe('unitTransition (S17 §8.5)', () => {
  it.each([
    ['active', 'failed', 'unavailable', 'unit_failed'],
    ['active', 'inactive', 'unavailable', 'unit_inactive'],
    ['active', 'deactivating', 'unavailable', 'unit_inactive'],
    ['activating', 'failed', 'unavailable', 'unit_failed'],
    ['failed', 'active', 'recovered', undefined],
    ['inactive', 'active', 'recovered', undefined],
    ['activating', 'active', 'recovered', undefined],
    ['active', 'active', null, undefined],
    ['inactive', 'inactive', null, undefined],
    ['inactive', 'activating', null, undefined],
  ])('%s → %s is %s', (prev, cur, kind, reason) => {
    const t = unitTransition(unitRow('x.service', prev), unitRow('x.service', cur));
    if (kind === null) expect(t).toBeNull();
    else expect(t).toEqual({ kind, reason });
  });

  it('a not-found or masked unit never transitions', () => {
    expect(
      unitTransition(unitRow('x.service', 'active'), unitRow('x.service', 'inactive', 'not-found')),
    ).toBeNull();
    expect(
      unitTransition(unitRow('x.service', 'inactive', 'masked'), unitRow('x.service', 'active')),
    ).toBeNull();
  });
});

describe('NFS producer (S17 §8.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [nfsProducer] });
  });
  afterEach(() => h.close());

  describe('services', () => {
    it('nfs-server active → failed → active', () => {
      let ev = h.step(
        'SystemdUnit',
        'nfs-server.service',
        unitRow('nfs-server.service', 'active'),
        unitRow('nfs-server.service', 'failed'),
      );
      expect(types(ev)).toEqual(['nfs.service.unavailable']);
      expect(ev[0]).toMatchObject({
        feed: 'nfs',
        severity: 'error',
        reasonCode: 'unit_failed',
        subject: { kind: 'SystemdUnit', id: 'nfs-server.service' },
        details: { unit: 'nfs-server.service', activeState: 'failed', loadState: 'loaded' },
      });
      ev = h.step(
        'SystemdUnit',
        'nfs-server.service',
        unitRow('nfs-server.service', 'failed'),
        unitRow('nfs-server.service', 'active'),
      );
      expect(types(ev)).toEqual(['nfs.service.recovered']);
      expect(ev[0]?.previous).toMatchObject({ severity: 'error' });
    });

    it('ignores units outside the NFS set and first observations', () => {
      expect(
        types(
          h.step(
            'SystemdUnit',
            'xinas-agent.service',
            unitRow('xinas-agent.service', 'active'),
            unitRow('xinas-agent.service', 'failed'),
          ),
        ),
      ).toEqual([]);
      expect(
        types(
          h.step(
            'SystemdUnit',
            'nfs-mountd.service',
            null,
            unitRow('nfs-mountd.service', 'failed'),
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('exports', () => {
    const rules1: Rule[] = [{ host_pattern: '10.0.0.0/24', options: ['rw', 'sync'] }];
    it('ordering-only option differences produce nothing', () => {
      const ev = h.step(
        'ExportRule',
        'srv/data',
        exportRow('/srv/data', rules1),
        exportRow('/srv/data', [{ host_pattern: '10.0.0.0/24', options: ['sync', 'rw', 'rw'] }]),
      );
      expect(types(ev)).toEqual([]);
    });

    it('changed options, added and removed hosts', () => {
      let ev = h.step(
        'ExportRule',
        'srv/data',
        exportRow('/srv/data', rules1),
        exportRow('/srv/data', [
          { host_pattern: '10.0.0.0/24', options: ['rw', 'sync', 'no_root_squash'] },
        ]),
      );
      expect(types(ev)).toEqual(['nfs.export.changed']);
      expect(ev[0]).toMatchObject({
        subject: { kind: 'ExportRule', id: '/srv/data' },
        details: { exportPath: '/srv/data', hostPattern: '10.0.0.0/24' },
        summary: 'NFS export /srv/data for 10.0.0.0/24: changed',
      });
      expect(ev[0]?.previous).toEqual({ options: ['rw', 'sync'] });
      expect(ev[0]?.current).toEqual({ options: ['no_root_squash', 'rw', 'sync'] });
      ev = h.step(
        'ExportRule',
        'srv/data',
        exportRow('/srv/data', rules1),
        exportRow('/srv/data', [...rules1, { host_pattern: '*', options: ['ro'] }]),
      );
      expect(types(ev)).toEqual(['nfs.export.added']);
      expect(ev[0]?.details).toMatchObject({ hostPattern: '*' });
      ev = h.step(
        'ExportRule',
        'srv/data',
        exportRow('/srv/data', [...rules1, { host_pattern: '*', options: ['ro'] }]),
        exportRow('/srv/data', rules1),
      );
      expect(types(ev)).toEqual(['nfs.export.removed']);
    });

    it('a row created after the baseline adds each rule; a deleted row removes each rule', () => {
      expect(types(h.step('ExportRule', 'srv/data', null, exportRow('/srv/data', rules1)))).toEqual(
        [],
      );
      h.snapshot('ExportRule', ['srv/data']);
      const two: Rule[] = [...rules1, { host_pattern: '*', options: ['ro'] }];
      expect(types(h.step('ExportRule', 'srv/b', null, exportRow('/srv/b', two)))).toEqual([
        'nfs.export.added',
        'nfs.export.added',
      ]);
      expect(types(h.step('ExportRule', 'srv/b', exportRow('/srv/b', two), null))).toEqual([
        'nfs.export.removed',
        'nfs.export.removed',
      ]);
    });
  });

  describe('backing filesystem readiness', () => {
    beforeEach(() => {
      h.kv.put(
        'ExportRule',
        'srv/data',
        exportRow('/srv/data', [{ host_pattern: '*', options: ['rw'] }]),
      );
      h.kv.put(
        'ExportRule',
        'srv/data2',
        exportRow('/srv/data2', [{ host_pattern: '*', options: ['rw'] }]),
      );
      h.kv.put(
        'ExportRule',
        'srv/data/proj',
        exportRow('/srv/data/proj', [{ host_pattern: '*', options: ['rw'] }]),
      );
      h.kv.put('Filesystem', 'srv-data2.mount', fsRow('srv-data2.mount', '/srv/data2'));
    });

    it('an unmounted filesystem makes its exports (path-boundary safe) unavailable, and back', () => {
      let ev = h.step(
        'Filesystem',
        'srv-data.mount',
        fsRow('srv-data.mount', '/srv/data'),
        fsRow('srv-data.mount', '/srv/data', { mounted: false, unitState: 'inactive' }),
      );
      expect(types(ev)).toEqual([
        'nfs.export.backing_unavailable',
        'nfs.export.backing_unavailable',
      ]);
      expect(ev.map((e) => e.subject.id).sort()).toEqual(['/srv/data', '/srv/data/proj']);
      expect(ev[0]?.details).toMatchObject({
        mountpoint: '/srv/data',
        filesystem: 'srv-data.mount',
        reason: 'unmounted',
      });
      expect(ev[0]?.relatedResources).toEqual([{ kind: 'Filesystem', id: 'srv-data.mount' }]);
      ev = h.step(
        'Filesystem',
        'srv-data.mount',
        fsRow('srv-data.mount', '/srv/data', { mounted: false }),
        fsRow('srv-data.mount', '/srv/data'),
      );
      expect(types(ev)).toEqual(['nfs.export.backing_recovered', 'nfs.export.backing_recovered']);
    });

    it('read-only or a failed unit is unavailable too; the same state twice is nothing', () => {
      let ev = h.step(
        'Filesystem',
        'srv-data2.mount',
        fsRow('srv-data2.mount', '/srv/data2'),
        fsRow('srv-data2.mount', '/srv/data2', { ro: true }),
      );
      expect(types(ev)).toEqual(['nfs.export.backing_unavailable']);
      expect(ev[0]?.details).toMatchObject({ reason: 'ro_option' });
      ev = h.step(
        'Filesystem',
        'srv-data2.mount',
        fsRow('srv-data2.mount', '/srv/data2', { ro: true }),
        fsRow('srv-data2.mount', '/srv/data2', { ro: true, unitState: 'failed' }),
      );
      expect(types(ev)).toEqual([]);
    });

    it('an export appearing over an unmounted filesystem records the state silently, then transitions', () => {
      h.snapshot('ExportRule', ['srv/data', 'srv/data2', 'srv/data/proj']);
      h.kv.put('Filesystem', 'srv-x.mount', fsRow('srv-x.mount', '/srv/x', { mounted: false }));
      expect(
        types(
          h.step(
            'ExportRule',
            'srv/x',
            null,
            exportRow('/srv/x', [{ host_pattern: '*', options: ['rw'] }]),
          ),
        ),
      ).toEqual(['nfs.export.added']);
      const ev = h.step(
        'Filesystem',
        'srv-x.mount',
        fsRow('srv-x.mount', '/srv/x', { mounted: false }),
        fsRow('srv-x.mount', '/srv/x'),
      );
      expect(types(ev)).toEqual(['nfs.export.backing_recovered']);
    });

    it('missing effective_mount_options keeps the last proven state: no false recovery after a read-only fault (I-02)', () => {
      const id = 'srv-data2.mount';
      let ev = h.step(
        'Filesystem',
        id,
        fsRow(id, '/srv/data2'),
        fsRow(id, '/srv/data2', { ro: true }),
      );
      expect(types(ev)).toEqual(['nfs.export.backing_unavailable']);
      ev = h.step(
        'Filesystem',
        id,
        fsRow(id, '/srv/data2', { ro: true }),
        fsRowNoOptions(id, '/srv/data2'),
      );
      expect(types(ev)).toEqual([]);
      expect(h.journal.metaGet('backing_unavailable:srv/data2')).toBe(true);
      ev = h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2'), fsRow(id, '/srv/data2'));
      expect(types(ev)).toEqual(['nfs.export.backing_recovered']);
    });

    it('missing fields while available are silent; a missing mounted flag is unknown too', () => {
      const id = 'srv-data2.mount';
      expect(
        types(h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2'))),
      ).toEqual([]);
      const noMounted = fsRow(id, '/srv/data2');
      delete (noMounted.status as Record<string, unknown>).mounted;
      expect(types(h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2'), noMounted))).toEqual(
        [],
      );
      expect(h.journal.metaGet('backing_unavailable:srv/data2')).toBeNull();
    });

    it('unknown before any proven state: the first proven fault is reported once, a failed unit is proven even with missing fields', () => {
      const id = 'srv-data2.mount';
      expect(
        types(h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2'))),
      ).toEqual([]);
      const ev = h.step(
        'Filesystem',
        id,
        fsRowNoOptions(id, '/srv/data2'),
        fsRowNoOptions(id, '/srv/data2', { mounted: false }),
      );
      expect(types(ev)).toEqual(['nfs.export.backing_unavailable']);
      expect(ev[0]?.details).toMatchObject({ reason: 'unmounted' });
      const failed = fsRowNoOptions(id, '/srv/data2', { mounted: false });
      (failed.status as Record<string, unknown>).mount_unit_state = 'failed';
      expect(
        types(
          h.step('Filesystem', id, fsRowNoOptions(id, '/srv/data2', { mounted: false }), failed),
        ),
      ).toEqual([]);
    });

    it('an incomplete row is logged as a source problem, not journaled', () => {
      h.close();
      const logs: unknown[] = [];
      h = makeHarness({
        producers: [nfsProducer],
        log: (level, msg, fields) => logs.push([level, msg, fields]),
      });
      h.kv.put(
        'ExportRule',
        'srv/data2',
        exportRow('/srv/data2', [{ host_pattern: '*', options: ['rw'] }]),
      );
      const id = 'srv-data2.mount';
      h.step('Filesystem', id, fsRow(id, '/srv/data2'), fsRowNoOptions(id, '/srv/data2'));
      expect(logs).toContainEqual([
        'warn',
        'event_source_incomplete',
        expect.objectContaining({
          kind: 'Filesystem',
          id,
          missing: ['effective_mount_options'],
          kept: 'available',
        }),
      ]);
    });
  });

  describe('NFS over RDMA readiness', () => {
    const desired = (enabled: boolean) =>
      h.kv.putKey('/xinas/v1/desired/NfsProfile/default', {
        kind: 'NfsProfile',
        id: 'default',
        spec: { rdma: { enabled, port: 20049 } },
      });
    const managed = (id: string) =>
      h.kv.putKey(`/xinas/v1/desired/NetworkInterface/${id}`, {
        kind: 'NetworkInterface',
        id,
        spec: { managed_by_xinas: true },
      });

    it('the serving path flips with the interface link and the listener', () => {
      desired(true);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      let ev = h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'down'));
      expect(types(ev)).toEqual(['nfs.rdma.unavailable']);
      expect(ev[0]).toMatchObject({
        subject: { kind: 'SystemdUnit', id: 'nfs-server.service' },
        details: { listening: true, interfaces: [] },
      });
      expect(ev[0]?.relatedResources).toEqual([{ kind: 'NetworkInterface', id: 'ib0' }]);
      ev = h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'down'), ifaceRow('ib0', 'up'));
      expect(types(ev)).toEqual(['nfs.rdma.recovered']);
      expect(ev[0]?.details).toMatchObject({ interfaces: ['ib0'] });
      ev = h.step('NfsProfile', 'default', profileRow(true), profileRow(false));
      expect(types(ev)).toEqual(['nfs.rdma.unavailable']);
    });

    it('is silent when RDMA is not configured, when inputs are missing, or on a first observation', () => {
      desired(false);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      expect(
        types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'down'))),
      ).toEqual([]);
      desired(true);
      h.kv.remove('NfsProfile', 'default');
      expect(
        types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'down'), ifaceRow('ib0', 'up'))),
      ).toEqual([]);
      h.kv.put('NfsProfile', 'default', profileRow(true));
      expect(types(h.step('NetworkInterface', 'ib1', null, ifaceRow('ib1', 'down')))).toEqual([]);
    });

    it('an unmanaged non-RDMA interface does not count', () => {
      desired(true);
      h.kv.put('NfsProfile', 'default', profileRow(true));
      managed('ib0');
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      h.kv.put('NetworkInterface', 'eth0', ifaceRow('eth0', 'up', false));
      const ev = h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'down'));
      expect(types(ev)).toEqual(['nfs.rdma.unavailable']);
    });

    it('a link turning unknown keeps the last proven state; a proven down is unavailable; a proven up recovers (I-02)', () => {
      desired(true);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      expect(
        types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'unknown'))),
      ).toEqual([]);
      expect(
        types(
          h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'unknown'), ifaceRow('ib0', 'down')),
        ),
      ).toEqual(['nfs.rdma.unavailable']);
      expect(
        types(
          h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'down'), ifaceRow('ib0', 'unknown')),
        ),
      ).toEqual([]);
      expect(
        types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'unknown'), ifaceRow('ib0', 'up'))),
      ).toEqual(['nfs.rdma.recovered']);
    });

    it('with two managed paths: one proven up is ready; one unknown plus one down is undecided; both down is unavailable', () => {
      desired(true);
      managed('ib0');
      managed('ib1');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      h.kv.put('NetworkInterface', 'ib1', ifaceRow('ib1', 'up'));
      expect(
        types(h.step('NetworkInterface', 'ib1', ifaceRow('ib1', 'up'), ifaceRow('ib1', 'down'))),
      ).toEqual([]);
      expect(
        types(h.step('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'), ifaceRow('ib0', 'unknown'))),
      ).toEqual([]);
      const ev = h.step(
        'NetworkInterface',
        'ib0',
        ifaceRow('ib0', 'unknown'),
        ifaceRow('ib0', 'down'),
      );
      expect(types(ev)).toEqual(['nfs.rdma.unavailable']);
      expect(ev[0]?.details).toMatchObject({ interfaces: [] });
    });

    it('a listener whose state is not observed leaves the last proven state; a proven false listener is unavailable', () => {
      desired(true);
      managed('ib0');
      h.kv.put('NfsProfile', 'default', profileRow(true));
      h.kv.put('NetworkInterface', 'ib0', ifaceRow('ib0', 'up'));
      expect(
        types(h.step('NfsProfile', 'default', profileRow(true), profileRowNoListener())),
      ).toEqual([]);
      expect(
        types(h.step('NfsProfile', 'default', profileRowNoListener(), profileRow(false))),
      ).toEqual(['nfs.rdma.unavailable']);
      expect(
        types(h.step('NfsProfile', 'default', profileRow(false), profileRowNoListener())),
      ).toEqual([]);
      expect(
        types(h.step('NfsProfile', 'default', profileRowNoListener(), profileRow(true))),
      ).toEqual(['nfs.rdma.recovered']);
    });
  });
});
