import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLECTOR_POLL_MS,
  applyCollectorMap,
  emitAgentState,
  systemProducer,
} from '../../../api/events/producers/system.js';
import { type Harness, OBSERVED_AT, type Row, makeHarness, types } from './_engine-harness.js';

const unitRow = (id: string, active: string, load = 'loaded'): Row => ({
  kind: 'SystemdUnit',
  id,
  status: { load_state: load, active_state: active, sub_state: 'x', observed_at: OBSERVED_AT },
});

const ifaceRow = (
  id: string,
  o: { link?: string; rdma?: string; capable?: boolean } = {},
): Row => ({
  kind: 'NetworkInterface',
  id,
  status: {
    name: id,
    ...(o.link !== undefined ? { link_state: o.link } : {}),
    ...(o.rdma !== undefined ? { rdma_link_state: o.rdma } : {}),
    rdma_capable: o.capable ?? false,
    observed_at: OBSERVED_AT,
  },
});

const inventoryRow = (bootId?: string): Row => ({
  kind: 'inventory',
  id: 'snapshot',
  status: {
    hostname: 'node',
    os_kernel: '6.8',
    ...(bootId !== undefined ? { boot_id: bootId } : {}),
    observed_at: OBSERVED_AT,
  },
});

describe('system producer (S17 §8.6)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [systemProducer] });
  });
  afterEach(() => h.close());

  describe('services', () => {
    it('xiraid-server active → failed → active', () => {
      let ev = h.step(
        'SystemdUnit',
        'xiraid-server.service',
        unitRow('xiraid-server.service', 'active'),
        unitRow('xiraid-server.service', 'failed'),
      );
      expect(types(ev)).toEqual(['system.service.unavailable']);
      expect(ev[0]).toMatchObject({ feed: 'system', severity: 'error', reasonCode: 'unit_failed' });
      ev = h.step(
        'SystemdUnit',
        'xiraid-server.service',
        unitRow('xiraid-server.service', 'failed'),
        unitRow('xiraid-server.service', 'active'),
      );
      expect(types(ev)).toEqual(['system.service.recovered']);
    });

    it('xinas-api reports only its own recovery (V-72)', () => {
      expect(
        types(
          h.step(
            'SystemdUnit',
            'xinas-api.service',
            unitRow('xinas-api.service', 'active'),
            unitRow('xinas-api.service', 'failed'),
          ),
        ),
      ).toEqual([]);
      expect(
        types(
          h.step(
            'SystemdUnit',
            'xinas-api.service',
            unitRow('xinas-api.service', 'failed'),
            unitRow('xinas-api.service', 'active'),
          ),
        ),
      ).toEqual(['system.service.recovered']);
    });

    it('leaves NFS units to the NFS producer and ignores unknown units', () => {
      expect(
        types(
          h.step(
            'SystemdUnit',
            'nfs-server.service',
            unitRow('nfs-server.service', 'active'),
            unitRow('nfs-server.service', 'failed'),
          ),
        ),
      ).toEqual([]);
      expect(
        types(
          h.step(
            'SystemdUnit',
            'cron.service',
            unitRow('cron.service', 'active'),
            unitRow('cron.service', 'failed'),
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('links', () => {
    const managed = (id: string) =>
      h.kv.putKey(`/xinas/v1/desired/NetworkInterface/${id}`, {
        kind: 'NetworkInterface',
        id,
        spec: { managed_by_xinas: true },
      });

    it('a managed interface reports link and RDMA link transitions', () => {
      managed('ib0');
      let ev = h.step(
        'NetworkInterface',
        'ib0',
        ifaceRow('ib0', { link: 'up', rdma: 'up', capable: true }),
        ifaceRow('ib0', { link: 'down', rdma: 'down', capable: true }),
      );
      expect(types(ev)).toEqual(['system.network.link_down', 'system.rdma.link_down']);
      expect(ev[0]).toMatchObject({
        subject: { kind: 'NetworkInterface', id: 'ib0' },
        severity: 'warning',
        details: { interface: 'ib0', linkState: 'down', managed: true },
      });
      ev = h.step(
        'NetworkInterface',
        'ib0',
        ifaceRow('ib0', { link: 'down', rdma: 'down', capable: true }),
        ifaceRow('ib0', { link: 'up', rdma: 'up', capable: true }),
      );
      expect(types(ev)).toEqual(['system.network.link_up', 'system.rdma.link_up']);
      expect(ev[0]?.previous).toMatchObject({ severity: 'warning' });
    });

    it('an unmanaged non-RDMA interface is not in the feed; an RDMA-capable one is', () => {
      expect(
        types(
          h.step(
            'NetworkInterface',
            'eth0',
            ifaceRow('eth0', { link: 'up' }),
            ifaceRow('eth0', { link: 'down' }),
          ),
        ),
      ).toEqual([]);
      expect(
        types(
          h.step(
            'NetworkInterface',
            'ib1',
            ifaceRow('ib1', { link: 'up', capable: true }),
            ifaceRow('ib1', { link: 'down', capable: true }),
          ),
        ),
      ).toEqual(['system.network.link_down']);
    });

    it('unknown on either side, or a partial record, produces nothing', () => {
      managed('ib0');
      expect(
        types(
          h.step(
            'NetworkInterface',
            'ib0',
            ifaceRow('ib0', { link: 'unknown' }),
            ifaceRow('ib0', { link: 'down' }),
          ),
        ),
      ).toEqual([]);
      expect(
        types(
          h.step('NetworkInterface', 'ib0', ifaceRow('ib0', { link: 'up' }), ifaceRow('ib0', {})),
        ),
      ).toEqual([]);
      expect(
        types(h.step('NetworkInterface', 'ib0', null, ifaceRow('ib0', { link: 'down' }))),
      ).toEqual([]);
    });
  });

  describe('reboot', () => {
    it('stores the first boot id silently, reports a change once, and arms the restore check', () => {
      h.kv.put('XiraidArray', 'a', { kind: 'XiraidArray', id: 'a', status: {} });
      expect(types(h.step('inventory', 'snapshot', null, inventoryRow('b1')))).toEqual([]);
      expect(h.journal.metaGet('boot_id')).toBe('b1');
      expect(
        types(h.step('inventory', 'snapshot', inventoryRow('b1'), inventoryRow('b1'))),
      ).toEqual([]);
      const ev = h.step('inventory', 'snapshot', inventoryRow('b1'), inventoryRow('b2'));
      expect(types(ev)).toEqual(['system.reboot.detected']);
      expect(ev[0]).toMatchObject({
        subject: { kind: 'Node', id: h.engine ? '00000000-0000-0000-0000-0000000000aa' : '' },
        timeAccuracy: 'observed',
        reasonCode: 'reboot',
        details: { previousBootId: 'b1', bootId: 'b2' },
      });
      expect(h.journal.metaGet('restore_pending')).toEqual({ bootId: 'b2', knownArrays: ['a'] });
      expect(h.journal.metaGet('boot_id')).toBe('b2');
    });

    it('an inventory row without a boot id changes nothing', () => {
      h.journal.metaSet('boot_id', 'b1');
      expect(types(h.step('inventory', 'snapshot', inventoryRow('b1'), inventoryRow()))).toEqual(
        [],
      );
      expect(h.journal.metaGet('boot_id')).toBe('b1');
    });
  });

  describe('agent state (heartbeat)', () => {
    it('maps the tracker transitions to system.agent events', () => {
      const at = '2026-09-04T11:59:55.000Z';
      emitAgentState(h.engine, {
        from: 'healthy',
        to: 'degraded',
        reason: 'heartbeat_timeout',
        lastHeartbeatAt: at,
      });
      emitAgentState(h.engine, {
        from: 'degraded',
        to: 'offline',
        reason: 'connect_refused',
        lastHeartbeatAt: at,
      });
      emitAgentState(h.engine, {
        from: 'offline',
        to: 'healthy',
        reason: 'heartbeat_timeout',
        lastHeartbeatAt: at,
      });
      const ev = h.journal.listAfter('system', 0, 10);
      expect(types(ev)).toEqual([
        'system.agent.degraded',
        'system.agent.offline',
        'system.agent.recovered',
      ]);
      expect(ev[0]).toMatchObject({
        severity: 'warning',
        source: { kind: 'heartbeat', component: 'heartbeat' },
        subject: { kind: 'Agent', id: 'xinas-agent' },
        details: { lastSuccessfulHeartbeatAt: at },
      });
      expect(ev[1]).toMatchObject({ severity: 'error', reasonCode: 'connect_refused' });
      expect(ev[2]?.previous).toMatchObject({ severity: 'error', state: 'offline' });
    });
  });

  describe('collector state (heartbeat map + accepted batches)', () => {
    const t0 = Date.parse(OBSERVED_AT);
    const accept = (kinds: Parameters<Harness['step']>[0][]) =>
      h.batch((e) => e.markAccepted(kinds));

    it('failed once per edge; recovered only after a newer accepted batch', () => {
      accept(['XiraidArray']);
      applyCollectorMap(h.engine, { XiraidArray: 'running' }, { agentHealthy: true, nowMs: t0 });
      applyCollectorMap(
        h.engine,
        { XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: connect ECONNREFUSED' },
        { agentHealthy: true, nowMs: t0 + 1000 },
      );
      applyCollectorMap(
        h.engine,
        { XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: connect ECONNREFUSED' },
        { agentHealthy: true, nowMs: t0 + 2000 },
      );
      let ev = h.journal.listAfter('system', 0, 10);
      expect(types(ev)).toEqual(['system.collector.failed']);
      expect(ev[0]).toMatchObject({
        subject: { kind: 'Collector', id: 'XiraidArray' },
        reasonCode: 'collector_error',
        details: {
          collector: 'XiraidArray',
          reason: 'XIRAID_DAEMON_UNAVAILABLE: connect ECONNREFUSED',
        },
      });
      applyCollectorMap(
        h.engine,
        { XiraidArray: 'running' },
        { agentHealthy: true, nowMs: t0 + 3000 },
      );
      expect(h.journal.count()).toBe(1);
      h.clock.now = t0 + 4000;
      accept(['XiraidArray']);
      expect(h.journal.count()).toBe(1);
      applyCollectorMap(
        h.engine,
        { XiraidArray: 'running' },
        { agentHealthy: true, nowMs: t0 + 5000 },
      );
      ev = h.journal.listAfter('system', 0, 10);
      expect(types(ev)).toEqual(['system.collector.failed', 'system.collector.recovered']);
    });

    it('bounds the failure reason to 256 characters', () => {
      applyCollectorMap(
        h.engine,
        { Disk: `error: ${'x'.repeat(1000)}` },
        { agentHealthy: true, nowMs: t0 },
      );
      const ev = h.journal.listAfter('system', 0, 10);
      expect((ev[0]?.details?.reason as string).length).toBeLessThanOrEqual(256);
    });

    it('stale after 3 poll intervals without an accepted batch while the agent is healthy; recovered on the next batch', () => {
      accept(['NfsSession']);
      applyCollectorMap(
        h.engine,
        { NfsSession: 'running' },
        { agentHealthy: true, nowMs: t0 + 2 * COLLECTOR_POLL_MS.NfsSession },
      );
      expect(h.journal.count()).toBe(0);
      applyCollectorMap(
        h.engine,
        { NfsSession: 'running' },
        { agentHealthy: false, nowMs: t0 + 4 * COLLECTOR_POLL_MS.NfsSession },
      );
      expect(h.journal.count()).toBe(0);
      applyCollectorMap(
        h.engine,
        { NfsSession: 'running' },
        { agentHealthy: true, nowMs: t0 + 4 * COLLECTOR_POLL_MS.NfsSession },
      );
      let ev = h.journal.listAfter('system', 0, 10);
      expect(types(ev)).toEqual(['system.collector.stale']);
      expect(ev[0]).toMatchObject({
        reasonCode: 'no_valid_update',
        details: { collector: 'NfsSession', pollIntervalMs: COLLECTOR_POLL_MS.NfsSession },
      });
      applyCollectorMap(
        h.engine,
        { NfsSession: 'running' },
        { agentHealthy: true, nowMs: t0 + 5 * COLLECTOR_POLL_MS.NfsSession },
      );
      expect(h.journal.count()).toBe(1);
      h.clock.now = t0 + 6 * COLLECTOR_POLL_MS.NfsSession;
      // The harness drains everything since its last drain, so the stale
      // row (written outside a batch) appears here together with the recovery.
      ev = accept(['NfsSession']);
      expect(types(ev)).toEqual(['system.collector.stale', 'system.collector.recovered']);
    });

    it('a kind that has never been accepted is not stale', () => {
      applyCollectorMap(
        h.engine,
        { Pool: 'running' },
        { agentHealthy: true, nowMs: t0 + 100 * COLLECTOR_POLL_MS.Pool },
      );
      expect(h.journal.count()).toBe(0);
    });
  });
});
