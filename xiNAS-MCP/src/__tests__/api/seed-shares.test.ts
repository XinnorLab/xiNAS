import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../api/config.js';
import { seedShares } from '../../api/seed-shares.js';
import { buildTestApp } from './_helpers.js';

const MARKER_KEY = '/xinas/v1/meta/shares_seeded';
const SHARE_PREFIX = '/xinas/v1/desired/Share/';

interface ShareRow {
  kind: string;
  id: string;
  spec: { path: string; clients: Array<{ pattern: string; options: string[] }>; fsid: number };
}

describe('seedShares — install-time desired-state adoption', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  let dir: string;
  let manifestPath: string;

  const cfg = (): ApiConfig => ({
    ...setup.config,
    seed: { shares_manifest_path: manifestPath },
  });

  const writeManifest = (entries: unknown): void =>
    writeFileSync(manifestPath, JSON.stringify(entries), 'utf8');

  beforeEach(async () => {
    setup = await buildTestApp();
    dir = mkdtempSync(join(tmpdir(), 'xinas-seed-'));
    manifestPath = join(dir, 'shares.json');
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await setup.cleanup();
  });

  it('seeds one desired Share per manifest entry and sets the marker', () => {
    writeManifest([
      {
        path: '/mnt/data',
        clients: '*',
        options: [
          'rw',
          'sync',
          'insecure',
          'no_root_squash',
          'no_subtree_check',
          'no_wdelay',
          'fsid=0',
        ],
      },
    ]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows).toHaveLength(1);
    const share = rows[0]!.value;
    expect(share.kind).toBe('Share');
    expect(share.id).toBe('mnt/data'); // encExportId('/mnt/data')
    expect(share.spec.path).toBe('/mnt/data');
    expect(share.spec.fsid).toBe(0); // fsid=0 extracted from options, preserved
    expect(share.spec.clients).toEqual([
      {
        pattern: '*',
        options: ['rw', 'sync', 'insecure', 'no_root_squash', 'no_subtree_check', 'no_wdelay'],
      },
    ]);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('is a no-op when the marker is already set (never re-seeds)', () => {
    setup.state.kv.put(MARKER_KEY, { seeded_at: 'x', source: 'api:bootstrap' });
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);

    seedShares(setup.state, cfg());

    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
  });

  it('does NOT resurrect a deleted share on the next boot', () => {
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);
    seedShares(setup.state, cfg()); // first boot seeds + marks

    const id = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX })[0]!.value.id;
    setup.state.kv.delete(`${SHARE_PREFIX}${id}`); // operator removes it via TUI

    seedShares(setup.state, cfg()); // simulated restart

    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
  });

  it('leaves the marker unset when the manifest is absent (seeds on a later boot)', () => {
    // no writeManifest() → file does not exist
    seedShares(setup.state, cfg());
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();

    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(1);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('leaves the marker unset for an empty manifest', () => {
    writeManifest([]);
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();
  });

  it('does not duplicate a path that already has a desired Share', () => {
    setup.state.kv.put(`${SHARE_PREFIX}mnt/data`, {
      kind: 'Share',
      id: 'mnt/data',
      spec: { path: '/mnt/data', clients: [{ pattern: '10.0.0.0/24', options: ['ro'] }], fsid: 7 },
    });
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value.spec.fsid).toBe(7); // untouched operator/existing row
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('assigns fsid max+1 when a manifest entry omits fsid', () => {
    writeManifest([
      { path: '/mnt/a', clients: '*', options: ['rw', 'fsid=0'] },
      { path: '/mnt/b', clients: '*', options: ['rw'] }, // no fsid → assigned
    ]);

    seedShares(setup.state, cfg());

    const byPath = new Map(
      setup.state.kv
        .list<ShareRow>({ prefix: SHARE_PREFIX })
        .map((r) => [r.value.spec.path, r.value.spec.fsid]),
    );
    expect(byPath.get('/mnt/a')).toBe(0);
    expect(byPath.get('/mnt/b')).toBe(1); // max(0)+1
  });

  it('skips an unencodable path but still seeds the rest and marks', () => {
    writeManifest([
      { path: '/', clients: '*', options: ['rw'] }, // encExportId throws → skipped
      { path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] },
    ]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows.map((r) => r.value.spec.path)).toEqual(['/mnt/data']);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('does not seed or mark on a malformed manifest (retries next boot)', () => {
    writeFileSync(manifestPath, '{ not json', 'utf8');
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();
  });
});
