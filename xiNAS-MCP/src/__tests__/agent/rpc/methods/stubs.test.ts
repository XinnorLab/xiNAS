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

// ---- all ADR-0002 enumerated methods are in the stub list ----

const REQUIRED_STUB_METHODS = [
  'arrays.create',
  'arrays.delete',
  'arrays.import',
  'arrays.list',
  'spare.set',
  'fs.create',
  'fs.mount',
  'fs.unmount',
  'fs.grow',
  'fs.set_quota_mode',
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
  'task.begin',
  'task.stage_report',
  'task.cancel',
  'task.list_inflight',
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
      await dispatch(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'arrays.create', params: {} }),
      ),
    );
    expect(response.error?.code).toBe(-32000);
    expect(response.error?.data?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(response.error?.data?.method).toBe('arrays.create');
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
