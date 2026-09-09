import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declaredAbsent, permittedFor } from '../../api/health/context.js';
import { digestOf } from '../../api/health/run-ledger.js';
import { AGENTIC_CATALOG } from '../../lib/health/agentic-catalog.js';
import { ADMIN_TOKEN, OPERATOR_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

const T1 = '2026-09-09T09:00:00.000Z';
const T2 = '2026-09-09T09:05:00.000Z';
const T3 = '2026-09-09T09:10:00.000Z';

/** S19b T5 — spec §6: `health.context` reads KV only, mints a run, never calls the agent. */
describe('GET /api/v1/health/context (S19b)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    const kv = setup.state.kv;
    kv.put('/xinas/v1/observed/XiraidArray/arr-1', {
      kind: 'XiraidArray',
      id: 'arr-1',
      spec: { member_disk_ids: ['d1', 'd2'] },
      status: { state: 'online', volume_path: '/dev/xi_data', observed_at: T1 },
    });
    kv.put('/xinas/v1/observed/Filesystem/fs-data', {
      kind: 'Filesystem',
      id: 'fs-data',
      status: {
        mountpoint: '/mnt/data',
        backing_device: '/dev/xi_data',
        mounted: true,
        observed_at: T2,
      },
    });
    kv.put('/xinas/v1/observed/Filesystem/fs-other', {
      kind: 'Filesystem',
      id: 'fs-other',
      status: {
        mountpoint: '/mnt/other',
        backing_device: '/dev/other',
        mounted: false,
        observed_at: T1,
      },
    });
    kv.put('/xinas/v1/desired/Share/sh-1', {
      kind: 'Share',
      id: 'sh-1',
      spec: { path: '/mnt/data/exports', clients: [] },
    });
    kv.put('/xinas/v1/desired/Share/sh-2', {
      kind: 'Share',
      id: 'sh-2',
      spec: { path: '/srv/x', clients: [] },
    });
    kv.put('/xinas/v1/observed/NetworkInterface/ib0', {
      kind: 'NetworkInterface',
      id: 'ib0',
      status: { name: 'ib0', operstate: 'up', mtu: 4092, observed_at: T3 },
    });
    kv.put('/xinas/v1/observed/inventory/snapshot', {
      kind: 'inventory',
      id: 'snapshot',
      status: { hostname: 'node-a', os_kernel: '6.8.0-45-generic', observed_at: T3 },
    });
    kv.put('/xinas/v1/observed/SystemdUnit/nfs-server.service', {
      kind: 'SystemdUnit',
      id: 'nfs-server.service',
      status: {
        load_state: 'loaded',
        active_state: 'active',
        sub_state: 'running',
        observed_at: T3,
      },
    });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const get = (token: string, query = '') =>
    request(setup.app).get(`/api/v1/health/context${query}`).set('Authorization', token);

  it('a viewer gets a minted run, the node, the linked topology, freshness, baselines and tools', async () => {
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(200);
    const r = res.body.result;

    expect(r.run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.run.expires_at).getTime() - new Date(r.run.issued_at).getTime()).toBe(
      900_000,
    );
    expect(r.run).toMatchObject({ principal: 'viewer:test', role: 'viewer' });
    expect(r.run.versions).toMatchObject({
      prompt: '1.0.0',
      policy: '1',
      catalog: '1',
      report_schema: '1',
      server: '1.0.0',
    });
    expect(r.run.versions.template_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(r.run.limits).sort()).toEqual([
      'active_probes_per_node',
      'analysis_seconds',
      'probes_per_run',
      'retries',
      'roles',
      'tool_calls',
    ]);
    expect(r.run.permitted).toEqual({
      deterministic: ['quick', 'standard'],
      baseline: false,
      probe_run: 'denied',
      apply: false,
    });

    expect(r.node).toEqual({
      hostname: expect.any(String),
      controller_id: setup.config.controller_id,
      xinas_version: '1.0.0',
      kernel: '6.8.0-45-generic',
      xiraid_version: null,
    });

    expect(r.topology.arrays).toEqual([
      {
        id: 'arr-1',
        state: 'online',
        revision: 1,
        observed_at: T1,
        member_disk_ids: ['d1', 'd2'],
      },
    ]);
    expect(r.topology.filesystems).toEqual([
      {
        id: 'fs-data',
        array_id: 'arr-1',
        mountpoint: '/mnt/data',
        mounted: true,
        revision: 1,
        observed_at: T2,
      },
      {
        id: 'fs-other',
        array_id: null,
        mountpoint: '/mnt/other',
        mounted: false,
        revision: 1,
        observed_at: T1,
      },
    ]);
    expect(r.topology.shares).toEqual([
      { id: 'sh-1', path: '/mnt/data/exports', filesystem_id: 'fs-data' },
      { id: 'sh-2', path: '/srv/x', filesystem_id: null },
    ]);
    expect(r.topology.interfaces).toEqual([
      { id: 'ib0', operstate: 'up', mtu: 4092, revision: 1, observed_at: T3 },
    ]);
    // nfs-server.service is loaded and shares exist; the RAID collector state is
    // unknown (no heartbeat) — nothing is proven absent.
    expect(r.topology.declared_absent).toEqual([]);

    expect(r.collectors).toEqual({ heartbeat: 'offline', last_probe: null });
    expect(r.freshness.XiraidArray).toEqual({
      rows: 1,
      newest_observed_at: T1,
      oldest_observed_at: T1,
    });
    expect(r.freshness.Filesystem).toEqual({
      rows: 2,
      newest_observed_at: T2,
      oldest_observed_at: T1,
    });
    expect(r.freshness.NetworkInterface.rows).toBe(1);

    expect(r.baselines.dir).toBe('/opt/xiNAS/healthcheck_profiles');
    expect(r.baselines.profiles.map((p: { name: string }) => p.name)).toContain('standard');
    expect(r.catalog).toEqual({ version: '1', tool: 'health.catalog' });

    const tools = r.tools as Array<{ name: string; min_role: string; escalation?: unknown }>;
    expect(tools.map((t) => t.name)).toContain('arrays.list');
    expect(tools.map((t) => t.name)).toContain('health.context');
    expect(tools.map((t) => t.name)).not.toContain('health.probe.run');
    expect(tools.find((t) => t.name === 'health.check')?.escalation).toMatchObject({
      arg: 'profile',
      value: 'deep',
      min_role: 'operator',
      requires_mcp_apply: true,
    });
    expect(r.targets).toEqual({ resolved: [], unknown: [] });
  });

  it('resolves targets against every observed and desired kind', async () => {
    const res = await get(VIEWER_TOKEN, '?targets=fs-data,arr-1,sh-1,ib0,nope');
    expect(res.status).toBe(200);
    expect(res.body.result.targets).toEqual({
      resolved: [
        { id: 'fs-data', kind: 'Filesystem', source: 'observed' },
        { id: 'arr-1', kind: 'XiraidArray', source: 'observed' },
        { id: 'sh-1', kind: 'Share', source: 'desired' },
        { id: 'ib0', kind: 'NetworkInterface', source: 'observed' },
      ],
      unknown: ['nope'],
    });
    const bad = await get(VIEWER_TOKEN, '?targets=fs-data,../etc');
    expect(bad.status).toBe(400);
  });

  it('re-reads the same run by run_id; an unknown run_id mints a new one with a RUN_UNKNOWN warning', async () => {
    const first = (await get(OPERATOR_TOKEN)).body.result.run;
    const again = await get(OPERATOR_TOKEN, `?run_id=${first.run_id}`);
    expect(again.body.result.run.run_id).toBe(first.run_id);
    expect(again.body.result.run.issued_at).toBe(first.issued_at);
    expect(again.body.warnings).toEqual([]);

    const fresh = await get(OPERATOR_TOKEN, '?run_id=00000000-0000-4000-8000-000000000000');
    expect(fresh.status).toBe(200);
    expect(fresh.body.result.run.run_id).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(fresh.body.warnings).toEqual([
      expect.objectContaining({
        code: 'RUN_UNKNOWN',
        details: { run_id: '00000000-0000-4000-8000-000000000000' },
      }),
    ]);
  });

  it('a REST operator may run deep and probes; an admin too', async () => {
    const op = (await get(OPERATOR_TOKEN)).body.result;
    expect(op.run.permitted).toEqual({
      deterministic: ['quick', 'standard', 'deep'],
      baseline: false,
      probe_run: 'allowed',
      apply: false,
    });
    expect(op.tools.map((t: { name: string }) => t.name)).toContain('health.probe.run');
    const admin = (await get(ADMIN_TOKEN)).body.result;
    expect(admin.run.permitted.probe_run).toBe('allowed');
    expect(admin.run.role).toBe('admin');
  });

  it('GET /health/catalog serves the versioned check catalog verbatim to a viewer', async () => {
    const res = await request(setup.app)
      .get('/api/v1/health/catalog')
      .set('Authorization', VIEWER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(AGENTIC_CATALOG);
    expect(res.body.result.version).toBe('1');
    expect(res.body.result.checks.length).toBeGreaterThan(10);
  });

  it('answers UNSUPPORTED when the prompt feature is disabled', async () => {
    (setup.ctx as { healthPrompt?: unknown }).healthPrompt = undefined;
    const res = await get(VIEWER_TOKEN);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('UNSUPPORTED');
  });

  it('GET /health?run_id= records the report digest in the ledger and echoes the run', async () => {
    const run = (await get(OPERATOR_TOKEN)).body.result.run;
    const res = await request(setup.app)
      .get(`/api/v1/health?profile=quick&run_id=${run.run_id}`)
      .set('Authorization', OPERATOR_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.run_id).toBe(run.run_id);
    expect(res.body.warnings).toEqual([]);
    const entry = setup.ctx.healthPrompt?.ledger.get(run.run_id);
    expect(entry?.reports).toHaveLength(1);
    expect(entry?.reports[0]).toMatchObject({
      tool: 'health.check',
      args_digest: digestOf({ profile: 'quick' }),
      report_digest: digestOf(res.body.result),
      collected_at: res.body.result.completed_at,
    });

    const unknown = await request(setup.app)
      .get('/api/v1/health?profile=quick&run_id=stale-run')
      .set('Authorization', OPERATOR_TOKEN);
    expect(unknown.status).toBe(200);
    expect(unknown.body.result.run_id).toBe('stale-run');
    expect(unknown.body.warnings.map((w: { code: string }) => w.code)).toContain('RUN_UNKNOWN');
  });
});

