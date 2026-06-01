import { describe, expect, it } from 'vitest';
import {
  ManagedFilesStubCollector,
  XiraidArrayStubCollector,
} from '../../../agent/collectors/stubs.js';

describe('XiraidArrayStubCollector', () => {
  it('initialSweep: returns a single meta-delta at id "_stub"', async () => {
    const col = new XiraidArrayStubCollector();
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: 'XiraidArray',
      id: '_stub',
      op: 'upsert',
    });
  });

  it('initialSweep: meta-delta carries status.deferred=true and reason=XIRAID_ADAPTER_DEFERRED', async () => {
    const col = new XiraidArrayStubCollector();
    const [delta] = await col.initialSweep();
    const status = delta?.value?.status as Record<string, unknown>;
    expect(status?.deferred).toBe(true);
    expect(status?.reason).toBe('XIRAID_ADAPTER_DEFERRED');
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: emits nothing (no events, no poll)', async () => {
    const col = new XiraidArrayStubCollector();
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports stubbed', () => {
    const col = new XiraidArrayStubCollector();
    const h = col.health();
    expect(h.state).toBe('stubbed');
    expect(h.reason).toBe('XIRAID_ADAPTER_DEFERRED');
  });

  it('pollIntervalMs: undefined (no poll)', () => {
    const col = new XiraidArrayStubCollector();
    expect(col.pollIntervalMs).toBeUndefined();
  });
});

describe('ManagedFilesStubCollector', () => {
  it('initialSweep: returns a single meta-delta at id "_stub"', async () => {
    const col = new ManagedFilesStubCollector();
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: 'managed_files',
      id: '_stub',
      op: 'upsert',
    });
  });

  it('initialSweep: meta-delta carries status.deferred=true and reason=DRIFT_FRAMEWORK_DEFERRED', async () => {
    const col = new ManagedFilesStubCollector();
    const [delta] = await col.initialSweep();
    const status = delta?.value?.status as Record<string, unknown>;
    expect(status?.deferred).toBe(true);
    expect(status?.reason).toBe('DRIFT_FRAMEWORK_DEFERRED');
  });

  it('start: emits nothing', async () => {
    const col = new ManagedFilesStubCollector();
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports stubbed with DRIFT_FRAMEWORK_DEFERRED', () => {
    const col = new ManagedFilesStubCollector();
    const h = col.health();
    expect(h.state).toBe('stubbed');
    expect(h.reason).toBe('DRIFT_FRAMEWORK_DEFERRED');
  });

  it('pollIntervalMs: undefined (no poll)', () => {
    const col = new ManagedFilesStubCollector();
    expect(col.pollIntervalMs).toBeUndefined();
  });
});
