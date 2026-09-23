import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillPlacementIncarnation } from '../../api/backfill-placement-incarnation.js';
import { readPlacementIncarnation, sharePlacementKey } from '../../lib/nfs-placement.js';
import { type OpenedStateStore, openStateStore } from '../../state/index.js';

describe('backfillPlacementIncarnation (S20 F-08)', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-backfill-'));
    state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: '00000000-0000-0000-0000-0000000000aa',
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a marker for shares without one, keeps existing markers, never touches the Share row, and is idempotent', () => {
    state.kv.put('/xinas/v1/desired/Share/a', {
      kind: 'Share',
      id: 'a',
      spec: { path: '/srv/a', clients: [], fsid: 1 },
    });
    state.kv.put('/xinas/v1/desired/Share/b', {
      kind: 'Share',
      id: 'b',
      spec: { path: '/srv/b', clients: [], fsid: 2 },
    });
    state.kv.put(sharePlacementKey('b'), { share_id: 'b', placement_incarnation: 'keep-me' });
    expect(backfillPlacementIncarnation(state)).toBe(1);
    expect(readPlacementIncarnation(state.kv, 'a')).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPlacementIncarnation(state.kv, 'b')).toBe('keep-me');
    // The Share rows themselves keep revision 1: plans pinned to them survive a boot.
    expect(state.kv.get('/xinas/v1/desired/Share/a')?.revision).toBe(1);
    expect(state.kv.get('/xinas/v1/desired/Share/b')?.revision).toBe(1);
    // Second boot: nothing to write.
    expect(backfillPlacementIncarnation(state)).toBe(0);
    expect(state.kv.get(sharePlacementKey('a'))?.revision).toBe(1);
  });
});
