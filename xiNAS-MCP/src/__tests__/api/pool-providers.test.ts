import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  poolCreateProvider,
  poolDeleteProvider,
  poolModifyProvider,
} from '../../api/plan/providers/pool.js';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

type Row = { key: string; value: unknown; revision: number };
const ctxWith = (rows: Row[]) =>
  ({
    kv: {
      list: (opts?: { prefix?: string }) =>
        rows
          .filter((r) => opts?.prefix === undefined || r.key.startsWith(opts.prefix))
          .map((r) => ({ key: r.key, value: r.value, revision: r.revision })),
      get: (key: string) => {
        const hit = rows.find((r) => r.key === key);
        return hit === undefined
          ? null
          : { key: hit.key, value: hit.value, revision: hit.revision };
      },
    },
  }) as never;

const POOL = (name: string, active: boolean, revision = 3): Row => ({
  key: `/xinas/v1/observed/Pool/${name}`,
  value: { kind: 'Pool', id: name, status: { name, drives: ['/dev/x'], active } },
  revision,
});

const DISK = (path: string, over: Record<string, unknown> = {}): Row => ({
  key: `/xinas/v1/observed/Disk/${path.replaceAll('/', '_')}`,
  value: { kind: 'Disk', status: { device_path: path, safe_for_use: true, ...over } },
  revision: 1,
});

