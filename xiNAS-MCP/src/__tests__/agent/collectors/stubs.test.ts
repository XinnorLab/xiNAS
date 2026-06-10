import { describe, expect, it } from 'vitest';
import { ManagedFilesStubCollector } from '../../../agent/collectors/stubs.js';

// XiraidArrayStubCollector was removed in S3 T6 — the real
// XiraidArrayCollector (collectors/xiraid.ts) replaced it; see xiraid.test.ts.

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
