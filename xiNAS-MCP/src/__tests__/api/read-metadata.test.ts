import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

/**
 * Regression for the independent-review #6 finding: public observed-resource
 * responses omitted the api-v1.yaml-required `metadata` object. The KV layer
 * tracks revision/created_at/modified_at/owner/source/validation_status PER ROW
 * (not inside the stored value), so the read path must project them into the
 * response. embedMetadata()/unwrapResources() now do that for resource reads.
 */
describe('read path embeds the schema-required metadata (review #6)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    // The agent's observed value carries NO metadata (collectors emit partial
    // shapes); the KV row supplies the tracking fields.
    setup.state.kv.put('/xinas/v1/observed/User/1000', {
      kind: 'User',
      id: '1000',
      status: { uid: 1000, name: 'alice', source: 'nss' },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  function assertMetadata(meta: Record<string, unknown>): void {
    expect(typeof meta.revision).toBe('number');
    // created_at / modified_at are projected as ISO-8601 date-time strings.
    expect(typeof meta.created_at).toBe('string');
    expect(Number.isNaN(Date.parse(meta.created_at as string))).toBe(false);
    expect(typeof meta.modified_at).toBe('string');
    expect(Number.isNaN(Date.parse(meta.modified_at as string))).toBe(false);
    expect(typeof meta.owner).toBe('string');
    expect(typeof meta.source).toBe('string');
    expect(['valid', 'drift', 'invalid', 'pending']).toContain(meta.validation_status);
  }

  it('GET /api/v1/users/{uid} returns a metadata object', async () => {
    const res = await request(setup.app)
      .get('/api/v1/users/1000')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.metadata).toBeDefined();
    assertMetadata(res.body.result.metadata);
    // The stored value is preserved alongside the injected metadata.
    expect(res.body.result.status.name).toBe('alice');
  });

  it('GET /api/v1/users list embeds metadata on each row', async () => {
    const res = await request(setup.app).get('/api/v1/users').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    assertMetadata(res.body.result[0].metadata);
  });

  it('event records (non-resources) are NOT given synthesized metadata', async () => {
    // Events are echoed raw via unwrapValues — they have no Metadata schema.
    setup.state.kv.put('/xinas/v1/events/2026-06-03T00:00:00.000Z/evt1', {
      kind: 'agent_state_changed',
      from: 'offline',
      to: 'healthy',
    });
    const res = await request(setup.app).get('/api/v1/events').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const evt = res.body.result.find((e: { kind?: string }) => e.kind === 'agent_state_changed');
    expect(evt).toBeDefined();
    expect(evt.metadata).toBeUndefined();
  });
});