describe('pool providers (S9 T8) — the S4 imperative freshness pattern', () => {
  // Pool names are engine identifiers handed to the same `xicli` binary as
  // array names. The 4.4 reference documents no rule for `xicli pool create -n`,
  // so xiNAS applies the documented array character set: Latin letters, digits
  // and underscore. Hyphens are not accepted anywhere xiRAID naming is
  // documented. See docs/Storage/raid-management-spec.md §7.3.
  it('create: rejects hyphenated names', async () => {
    await expect(
      poolCreateProvider.preflight(ctxWith([DISK('/dev/a')]), {
        name: 'spare-1',
        drives: ['/dev/a'],
      }),
    ).rejects.toThrow(/spec\.name/);
  });

  it('create: accepts a long underscored name up to the 64-char bound', async () => {
    // The 64-char bound is a deliberate choice borrowed from the array-name
    // rule, not a vendor-documented pool limit (see the NAME_RE comment in
    // src/api/plan/providers/pool.ts). Underscores must survive it, since the
    // documented character set is the only thing narrowing the name.
    const long = `sp_${'a'.repeat(60)}`;
    const out = await poolCreateProvider.preflight(ctxWith([DISK('/dev/a')]), {
      name: long,
      drives: ['/dev/a'],
    });
    expect(out.blockers).toEqual([]);
  });

  it('create: absence pin (revision 0), lease, blockers for dup/system/unsafe', async () => {
    const clean = await poolCreateProvider.preflight(ctxWith([DISK('/dev/a')]), {
      name: 'spare1',
      drives: ['/dev/a'],
    });
    expect(clean.blockers).toEqual([]);
    expect(clean.affected_resources).toEqual([{ kind: 'Pool', id: 'spare1' }]); // no revision
    expect(clean.observed_freshness_ref).toEqual({ kind: 'Pool', id: 'spare1', revision: 0 });
    expect(clean.lease_resources).toEqual([{ kind: 'Pool', id: 'spare1' }]);

    const dup = await poolCreateProvider.preflight(ctxWith([POOL('spare1', false)]), {
      name: 'spare1',
      drives: ['/dev/a'],
    });
    expect(dup.blockers.map((b) => b.code)).toContain('pool_already_exists');
    expect(dup.observed_freshness_ref?.revision).toBe(3);

    const unsafe = await poolCreateProvider.preflight(
      ctxWith([DISK('/dev/sys', { system_disk: true }), DISK('/dev/b', { safe_for_use: false })]),
      { name: 'p', drives: ['/dev/sys', '/dev/b'] },
    );
    expect(unsafe.blockers.map((b) => b.code).sort()).toEqual(['disk_not_safe', 'system_disk']);
  });

  // AL1 — the same hole the array create path had: /dev/xi_log is an ARRAY
  // VOLUME (XFS external journal), reads safe_for_use:true because an
  // external-log device carries no mountpoint, and would be handed to
  // `xicli pool create` as a spare. Spec: s3-xiraid-array-spec.md §4.1,
  // s9-bridge-pools-spec.md §T8.
  it('create: a /dev/xi_* array volume is never a pool drive', async () => {
    const known = await poolCreateProvider.preflight(
      ctxWith([DISK('/dev/xi_log'), DISK('/dev/a')]),
      { name: 'p', drives: ['/dev/xi_log', '/dev/a'] },
    );
    expect(known.blockers.map((b) => b.code)).toEqual(['disk_is_raid_volume']);

    // The important half: driveBlockers SKIPS a path observation does not
    // know ("xiRAID validates at execute"), so a host whose disks have not
    // been collected yet would have let this straight through.
    const unknown = await poolCreateProvider.preflight(ctxWith([]), {
      name: 'p',
      drives: ['/dev/xi_log'],
    });
    expect(unknown.blockers.map((b) => b.code)).toEqual(['disk_is_raid_volume']);
  });

  it('modify: add_drives refuses an array volume, remove_drives still accepts one', async () => {
    const add = await poolModifyProvider.preflight(ctxWith([POOL('p', false)]), {
      name: 'p',
      add_drives: ['/dev/xi_log'],
    });
    expect(add.blockers.map((b) => b.code)).toContain('disk_is_raid_volume');

    // The escape hatch: a pool that already holds one must be repairable.
    const rm = await poolModifyProvider.preflight(ctxWith([POOL('p', false)]), {
      name: 'p',
      remove_drives: ['/dev/xi_log'],
    });
    expect(rm.blockers).toEqual([]);
  });

  it('modify: exactly one intent; absent pool blocks', async () => {
    await expect(
      poolModifyProvider.preflight(ctxWith([]), {
        name: 'p',
        add_drives: ['/dev/a'],
        active: true,
      }),
    ).rejects.toThrow(/exactly ONE/);

    const absent = await poolModifyProvider.preflight(ctxWith([]), { name: 'p', active: true });
    expect(absent.blockers.map((b) => b.code)).toContain('pool_not_found');

    const act = await poolModifyProvider.preflight(ctxWith([POOL('p', false)]), {
      name: 'p',
      active: true,
    });
    expect(act.blockers).toEqual([]);
    expect(act.enriched_spec).toEqual({ intent: 'activate', name: 'p' });

    const rm = await poolModifyProvider.preflight(ctxWith([POOL('p', false)]), {
      name: 'p',
      remove_drives: ['/dev/x'],
    });
    expect(rm.enriched_spec).toMatchObject({ intent: 'remove_drives', drives: ['/dev/x'] });
  });

  it('delete: blocks on active AND on referenced_by', async () => {
    const active = await poolDeleteProvider.preflight(ctxWith([POOL('p', true)]), { name: 'p' });
    expect(active.blockers.map((b) => b.code)).toContain('pool_active');

    const referenced = await poolDeleteProvider.preflight(
      ctxWith([
        POOL('p', false),
        {
          key: '/xinas/v1/observed/XiraidArray/data1',
          value: { kind: 'XiraidArray', id: 'data1', status: { spare_pool: 'p' } },
          revision: 2,
        },
      ]),
      { name: 'p' },
    );
    expect(referenced.blockers.map((b) => b.code)).toContain('pool_referenced');
    expect(JSON.stringify(referenced.blockers)).toContain('data1');

    const clean = await poolDeleteProvider.preflight(ctxWith([POOL('p', false)]), { name: 'p' });
    expect(clean.blockers).toEqual([]);
  });
});

describe('pool routes (S9 T8)', () => {
  let setup: MockAgentSetup;
  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/Pool/spare1', {
      kind: 'Pool',
      id: 'spare1',
      status: { name: 'spare1', drives: ['/dev/x'], active: false },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  it('POST plan + PATCH plan + DELETE plan reach the providers', async () => {
    const create = await request(setup.app)
      .post('/api/v1/pools')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: { name: 'spare2', drives: ['/dev/a'] } });
    expect(create.status, JSON.stringify(create.body)).toBe(200);
    expect(create.body.result.plan_id).toBeTruthy();

    const patch = await request(setup.app)
      .patch('/api/v1/pools/spare1')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: { active: true } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const del = await request(setup.app)
      .delete('/api/v1/pools/spare1')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: {} });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.result.blockers).toEqual([]);
  });
});
