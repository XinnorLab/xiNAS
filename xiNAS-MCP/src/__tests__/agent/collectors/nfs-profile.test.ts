import { describe, expect, it, vi } from 'vitest';
import { NfsProfileCollector } from '../../../agent/collectors/nfs-profile.js';
import { isValidObservedId } from '../../../api/internal/observed.js';

const FILES = {
  '/etc/nfs/nfsd.conf': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '/etc/default/nfs-kernel-server':
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

function makeFakeNfsProfileProbe(
  options: { effective_files?: Record<string, string>; error?: Error } = {},
) {
  return {
    read: options.error
      ? vi.fn().mockRejectedValue(options.error)
      : vi.fn().mockResolvedValue({ effective_files: options.effective_files ?? FILES }),
  };
}

describe('NfsProfileCollector', () => {
  it('initialSweep: returns singleton upsert at id "default"', async () => {
    const probe = makeFakeNfsProfileProbe();
    const col = new NfsProfileCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'NfsProfile', id: 'default', op: 'upsert' });
    expect(deltas[0]?.value).toMatchObject({ kind: 'NfsProfile', id: 'default' });
    const status = deltas[0]?.value?.status as Record<string, unknown>;
    expect(status?.effective_files).toEqual(FILES);
    expect(typeof status?.observed_at).toBe('string');
  });

  it('id "default" passes the observed-id key guard', () => {
    expect(isValidObservedId('default')).toBe(true);
  });

  it('initialSweep: probe failure → health error + rethrow', async () => {
    const probe = makeFakeNfsProfileProbe({ error: new Error('boom') });
    const col = new NfsProfileCollector({ probe });
    await expect(col.initialSweep()).rejects.toThrow('boom');
    expect(col.health()).toEqual({ state: 'error', reason: 'boom' });
  });

  it('start/stop: poll-only — reports running, registers no event sources', async () => {
    const probe = makeFakeNfsProfileProbe();
    const col = new NfsProfileCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
    // No watchers in v1: the probe is only read by sweeps, never by start().
    expect(probe.read).not.toHaveBeenCalled();
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeNfsProfileProbe();
    expect(new NfsProfileCollector({ probe }).pollIntervalMs).toBe(60_000);
  });
});
