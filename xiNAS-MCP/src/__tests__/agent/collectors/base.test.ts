import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorRegistry } from '../../../agent/collectors/base.js';
import type { Collector, Kind, ObservationDelta } from '../../../agent/collectors/base.js';

function makeMockCollector(kind: Kind): Collector {
  let _emitFn: ((delta: ObservationDelta) => void) | null = null;
  let _state: 'running' | 'stubbed' | 'error' = 'running';

  return {
    kind,
    async initialSweep(): Promise<ObservationDelta[]> {
      return [
        {
          kind,
          id: 'test-id',
          op: 'upsert',
          value: { status: { observed_at: new Date().toISOString() } },
        },
      ];
    },
    async start(emit) {
      _emitFn = emit;
    },
    async stop() {
      _emitFn = null;
    },
    health() {
      return { state: _state };
    },
    _triggerEmit(delta: ObservationDelta) {
      _emitFn?.(delta);
    },
  } as Collector & { _triggerEmit(d: ObservationDelta): void };
}

describe('CollectorRegistry', () => {
  let registry: CollectorRegistry;

  beforeEach(() => {
    registry = new CollectorRegistry();
  });

  it('register + healthSnapshot: returns state for registered collector', () => {
    const col = makeMockCollector('Disk');
    registry.register(col);
    const snap = registry.healthSnapshot();
    expect(snap['Disk']).toBe('running');
  });

  it('start: calls start on all registered collectors with the shared emit', async () => {
    const received: ObservationDelta[] = [];
    const col = makeMockCollector('NetworkInterface') as Collector & {
      _triggerEmit(d: ObservationDelta): void;
    };
    registry.register(col);
    await registry.start((delta) => received.push(delta));
    col._triggerEmit({
      kind: 'NetworkInterface',
      id: 'eth0',
      op: 'upsert',
      value: { status: { observed_at: new Date().toISOString() } },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('eth0');
  });

  it('stop: calls stop on all collectors', async () => {
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const col: Collector = {
      kind: 'Disk',
      initialSweep: async () => [],
      start: async () => {},
      stop: stopSpy,
      health: () => ({ state: 'running' }),
    };
    registry.register(col);
    await registry.stop();
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it('healthSnapshot: reflects error state of individual collectors', () => {
    const col: Collector = {
      kind: 'Filesystem',
      initialSweep: async () => [],
      start: async () => {},
      stop: async () => {},
      health: () => ({ state: 'error', reason: 'probe failed' }),
    };
    registry.register(col);
    const snap = registry.healthSnapshot();
    expect(snap['Filesystem']).toBe('error: probe failed');
  });

  it('initialSweep: returns all deltas from all collectors', async () => {
    registry.register(makeMockCollector('User'));
    registry.register(makeMockCollector('Group'));
    const deltas = await registry.initialSweep();
    expect(deltas).toHaveLength(2);
    const kinds = deltas.map((d) => d.kind);
    expect(kinds).toContain('User');
    expect(kinds).toContain('Group');
  });
});
