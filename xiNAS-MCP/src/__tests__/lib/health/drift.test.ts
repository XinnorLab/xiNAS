import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareExports,
  driftNetplanCheck,
  driftNfsConfCheck,
  driftNfsExportsCheck,
} from '../../../lib/health/drift.js';
import { renderNetplan } from '../../../lib/net/render.js';

const DESIRED = [
  {
    path: '/mnt/a',
    clients: [{ host: '*', options: ['rw', 'no_root_squash', 'no_subtree_check'] }],
  },
];

describe('compareExports (semantic)', () => {
  it('identical sets → clean; kernel-noise options ignored; order-insensitive', () => {
    const drift = compareExports(DESIRED, [
      {
        export_path: '/mnt/a',
        rules: [
          // reordered + exportfs noise — still clean
          {
            host_pattern: '*',
            options: ['no_subtree_check', 'wdelay', 'rw', 'no_root_squash', 'hide'],
          },
        ],
      },
    ]);
    expect(drift).toEqual({ missing: [], extra: [], changed: [] });
  });

  it('detects missing, extra, and changed (options + hosts)', () => {
    const drift = compareExports(
      [...DESIRED, { path: '/mnt/b', clients: [{ host: '10.0.0.0/24', options: ['ro'] }] }],
      [
        {
          export_path: '/mnt/a',
          rules: [{ host_pattern: '*', options: ['ro', 'no_root_squash', 'no_subtree_check'] }],
        },
        { export_path: '/mnt/rogue', rules: [{ host_pattern: '*', options: ['rw'] }] },
      ],
    );
    expect(drift.missing).toEqual(['/mnt/b']);
    expect(drift.extra).toEqual(['/mnt/rogue']);
    expect(drift.changed).toHaveLength(1);
    expect(drift.changed[0]?.path).toBe('/mnt/a');
    expect(drift.changed[0]?.detail).toContain('options differ');
  });

  it('host present observed-only is a change', () => {
    const drift = compareExports(DESIRED, [
      {
        export_path: '/mnt/a',
        rules: [
          { host_pattern: '*', options: ['rw', 'no_root_squash', 'no_subtree_check'] },
          { host_pattern: '10.9.9.9', options: ['rw'] },
        ],
      },
    ]);
    expect(drift.changed[0]?.detail).toContain('10.9.9.9 exported but not desired');
  });
});

describe('drift checks', () => {
  it('nfs-exports: no shares → skipped; drift → degraded with the three lists', () => {
    expect(driftNfsExportsCheck([], []).status).toBe('skipped');
    const degraded = driftNfsExportsCheck(DESIRED, []);
    expect(degraded.status).toBe('degraded');
    expect((degraded.evidence as { missing: string[] }).missing).toEqual(['/mnt/a']);
    expect(
      driftNfsExportsCheck(DESIRED, [
        {
          export_path: '/mnt/a',
          rules: [{ host_pattern: '*', options: ['rw', 'no_root_squash', 'no_subtree_check'] }],
        },
      ]).status,
    ).toBe('ok');
  });

  it('netplan: hash equality via the real renderer; skipped without desired/observed', () => {
    const rows = [{ name: 'ibp0', addresses: ['10.10.1.1/24'], enabled: true, pbr_table_id: 100 }];
    const hash = createHash('sha256').update(renderNetplan(rows), 'utf8').digest('hex');
    expect(driftNetplanCheck([], hash).status).toBe('skipped');
    expect(driftNetplanCheck(rows, undefined).status).toBe('skipped');
    expect(driftNetplanCheck(rows, hash).status).toBe('ok');
    const drifted = driftNetplanCheck(rows, 'f'.repeat(64));
    expect(drifted.status).toBe('degraded');
    expect((drifted.evidence as { expected_hash: string }).expected_hash).toBe(hash);
  });

  it('nfs-conf: skipped(no profile) / skipped(quick) / degraded(helper down) / per-path diff', () => {
    expect(driftNfsConfCheck(null, undefined, {}).status).toBe('skipped');
    const quick = driftNfsConfCheck({ versions: {} }, undefined, {});
    expect(quick.status).toBe('skipped');
    expect(quick.recommended_action).toContain('standard');
    expect(driftNfsConfCheck({ versions: {} }, null, {}).status).toBe('degraded');

    const render = { '/etc/nfs/nfsd.conf': 'sha256:aaa', '/etc/default/nfs-common': 'sha256:bbb' };
    expect(driftNfsConfCheck({ versions: {} }, render, { ...render }).status).toBe('ok');
    const drifted = driftNfsConfCheck({ versions: {} }, render, {
      '/etc/nfs/nfsd.conf': 'sha256:zzz',
    });
    expect(drifted.status).toBe('degraded');
    expect((drifted.evidence as { diffs: unknown[] }).diffs).toHaveLength(2);
  });
});
