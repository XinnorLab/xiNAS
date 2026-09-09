import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfileCatalog } from '../../api/health/profiles.js';
import { digestOf } from '../../api/health/run-ledger.js';
import {
  OPERATOR_TOKEN,
  VIEWER_TOKEN,
  buildTestApp,
  buildTestAppWithMockAgent,
} from './_helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_PROFILES = resolve(here, '../../../../healthcheck_profiles');
const ENGINE_SECTIONS = [
  'services',
  'cpu',
  'kernel',
  'vm',
  'network',
  'rdma',
  'storage',
  'filesystem',
  'perf_tuning',
  'nfs',
]; // deliberately without nvme_health: the live list, not the static copy, must drive the gap

const okRun = (profile: string) => ({
  status: 'success',
  collected_at: '2026-09-09T12:00:00.000Z',
  duration_ms: 1234,
  engine: { module: 'xinas_menu.health.engine', version: '3.13.2' },
  report: { metadata: { profile }, overall: 'PASS', summary: { pass: 1 }, checks: [] },
  stderr_tail: '',
});

/** S19c T4 — spec §8.1, §8.4: the api side of the baseline adapter. */
describe('GET /api/v1/health/baseline (S19c)', () => {
  let setup: Awaited<ReturnType<typeof buildTestAppWithMockAgent>>;
  let seen: unknown[];

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    if (setup.ctx.healthPrompt === undefined) throw new Error('health prompt context missing');
    setup.ctx.healthPrompt.profiles = loadProfileCatalog(REPO_PROFILES);
    seen = [];
    setup.mockAgent.respondToRpc('health.baseline', (params) => {
      seen.push(params);
      const p = params as { sections?: boolean; profile_path?: string };
      if (p.sections === true) {
        return {
          result: {
            status: 'success',
            collected_at: '2026-09-09T11:59:00.000Z',
            sections: ENGINE_SECTIONS,
            version: '3.13.2',
          },
        };
      }
      return { result: okRun(p.profile_path?.split('/').at(-1)?.replace('.yml', '') ?? '?') };
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const get = (query = '', token = VIEWER_TOKEN) =>
    request(setup.app).get(`/api/v1/health/baseline${query}`).set('Authorization', token);

  it('runs the standard profile through the agent with the capped timeout and the engine version', async () => {
    const res = await get('?profile=standard');
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { sections: true },
      { profile_path: join(REPO_PROFILES, 'standard.yml'), timeout_s: 180 },
    ]);
    expect(res.body.result).toEqual({
      profile: {
        name: 'standard',
        path: join(REPO_PROFILES, 'standard.yml'),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        timeout_seconds: 180,
        sections_without_checker: [],
      },
      collection: {
        status: 'success',
        collected_at: '2026-09-09T12:00:00.000Z',
        duration_ms: 1234,
        from_cache: false,
        age_s: 0,
      },
      engine: { module: 'xinas_menu.health.engine', version: '3.13.2' },
      report: okRun('standard').report,
      error: null,
      stderr_tail: '',
      run_id: null,
    });
    expect(res.body.warnings).toEqual([]);
  });

  it('defaults to standard; deep is capped at 300 s and its checker gap comes from the engine list', async () => {
    const res = await get();
    expect(res.body.result.profile.name).toBe('standard');
    const deep = await get('?profile=deep');
    expect(deep.status).toBe(200);
    expect(deep.body.result.profile.timeout_seconds).toBe(300);
    expect(deep.body.result.profile.sections_without_checker).toEqual(['nvme_health', 'kerberos']);
    // the section list was asked once, not per call
    expect(seen.filter((p) => (p as { sections?: boolean }).sections === true)).toHaveLength(1);
  });

  it('serves a cached success within max_age_s with from_cache and the original collected_at', async () => {
    const first = await get('?profile=quick');
    expect(first.body.result.collection.from_cache).toBe(false);
    const cached = await get('?profile=quick&max_age_s=600');
    expect(cached.status).toBe(200);
    expect(cached.body.result.collection).toMatchObject({
      status: 'success',
      from_cache: true,
      collected_at: first.body.result.collection.collected_at,
    });
    expect(cached.body.result.collection.age_s).toBeGreaterThanOrEqual(0);
    expect(cached.body.result.report).toEqual(first.body.result.report);
    const fresh = await get('?profile=quick&max_age_s=0');
    expect(fresh.body.result.collection.from_cache).toBe(false);
    expect(
      seen.filter((p) => (p as { profile_path?: string }).profile_path !== undefined),
    ).toHaveLength(2);
  });

  it('a failed engine run is passed through as its status and is never cached', async () => {
    setup.mockAgent.respondToRpc('health.baseline', (params) => {
      const p = params as { sections?: boolean };
      if (p.sections === true) {
        return {
          result: {
            status: 'success',
            collected_at: 'x',
            sections: ENGINE_SECTIONS,
            version: '3.13.2',
          },
        };
      }
      return {
        result: {
          status: 'timeout',
          collected_at: '2026-09-09T12:03:00.000Z',
          duration_ms: 60_000,
          engine: { module: 'xinas_menu.health.engine', version: '3.13.2' },
          report: null,
          stderr_tail: 'still running',
          error: { code: 'TIMEOUT', message: 'engine exceeded 60000 ms and was killed' },
        },
      };
    });
    const res = await get('?profile=quick');
    expect(res.status).toBe(200);
    expect(res.body.result.collection.status).toBe('timeout');
    expect(res.body.result.report).toBeNull();
    expect(res.body.result.error).toEqual({
      code: 'TIMEOUT',
      message: 'engine exceeded 60000 ms and was killed',
    });
    expect(res.body.result.stderr_tail).toBe('still running');
    const again = await get('?profile=quick&max_age_s=600');
    expect(again.body.result.collection.from_cache).toBe(false);
  });

  it('validates profile and max_age_s', async () => {
    const unknown = await get('?profile=nope');
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].code).toBe('INVALID_ARGUMENT');
    expect(unknown.body.errors[0].details.known).toEqual(['deep', 'quick', 'standard']);
    expect((await get('?profile=quick&max_age_s=5000')).status).toBe(400);
    expect((await get('?profile=quick&max_age_s=abc')).status).toBe(400);
    expect((await get('?profile=Quick')).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('records the result digest under a known run_id; an unknown run is RUN_UNKNOWN', async () => {
    const ctxRes = await request(setup.app)
      .get('/api/v1/health/context')
      .set('Authorization', OPERATOR_TOKEN);
    const runId = ctxRes.body.result.run.run_id as string;
    const res = await get(`?profile=quick&run_id=${runId}`, OPERATOR_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.run_id).toBe(runId);
    expect(res.body.warnings).toEqual([]);
    const entry = setup.ctx.healthPrompt?.ledger.get(runId);
    expect(entry?.reports).toHaveLength(1);
    expect(entry?.reports[0]).toMatchObject({
      tool: 'health.baseline',
      args_digest: digestOf({ profile: 'quick', max_age_s: 0 }),
      report_digest: digestOf(res.body.result),
      collected_at: '2026-09-09T12:00:00.000Z',
    });
    const stale = await get('?profile=quick&run_id=gone');
    expect(stale.status).toBe(200);
    expect(stale.body.result.run_id).toBe('gone');
    expect(stale.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
  });

  it('answers UNSUPPORTED when the prompt feature is disabled', async () => {
    (setup.ctx as { healthPrompt?: unknown }).healthPrompt = undefined;
    const res = await get('?profile=quick');
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('UNSUPPORTED');
  });
});

describe('GET /api/v1/health/baseline without an agent client (S19c, SAFE-04)', () => {
  it('answers 200 with EXECUTOR_UNAVAILABLE instead of failing', async () => {
    const setup = await buildTestApp();
    try {
      if (setup.ctx.healthPrompt === undefined) throw new Error('health prompt context missing');
      setup.ctx.healthPrompt.profiles = loadProfileCatalog(REPO_PROFILES);
      const res = await request(setup.app)
        .get('/api/v1/health/baseline?profile=quick')
        .set('Authorization', VIEWER_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.result.collection).toMatchObject({ status: 'error', from_cache: false });
      expect(res.body.result.error.code).toBe('EXECUTOR_UNAVAILABLE');
      expect(res.body.result.report).toBeNull();
      expect(res.body.result.engine).toBeNull();
      // the static list still names the gap
      const deep = await request(setup.app)
        .get('/api/v1/health/baseline?profile=deep')
        .set('Authorization', VIEWER_TOKEN);
      expect(deep.body.result.profile.sections_without_checker).toEqual(['kerberos']);
    } finally {
      await setup.cleanup();
    }
  });
});
