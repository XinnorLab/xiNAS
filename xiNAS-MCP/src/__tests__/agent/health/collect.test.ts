import { describe, expect, it } from 'vitest';
import { ProbeCollectionError, classifyNodeError, collect } from '../../../agent/health/collect.js';
import { collectionEvidence, isCollectionFailure } from '../../../lib/health/collection.js';

const clock = () => 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

/** S19a T1 (spec §7.1): every dep call folds into one typed Section. */
describe('collect()', () => {
  it('success carries the value and the clock time', async () => {
    const s = await collect(async () => [1, 2], clock);
    expect(s).toEqual({
      status: 'success',
      observed_at: '2023-11-14T22:13:20.000Z',
      value: [1, 2],
    });
    expect(isCollectionFailure(s.status)).toBe(false);
    expect(collectionEvidence(s)).toEqual({
      status: 'success',
      observed_at: '2023-11-14T22:13:20.000Z',
    });
  });

  it('ENOENT is not_supported/TOOL_ABSENT — the only status that may become skipped', async () => {
    const s = await collect(async () => {
      throw Object.assign(new Error('spawn xicli ENOENT'), { code: 'ENOENT' });
    }, clock);
    expect(s.status).toBe('not_supported');
    expect(s.error).toEqual({ code: 'TOOL_ABSENT', message: 'spawn xicli ENOENT' });
    expect(s.value).toBeUndefined();
    expect(isCollectionFailure(s.status)).toBe(false);
  });

  it('EACCES/EPERM → permission_denied; killed subprocess → timeout; anything else → error', () => {
    expect(classifyNodeError(Object.assign(new Error('x'), { code: 'EACCES' })).status).toBe(
      'permission_denied',
    );
    expect(classifyNodeError(Object.assign(new Error('x'), { code: 'EPERM' }))).toEqual({
      status: 'permission_denied',
      code: 'EPERM',
      message: 'x',
    });
    expect(
      classifyNodeError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })),
    ).toEqual({ status: 'timeout', code: 'TIMEOUT', message: 'x' });
    expect(classifyNodeError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).status).toBe(
      'timeout',
    );
    expect(classifyNodeError(new Error('boom'))).toEqual({
      status: 'error',
      code: 'ERROR',
      message: 'boom',
    });
    expect(classifyNodeError(Object.assign(new Error('parse'), { code: 'EPARSE' }))).toEqual({
      status: 'error',
      code: 'EPARSE',
      message: 'parse',
    });
    expect(classifyNodeError('not an error')).toEqual({
      status: 'error',
      code: 'ERROR',
      message: 'not an error',
    });
  });

  it('a ProbeCollectionError carries its own status and code', async () => {
    const s = await collect(async () => {
      throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', 'socket refused');
    }, clock);
    expect(s).toEqual({
      status: 'error',
      observed_at: '2023-11-14T22:13:20.000Z',
      error: { code: 'HELPER_UNREACHABLE', message: 'socket refused' },
    });
    expect(collectionEvidence(s)).toEqual({
      status: 'error',
      observed_at: '2023-11-14T22:13:20.000Z',
      code: 'HELPER_UNREACHABLE',
      message: 'socket refused',
    });
    expect(isCollectionFailure(s.status)).toBe(true);
  });

  it('a synchronous throw is folded the same way as a rejection', async () => {
    const s = await collect(() => {
      throw new ProbeCollectionError('timeout', 'TIMEOUT', 'slow');
    }, clock);
    expect(s.status).toBe('timeout');
  });
});
