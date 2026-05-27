import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  buildTestApp,
  ADMIN_TOKEN,
  seedCluster,
  seedNode,
  seedShare,
  seedNfsProfile,
} from './_helpers.js';

/**
 * All 30 GET operations from api-v1.yaml. Each entry: [path, expectedStatus].
 * 200 = success against a seeded store; 404 = item-by-id that we don't seed
 * (verifies the NOT_FOUND envelope path).
 *
 * Per api-v1.yaml count:
 *   system: 4 (system, capabilities, inventory, controllers)
 *   storage: 5 (disks, arrays, arrays/{id}, filesystems, filesystems/{id})
 *   nfs: 6 (shares, shares/{id}, shares/{id}/sessions, nfs-profiles,
 *           nfs-profiles/{id}, export-groups)
 *   network: 4 (network, network/interfaces, network/interfaces/{id},
 *               service-ips)
 *   health: 1
 *   tasks: 3 (tasks, tasks/{id}, tasks/{id}/watch)
 *   events: 1; audit: 1
 *   config-history: 4 (snapshots, snapshots/{id}, diff, drift)
 *   support-bundle: 1 (GET /{task_id})
 * Total: 30
 */
const GET_OPS: Array<[string, number]> = [
  // system
  ['/api/v1/system', 200],
  ['/api/v1/capabilities', 200],
  ['/api/v1/inventory', 200],
  ['/api/v1/controllers', 200],
  // storage
  ['/api/v1/disks', 200],
  ['/api/v1/arrays', 200],
  ['/api/v1/arrays/seeded-array', 200],
  ['/api/v1/filesystems', 200],
  ['/api/v1/filesystems/seeded-fs', 200],
  // nfs
  ['/api/v1/shares', 200],
  ['/api/v1/shares/s1', 200],
  ['/api/v1/shares/s1/sessions', 200],
  ['/api/v1/nfs-profiles', 200],
  ['/api/v1/nfs-profiles/default', 200],
  ['/api/v1/export-groups', 200],
  // network
  ['/api/v1/network', 200],
  ['/api/v1/network/interfaces', 200],
  ['/api/v1/network/interfaces/seeded-if', 200],
  ['/api/v1/service-ips', 200],
  // health
  ['/api/v1/health', 200],
  // tasks
  ['/api/v1/tasks', 200],
  ['/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', 200],
  ['/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/watch', 200],
  // events + audit
  ['/api/v1/events', 200],
  ['/api/v1/audit', 200],
  // config-history (snapshots/{id} 404s because the bridge is deferred
  // and the route always throws NOT_FOUND)
  ['/api/v1/config-history/snapshots', 200],
  ['/api/v1/config-history/snapshots/any', 404],
  ['/api/v1/config-history/diff?from=a&to=b', 200],
  ['/api/v1/config-history/drift', 200],
  // support-bundle download (404s because no bundle exists)
  ['/api/v1/support-bundle/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', 404],
];

describe('GET integration — envelope shape per endpoint', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
    // Seed every key the routes read so 200 endpoints actually succeed.
    seedCluster(setup.state);
    seedNode(setup.state);
    seedShare(setup.state, 's1');
    seedNfsProfile(setup.state);
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/seeded-array', {
      kind: 'XiraidArray',
      id: 'seeded-array',
      spec: { name: 'seeded-array', level: 'raid5', member_disk_ids: [] },
      status: { state: 'optimal', volume_path: '/dev/x', usable_capacity_bytes: 0 },
    });
    setup.state.kv.put('/xinas/v1/observed/Filesystem/seeded-fs', {
      kind: 'Filesystem',
      id: 'seeded-fs',
      spec: { fs_type: 'xfs', backing_device: '/dev/x', mountpoint: '/srv/fs' },
      status: { mounted: true, uuid: 'u', size_bytes: 1, free_bytes: 1 },
    });
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/seeded-if', {
      kind: 'NetworkInterface',
      id: 'seeded-if',
      spec: { managed_by_xinas: true },
      status: { driver: 'mlx5_ib', rdma_capable: true, link_state: 'up', current_addresses: [] },
    });
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'k',
      state: 'running',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: 'r',
      correlation_id: 'c',
      input_hash: 'h',
      risk_level: 'non_disruptive',
      affected_resources: [],
      created_at: '2026-05-27T11:00:00Z',
      updated_at: '2026-05-27T11:00:00Z',
    });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  for (const [path, expectedStatus] of GET_OPS) {
    it(`${path} returns ${expectedStatus} with an Envelope-shaped response`, async () => {
      const res = await request(setup.app).get(path).set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(expectedStatus);
      // /tasks/{id}/watch returns SSE (text/event-stream), not JSON;
      // assert the SSE event shape instead of the envelope shape.
      if (path.endsWith('/watch')) {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        expect(res.text).toContain('event: snapshot');
        return;
      }
      // Required Envelope fields per api-v1.yaml — present even on errors:
      expect(res.body).toHaveProperty('request_id');
      expect(res.body).toHaveProperty('correlation_id');
      expect(res.body).toHaveProperty('state_revision');
      expect(res.body).toHaveProperty('result');
      expect(typeof res.body.request_id).toBe('string');
      expect(Array.isArray(res.body.warnings ?? [])).toBe(true);
      expect(Array.isArray(res.body.errors ?? [])).toBe(true);
    });
  }
});
