import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateStore } from '../../../state/index.js';
import {
  ADOPT_KINDS,
  captureSnapshotDesired,
  readSnapshotDesired,
  snapshotDesiredKey,
} from '../../../api/tasks/snapshot-desired.js';
import type { OpenedStateStore } from '../../../state/index.js';

let tmpDir: string;
let store: OpenedStateStore;

async function memKv(): Promise<OpenedStateStore> {
  tmpDir = mkdtempSync(join(tmpdir(), 'xinas-snap-desired-'));
  return openStateStore({
    databasePath: join(tmpDir, 'xinas.db'),
    auditJsonlPath: join(tmpDir, 'audit.jsonl'),
    nodeId: 'n1',
  });
}

describe('snapshot-desired capture/read', () => {
  beforeEach(async () => {
    store = await memKv();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures only the in-scope desired kinds, keyed by snapshot id', () => {
    store.kv.put('/xinas/v1/desired/Share/exp1', {
      kind: 'Share',
      id: 'exp1',
      spec: { path: '/e1' },
    });
    store.kv.put('/xinas/v1/desired/NetworkInterface/mlx0', {
      kind: 'NetworkInterface',
      id: 'mlx0',
      spec: { addresses: ['10.0.0.1/24'] },
    });
    store.kv.put('/xinas/v1/desired/Pool/p1', { kind: 'Pool', id: 'p1', spec: {} }); // out of scope

    captureSnapshotDesired(store.kv, 'snap-1');

    const payload = readSnapshotDesired(store.kv, 'snap-1');
    expect(payload).not.toBeNull();
    expect(Object.keys(payload!.kinds).sort()).toEqual([...ADOPT_KINDS].sort());
    expect(payload!.kinds.Share).toEqual([{ id: 'exp1', spec: { path: '/e1' } }]);
    expect(payload!.kinds.NetworkInterface).toEqual([
      { id: 'mlx0', spec: { addresses: ['10.0.0.1/24'] } },
    ]);
    expect(payload!.snapshot_id).toBe('snap-1');
  });

  it('readSnapshotDesired returns null when no payload exists', () => {
    expect(readSnapshotDesired(store.kv, 'ghost')).toBeNull();
    expect(snapshotDesiredKey('x')).toBe('/xinas/v1/snapshot-desired/x');
  });
});
