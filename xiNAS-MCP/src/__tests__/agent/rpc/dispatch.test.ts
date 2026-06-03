import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../../../agent/rpc/dispatch.js';

// A trivial handler for tests — returns its params echoed.
function echoHandler(params: unknown): unknown {
  return { echo: params };
}

describe('createDispatcher', () => {
  it('routes a known method and returns a success envelope', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => ({
        status: 'starting',
        version: '0.0.0',
        uptime_seconds: 0,
        controller_id: 'test-id',
        in_flight_tasks: 0,
        collectors: {},
      }),
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
    expect(parsed.error).toBeUndefined();
  });

  it('returns -32601 for a method absent from the allow-list', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'totally.unknown', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.id).toBe(2);
    expect(parsed.error?.code).toBe(-32601);
    expect(parsed.result).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'returns -32601 for inherited Object.prototype key %s (own-property routing)',
    async (method) => {
      const dispatch = createDispatcher({ 'agent.health': echoHandler });
      const response = await dispatch(
        JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: {} }),
      );
      const parsed = JSON.parse(response);
      expect(parsed.id).toBe(7);
      expect(parsed.error?.code).toBe(-32601);
      expect(parsed.result).toBeUndefined();
    },
  );

  it('returns -32602 when the handler throws a params error', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => {
        const err = new Error('missing required param: foo') as Error & { code?: string };
        err.code = 'INVALID_PARAMS';
        throw err;
      },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32602);
  });

  it('returns -32600 for malformed (non-JSON) input', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch('this is not json at all');
    const parsed = JSON.parse(response);
    expect(parsed.id).toBeNull();
    expect(parsed.error?.code).toBe(-32600);
  });

  it('returns -32600 for a valid JSON object missing the method field', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 4, params: {} }));
    const parsed = JSON.parse(response);
    expect(parsed.id).toBe(4);
    expect(parsed.error?.code).toBe(-32600);
  });

  it('returns -32603 when the handler throws an unexpected error', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => {
        throw new Error('OS blew up');
      },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32603);
  });

  it('returns -32000 with EXECUTOR_UNSUPPORTED data when handler throws that sentinel', async () => {
    const dispatch = createDispatcher({
      'arrays.list': () => {
        const err = new Error('method not implemented in this build') as Error & {
          code?: string;
          rpcMethod?: string;
        };
        err.code = 'EXECUTOR_UNSUPPORTED';
        err.rpcMethod = 'arrays.list';
        throw err;
      },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'arrays.list', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.data?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(parsed.error?.data?.method).toBe('arrays.list');
  });
});
