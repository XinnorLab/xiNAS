import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../api/envelope.js';

describe('buildEnvelope', () => {
  it('produces the required fields with sensible defaults', () => {
    const env = buildEnvelope({
      request_id: 'req-1',
      correlation_id: 'corr-1',
      state_revision: 42,
      result: { hello: 'world' },
    });
    expect(env).toEqual({
      request_id: 'req-1',
      correlation_id: 'corr-1',
      state_revision: 42,
      warnings: [],
      errors: [],
      links: {},
      result: { hello: 'world' },
    });
  });

  it('forwards optional fields when given', () => {
    const env = buildEnvelope({
      request_id: 'r',
      correlation_id: 'c',
      state_revision: 1,
      operation_id: 'op-1',
      warnings: [{ code: 'AGENT_DEGRADED', message: 'agent is slow' }],
      links: { self: '/api/v1/system' },
      result: null,
    });
    expect(env.operation_id).toBe('op-1');
    expect(env.warnings).toHaveLength(1);
    expect(env.links).toEqual({ self: '/api/v1/system' });
  });
});
