import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../../../../agent/rpc/dispatch.js';
import { makeHealthHandler } from '../../../../agent/rpc/methods/health.js';
import { STUB_METHODS, makeStubHandler } from '../../../../agent/rpc/methods/stubs.js';

// ---- individual stub handler shape ----

describe('makeStubHandler', () => {
  it('throws with code=EXECUTOR_UNSUPPORTED and the method name', () => {
    const handler = makeStubHandler('arrays.create');
    expect(() => handler({})).toThrow();
    try {
      handler({});
    } catch (err: unknown) {
      const typed = err as Error & { code?: string; rpcMethod?: string };
      expect(typed.code).toBe('EXECUTOR_UNSUPPORTED');
      expect(typed.rpcMethod).toBe('arrays.create');
    }
  });
});

// ---- task.* methods are NOT api→agent stubs (real handlers later / push) ----

describe('task.* methods are not enumerated stubs', () => {
  it.each(['task.begin', 'task.cancel', 'task.list_inflight', 'task.stage_report'])(
    '%s is NOT in STUB_METHODS (real handler later / push)',
    (m) => {
      expect(STUB_METHODS).not.toHaveProperty(m);
    },
  );
});

// ---- arrays mutation methods are NOT api→agent stubs (superseded, S3) ----

describe('arrays mutation methods are not enumerated stubs (superseded by task envelope, S3)', () => {
  it.each(['arrays.create', 'arrays.delete', 'arrays.import', 'spare.set'])(
    '%s is NOT in STUB_METHODS (mutations dispatch via task.begin)',
    (m) => {
      expect(STUB_METHODS).not.toHaveProperty(m);
    },
  );
});

// ---- fs mutation methods are NOT api→agent stubs (superseded, S5) ----

describe('fs mutation methods are not enumerated stubs (superseded by task envelope, S5)', () => {
  it.each(['fs.create', 'fs.mount', 'fs.unmount', 'fs.grow', 'fs.set_quota_mode'])(
    '%s is NOT in STUB_METHODS (mutations dispatch via task.begin)',
    (m) => {
      expect(STUB_METHODS).not.toHaveProperty(m);
    },
  );
});

// ---- all ADR-0002 enumerated methods are in the stub list ----

const REQUIRED_STUB_METHODS = [
  // On-demand observation reads (deferred to WS12; push model is live in S0/S1).
  'inventory.collect',
  'disks.list',
  'filesystems.list',
  'mounts.list',
  'network.snapshot',
  'systemd.units_status',
  'exports.list',
  'nfs.sessions.list',
  // arrays.create/delete/import + spare.set: superseded by the task envelope
  // (S3, ADR-0006) — see the describe block above. Only the read stub remains.
  'arrays.list',
  // fs.create/mount/unmount/grow/set_quota_mode: superseded by the task
  // envelope (S5, ADR-0007) — see the describe block above.
  'nfs.exports.add',
  'nfs.exports.update',
  'nfs.exports.remove',
  'nfs.profile.render',
  'nfs.profile.apply',
  'nfs.profile.observe',
  'network.render_netplan',
  'network.flush_managed',
  'network.apply',
  'systemd.reload',
  'systemd.restart',
  // task.begin/cancel/list_inflight/stage_report are intentionally NOT here:
  // the first three get real handlers in a later S2 task; stage_report becomes
  // the agent→api push (POST /internal/v1/task_progress). See the
  // "task.* methods are not enumerated stubs" describe block above.
  'managed_files.checksums',
];

describe('STUB_METHODS coverage', () => {
  for (const method of REQUIRED_STUB_METHODS) {
    it(`includes stub for "${method}"`, () => {
      expect(STUB_METHODS).toHaveProperty(method);
    });
  }
});

// ---- integration: dispatcher returns -32000 for stubbed methods ----

describe('dispatcher integration with stubs', () => {
  const healthHandler = makeHealthHandler({
    version: '0.0.0',
    controllerId: 'test',
    startedAt: Date.now(),
    getCollectorHealth: () => ({}),
  });
  const allHandlers = { 'agent.health': healthHandler, ...STUB_METHODS };
  const dispatch = createDispatcher(allHandlers);

  it('stubbed method returns -32000 EXECUTOR_UNSUPPORTED (not -32601)', async () => {
    const response = JSON.parse(
      await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'arrays.list', params: {} })),
    );
    expect(response.error?.code).toBe(-32000);
    expect(response.error?.data?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(response.error?.data?.method).toBe('arrays.list');
  });

  it('truly unknown method returns -32601 not -32000', async () => {
    const response = JSON.parse(
      await dispatch(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'completely.unknown', params: {} }),
      ),
    );
    expect(response.error?.code).toBe(-32601);
  });

  it('agent.health still resolves to a success result', async () => {
    const response = JSON.parse(
      await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'agent.health', params: {} })),
    );
    expect(response.result?.status).toBeDefined();
    expect(response.error).toBeUndefined();
  });
});
