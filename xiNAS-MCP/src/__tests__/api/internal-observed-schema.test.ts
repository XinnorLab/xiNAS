import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { loadObservedSchemas } from '../../api/observed-schemas.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-j3';

/**
 * Build an app whose ctx HAS inbound observation schema validation wired
 * (observedSchemas + ajv from loadObservedSchemas()), plus the internal-agent
 * bearer and a tracker. Mirrors internal-observed.test.ts's buildAppWithAgent
 * but additionally enforces the api-v1.yaml kind schemas on every upsert.
 */
async function buildAppWithSchemas(): Promise<
  TestSetup & { cleanup(): Promise<void>; observedLoaded: boolean }
> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  const observed = loadObservedSchemas();
  // The spec IS present in the repo; tests run from source. A null here means
  // the path resolution is broken — surface it as a hard failure.
  if (!observed) {
    throw new Error('loadObservedSchemas() returned null — api-v1.yaml not found in test env');
  }

  const ctx: ApiContext = {
    config: setup.config,
    state: setup.state,
    tracker,
    observedSchemas: observed.schemas,
    ajv: observed.ajv,
  };
  const { createApp } = await import('../../api/app.js');
  const app = createApp(ctx);

  return {
    ...setup,
    app,
    observedLoaded: true,
    async cleanup() {
      await setup.cleanup();
    },
  };
}

/** A full Disk object satisfying the api-v1.yaml Disk schema. */
function validDisk(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    kind: 'Disk',
    id,
    metadata: {
      revision: 1,
      created_at: now,
      modified_at: now,
      owner: 'agent:root',
      source: 'agent:disk-collector',
      validation_status: 'valid',
    },
    spec: {},
    status: {
      device_path: '/dev/nvme0n1',
      serial: 'SN-0001',
      model: 'Test NVMe',
      capacity_bytes: 1_000_204_886_016,
      safe_for_use: true,
      observed_at: now,
    },
  };
}

describe('POST /internal/v1/observed — schema enforcement (J3)', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; observedLoaded: boolean };

  beforeEach(async () => {
    setup = await buildAppWithSchemas();
  });

  afterEach(() => setup.cleanup());

  it('loaded the observed schemas from api-v1.yaml', () => {
    expect(setup.observedLoaded).toBe(true);
  });

  it('accepts a VALID Disk upsert (200, accepted: 1)', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: validDisk('nvme0n1') }],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result.accepted).toBe(1);
  });

  it('rejects an INVALID Disk upsert (missing required status fields) with 400 naming the delta index', async () => {
    const broken = validDisk('nvme0n1');
    // Drop required status fields so the kind schema fails.
    (broken.status as Record<string, unknown>) = { device_path: '/dev/nvme0n1' };

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [
        { kind: 'Disk', id: 'ok0', op: 'upsert', value: validDisk('ok0') },
        { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: broken },
      ],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0]?.message).toMatch(/delta\[1\]/);
    // Nothing written — the whole batch is rejected before the transaction.
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/ok0')).toBeNull();
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')).toBeNull();
  });

  it('rejects an upsert with an unknown kind with 400 "unknown kind"', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Bogus', id: 'x', op: 'upsert', value: { kind: 'Bogus' } }],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0]?.message).toMatch(/unknown kind/);
  });
});