/** The pure pieces the route composes. */
describe('health context helpers (S19b)', () => {
  it('permittedFor: rank, client and mcp.allow_apply decide deep and probe_run', () => {
    expect(permittedFor('viewer', 'rest', false)).toEqual({
      deterministic: ['quick', 'standard'],
      baseline: false,
      probe_run: 'denied',
      apply: false,
    });
    expect(permittedFor('viewer', 'mcp', true).probe_run).toBe('denied');
    expect(permittedFor('operator', 'mcp', false)).toMatchObject({
      deterministic: ['quick', 'standard'],
      probe_run: 'denied',
    });
    expect(permittedFor('operator', 'mcp', true)).toMatchObject({
      deterministic: ['quick', 'standard', 'deep'],
      probe_run: 'confirmable',
    });
    expect(permittedFor('operator', 'rest', false)).toMatchObject({
      deterministic: ['quick', 'standard', 'deep'],
      probe_run: 'allowed',
    });
    expect(permittedFor('admin', 'rest', true).probe_run).toBe('allowed');
  });

  it('declaredAbsent: absent only when proven, never from an empty answer (AC-04)', () => {
    expect(
      declaredAbsent({
        shares: 0,
        nfsUnitLoadState: 'not-found',
        arrays: 0,
        collectors: { XiraidArray: 'running' },
      }),
    ).toEqual(['nfs', 'raid']);
    expect(
      declaredAbsent({ shares: 0, nfsUnitLoadState: 'not-found', arrays: 0, collectors: {} }),
    ).toEqual(['nfs']);
    expect(
      declaredAbsent({ shares: 0, nfsUnitLoadState: 'not-found', arrays: 0, collectors: null }),
    ).toEqual(['nfs']);
    expect(
      declaredAbsent({
        shares: 0,
        nfsUnitLoadState: 'not-found',
        arrays: 0,
        collectors: { XiraidArray: 'error' },
      }),
    ).toEqual(['nfs']);
    expect(
      declaredAbsent({
        shares: 1,
        nfsUnitLoadState: 'not-found',
        arrays: 1,
        collectors: { XiraidArray: 'running' },
      }),
    ).toEqual([]);
    expect(
      declaredAbsent({ shares: 0, nfsUnitLoadState: null, arrays: 0, collectors: null }),
    ).toEqual([]);
    expect(
      declaredAbsent({ shares: 0, nfsUnitLoadState: 'loaded', arrays: 0, collectors: null }),
    ).toEqual([]);
  });
});
