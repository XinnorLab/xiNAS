import os from 'node:os';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedInfrastructure } from '../../api/bootstrap.js';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

// ADR-0016: the api self-seeds the infrastructure singletons at startup.
// These tests run against an UNSEEDED store — the fresh-install state that
// bug #32 hit — with no seedCluster()/seedNode() helper calls.
describe('ADR-0016 infrastructure bootstrap', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('unseeded store still 404s (pins the pre-bootstrap failure mode)', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('seeds cluster + node so GET /system returns 200 with the ADR-0003 shapes', async () => {
    seedInfrastructure(setup.state, setup.config);
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const { cluster, node } = res.body.result;
    expect(cluster.status.mode).toBe('single_node');
    expect(cluster.status.member_node_ids).toEqual([setup.config.controller_id]);
    expect(cluster.spec.display_name).toBe(os.hostname());
    expect(node.id).toBe(setup.config.controller_id);
    expect(node.spec.hostname).toBe(os.hostname());
    expect(node.status.agent_state).toBe('offline');
  });

  it('GET /capabilities returns the Phase 0 flags, mcp.allow_apply mirrors config (absent → false)', async () => {
    seedInfrastructure(setup.state, setup.config); // test config has no mcp block
    const res = await request(setup.app)
      .get('/api/v1/capabilities')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.ha).toBe('not_enabled');
    expect(res.body.result.quorum).toBe('not_enabled');
    expect(res.body.result.witness).toBe('not_enabled');
    expect(res.body.result['nfs.v3_locking_managed']).toBe(false);
    expect(res.body.result['nfs.recovery_state_managed']).toBe(false);
    expect(res.body.result['mcp.allow_apply']).toBe(false);
  });

  it('re-run is a no-op that preserves operator edits (restart over existing DB)', async () => {
    seedInfrastructure(setup.state, setup.config);
    const row = setup.state.kv.get<{ spec: { display_name: string } }>('/xinas/v1/cluster');
    expect(row).not.toBeNull();
    const edited = structuredClone(row!.value);
    edited.spec.display_name = 'operator-named';
    setup.state.kv.put('/xinas/v1/cluster', edited);
    const revisionAfterEdit = setup.state.kv.get('/xinas/v1/cluster')!.revision;

    seedInfrastructure(setup.state, setup.config); // simulated restart

    const after = setup.state.kv.get<{ spec: { display_name: string } }>('/xinas/v1/cluster');
    expect(after!.value.spec.display_name).toBe('operator-named');
    // Revisions are monotonic per key, so revision-stable === zero writes:
    // pins the PURE no-op path (an unconditional read-modify-write would
    // preserve display_name but bump the revision).
    expect(after!.revision).toBe(revisionAfterEdit);
  });

  it('refreshes ONLY the mcp.allow_apply mirror when the config flag flips', async () => {
    seedInfrastructure(setup.state, setup.config); // allow_apply false
    const nodeKey = `/xinas/v1/nodes/${setup.config.controller_id}`;
    const nodeBefore = setup.state.kv.get(nodeKey);

    seedInfrastructure(setup.state, { ...setup.config, mcp: { allow_apply: true } });

    const cluster = setup.state.kv.get<{
      spec: { display_name: string };
      status: { capabilities: Record<string, unknown> };
    }>('/xinas/v1/cluster');
    expect(cluster!.value.status.capabilities['mcp.allow_apply']).toBe(true);
    expect(cluster!.value.spec.display_name).toBe(os.hostname()); // untouched
    const nodeAfter = setup.state.kv.get(nodeKey);
    expect(nodeAfter!.revision).toBe(nodeBefore!.revision); // node row not rewritten
  });

  it('reseeds a missing node without touching an existing cluster (rule independence)', () => {
    seedInfrastructure(setup.state, setup.config);
    const nodeKey = `/xinas/v1/nodes/${setup.config.controller_id}`;
    const deleted = setup.state.kv.delete(nodeKey);
    expect(deleted.ok).toBe(true);
    const clusterBefore = setup.state.kv.get('/xinas/v1/cluster');

    seedInfrastructure(setup.state, setup.config);

    const node = setup.state.kv.get<{ id: string }>(nodeKey);
    expect(node).not.toBeNull();
    expect(node!.value.id).toBe(setup.config.controller_id);
    const clusterAfter = setup.state.kv.get('/xinas/v1/cluster');
    expect(clusterAfter!.revision).toBe(clusterBefore!.revision); // cluster untouched
  });
});
