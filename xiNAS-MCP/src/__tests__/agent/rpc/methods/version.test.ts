import { describe, expect, it } from 'vitest';
import { makeVersionHandler } from '../../../../agent/rpc/methods/version.js';

describe('agent.version handler', () => {
  it('returns the version field always', () => {
    const handler = makeVersionHandler({ version: '1.2.3' });
    const result = handler({}) as Record<string, unknown>;
    expect(result['version']).toBe('1.2.3');
  });

  it('includes git_sha when provided', () => {
    const handler = makeVersionHandler({ version: '1.2.3', gitSha: 'abc123' });
    const result = handler({}) as Record<string, unknown>;
    expect(result['git_sha']).toBe('abc123');
  });

  it('includes build_date when provided', () => {
    const handler = makeVersionHandler({
      version: '1.2.3',
      buildDate: '2026-05-28T00:00:00Z',
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['build_date']).toBe('2026-05-28T00:00:00Z');
  });

  it('omits git_sha and build_date when not provided (exactOptionalPropertyTypes)', () => {
    const handler = makeVersionHandler({ version: '0.0.1' });
    const result = handler({}) as Record<string, unknown>;
    expect('git_sha' in result).toBe(false);
    expect('build_date' in result).toBe(false);
  });
});
