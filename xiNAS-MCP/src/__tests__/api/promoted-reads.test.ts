import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReadSeams } from '../../api/handlers/read-seams.js';
import { parseRepquota } from '../../api/routes/promoted-reads.js';
import { ADMIN_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

const LIVE_SEAMS: ReadSeams = {
  journalTail: async (unit, lines) => `jun 12 a\njun 12 b (unit=${unit ?? '-'} n=${lines})\n`,
  prometheusMetrics: async () => 'xiraid_array_state 1\n',
  repquota: async () =>
    '*** Report for user quotas on device /dev/xi_data\n' +
    'root      --       0       0       0              4     0     0\n' +
    'alice     --  102400  204800  256000             12     0     0\n',
  grpcMailShow: async () => ({ recipients: ['ops@example.com'] }),
  grpcSettingsMailShow: async () => ({ relay: 'smtp.local' }),
  grpcSettingsAuthShow: async () => ({ modes: ['sys', 'krb5'] }),
};

const DEAD_SEAMS: ReadSeams = {
  journalTail: async () => null,
  prometheusMetrics: async () => null,
  repquota: async () => null,
  grpcMailShow: async () => null,
  grpcSettingsMailShow: async () => null,
  grpcSettingsAuthShow: async () => null,
};

describe('promoted read routes (S8 T5)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  afterEach(async () => {
    await setup.cleanup();
  });

  describe('live seams', () => {
    beforeEach(async () => {
      setup = await buildTestApp();
      setup.ctx.read_seams = LIVE_SEAMS;
    });

    it('serves logs/performance/quotas/pools/mail/auth-modes to a viewer', async () => {
      const get = (p: string) =>
        request(setup.app).get(`/api/v1${p}`).set('Authorization', VIEWER_TOKEN);

      const logs = await get('/system/logs?unit=nfs-server.service&lines=50');
      expect(logs.status).toBe(200);
      expect(logs.body.result.lines).toHaveLength(2);

      const perf = await get('/system/performance');
      expect(perf.body.result.available).toBe(true);
      expect(perf.body.result.metrics).toContain('xiraid_array_state');

      const quotas = await get('/quotas');
      expect(quotas.body.result.quotas).toEqual([
        { name: 'root', block_used_kib: 0, block_soft_kib: 0, block_hard_kib: 0 },
        { name: 'alice', block_used_kib: 102400, block_soft_kib: 204800, block_hard_kib: 256000 },
      ]);

      expect((await get('/mail/recipients')).body.result.recipients.recipients).toContain(
        'ops@example.com',
      );
      expect((await get('/mail/settings')).body.result.settings.relay).toBe('smtp.local');
      expect((await get('/auth/modes')).body.result.modes.modes).toContain('krb5');
    });

    it('GET /disks/{id}: 404 absent; row when observed', async () => {
      const missing = await request(setup.app)
        .get('/api/v1/disks/nope')
        .set('Authorization', ADMIN_TOKEN);
      expect(missing.status).toBe(404);

      setup.state.kv.put('/xinas/v1/observed/Disk/nvme0n1', {
        kind: 'Disk',
        id: 'nvme0n1',
        status: { device_path: '/dev/nvme0n1', health: { ok: true, wear_pct: 3 } },
      });
      const found = await request(setup.app)
        .get('/api/v1/disks/nvme0n1')
        .set('Authorization', ADMIN_TOKEN);
      expect(found.status).toBe(200);
      expect(found.body.result.status.health.ok).toBe(true);
    });
  });

  describe('dead seams degrade with warnings, never 5xx', () => {
    beforeEach(async () => {
      setup = await buildTestApp();
      setup.ctx.read_seams = DEAD_SEAMS;
    });

    it.each([
      ['/system/logs', 'lines'],
      ['/system/performance', 'metrics'],
      ['/quotas', 'quotas'],
      ['/mail/recipients', 'recipients'],
      ['/mail/settings', 'settings'],
      ['/auth/modes', 'modes'],
    ])('%s → 200 + DEGRADED warning', async (path) => {
      const res = await request(setup.app).get(`/api/v1${path}`).set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body.warnings)).toContain('DEGRADED_BACKEND_UNAVAILABLE');
    });
  });
});

describe('parseRepquota', () => {
  it('ignores headers and non-quota lines', () => {
    expect(parseRepquota('garbage\n#comment\n')).toEqual([]);
  });
});

describe('GET /pools from observed rows (S9 T7)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('serves pools with referenced_by joined from observed arrays', async () => {
    setup.state.kv.put('/xinas/v1/observed/Pool/spare1', {
      kind: 'Pool',
      id: 'spare1',
      status: { name: 'spare1', drives: ['/dev/nvme9n1'], active: true, observed_at: 'x' },
    });
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/data1', {
      kind: 'XiraidArray',
      id: 'data1',
      status: { state: 'optimal', volume_path: '/dev/xi_data1', spare_pool: 'spare1' },
    });
    const res = await request(setup.app).get('/api/v1/pools').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([
      { name: 'spare1', drives: ['/dev/nvme9n1'], active: true, referenced_by: ['data1'] },
    ]);
  });

  it('empty store → empty list (no gRPC, no warning)', async () => {
    const res = await request(setup.app).get('/api/v1/pools').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
    expect(res.body.warnings).toEqual([]);
  });
});
