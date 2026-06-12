import { describe, expect, it } from 'vitest';
import { makeConfigDiffHandler } from '../../../agent/rpc/methods/config-diff.js';

describe('config.diff RPC (S9 T3)', () => {
  const handler = makeConfigDiffHandler({
    snapshotDiff: async (from, to) => ({ from_id: from, to_id: to, config_changes: [] }),
  });

  it('validates params and passes through the diff', async () => {
    await expect(handler({})).rejects.toThrow(/params.from/);
    await expect(handler({ from: 'a' })).rejects.toThrow(/params.to/);
    await expect(handler({ from: '', to: 'b' })).rejects.toThrow(/params.from/);
    expect(await handler({ from: 'a', to: 'b' })).toMatchObject({ from_id: 'a', to_id: 'b' });
  });

  it('bridge failures propagate as RPC errors', async () => {
    const failing = makeConfigDiffHandler({
      snapshotDiff: async () => {
        throw new Error('snapshot diff exited with code 1');
      },
    });
    await expect(failing({ from: 'a', to: 'b' })).rejects.toThrow(/exited with code 1/);
  });
});
