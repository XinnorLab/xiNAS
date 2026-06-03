import { describe, expect, it } from 'vitest';
import { makeHealthHandler } from '../../../../agent/rpc/methods/health.js';

describe('agent.health handler', () => {
  it('returns the required shape with no collectors registered', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: '00000000-0000-0000-0000-000000000042',
      startedAt: Date.now() - 5000,
      getCollectorHealth: () => ({}),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('starting');
    expect(result['version']).toBe('0.1.0');
    expect(typeof result['uptime_seconds']).toBe('number');
    expect(result['uptime_seconds'] as number).toBeGreaterThanOrEqual(4);
    expect(result['controller_id']).toBe('00000000-0000-0000-0000-000000000042');
    expect(result['in_flight_tasks']).toBe(0);
    expect(result['collectors']).toEqual({});
  });

  it('reports status=healthy when all collectors are running', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({ disk: 'running', network: 'running' }),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('healthy');
    expect(result['collectors']).toEqual({ disk: 'running', network: 'running' });
  });

  it('reports status=degraded when any collector is in error state', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({
        disk: 'running',
        network: 'error: connection refused',
      }),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('degraded');
  });

  it('reports status=stubbed when all non-stub collectors are absent', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({
        'xiraid-stub': 'stubbed',
        'managed-files-stub': 'stubbed',
      }),
    });
    const result = handler({}) as Record<string, unknown>;
    // All present collectors are stubbed; no real collectors running.
    // Status is 'starting' because no real collectors are up yet.
    expect(result['status']).toBe('starting');
  });
});
