import { describe, expect, it, vi } from 'vitest';
import { InventoryCollector } from '../../../agent/collectors/inventory.js';

function makeFakeInventoryProbe(
  options: {
    result?: {
      hostname: string;
      os_kernel: string;
      cpu_model?: string;
      cpu_cores?: number;
      cpu_threads?: number;
      mem_total_kb?: number;
      arch?: string;
    };
  } = {},
) {
  return {
    read: vi.fn().mockResolvedValue(
      options.result ?? {
        hostname: 'xinas-node-01',
        os_kernel: '5.15.0-generic',
        cpu_model: 'Intel Xeon Gold 6338',
        cpu_cores: 32,
        cpu_threads: 64,
        mem_total_kb: 131072000,
        arch: 'x86_64',
      },
    ),
  };
}

describe('InventoryCollector', () => {
  it('initialSweep: returns singleton upsert at id "snapshot"', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'inventory', id: 'snapshot', op: 'upsert' });
  });

  it('initialSweep: value includes all inventory fields + observed_at', async () => {
    const probe = makeFakeInventoryProbe({
      result: {
        hostname: 'xinas-node-01',
        os_kernel: '5.15.0',
        cpu_model: 'Intel Xeon Gold 6338',
        cpu_cores: 32,
        cpu_threads: 64,
        mem_total_kb: 131_072_000,
        arch: 'x86_64',
      },
    });
    const col = new InventoryCollector({ probe });
    const deltas = await col.initialSweep();
    const status = deltas[0]?.value?.status as Record<string, unknown>;
    expect(status?.hostname).toBe('xinas-node-01');
    expect(status?.cpu_cores).toBe(32);
    expect(status?.mem_total_kb).toBe(131_072_000);
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: no event subscription (inventory is poll-only)', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    // No events should be fired from start() itself
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 300000', () => {
    const probe = makeFakeInventoryProbe();
    expect(new InventoryCollector({ probe }).pollIntervalMs).toBe(300_000);
  });

  it('health: error if probe throws', async () => {
    const probe = makeFakeInventoryProbe();
    probe.read.mockRejectedValueOnce(new Error('readFile failed'));
    const col = new InventoryCollector({ probe });
    await col.initialSweep().catch(() => {});
    expect(col.health().state).toBe('error');
  });
});
