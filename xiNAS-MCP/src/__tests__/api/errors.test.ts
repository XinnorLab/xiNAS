import { describe, it, expect } from 'vitest';
import { makeError, errorStatus } from '../../api/errors.js';

describe('errors', () => {
  it('makeError shapes the ApiError type', () => {
    const err = makeError('INVALID_ARGUMENT', 'bad input', { field: 'spec.versions' });
    expect(err).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'bad input',
      details: { field: 'spec.versions' },
    });
  });

  it('errorStatus maps every code to the right HTTP status', () => {
    expect(errorStatus('INVALID_ARGUMENT')).toBe(400);
    expect(errorStatus('NOT_FOUND')).toBe(404);
    expect(errorStatus('PERMISSION_DENIED')).toBe(401); // Phase 0 simplification — see errors.ts comment
    expect(errorStatus('CONFLICT')).toBe(409);
    expect(errorStatus('PRECONDITION_FAILED')).toBe(412);
    expect(errorStatus('UNSUPPORTED')).toBe(422);
    expect(errorStatus('TIMEOUT')).toBe(504);
    expect(errorStatus('INTERNAL')).toBe(500);
  });

  it('makeError accepts a remediation hint', () => {
    const err = makeError(
      'INTERNAL',
      'audit write failed',
      undefined,
      'check disk space on /var/log',
    );
    expect(err.remediation).toBe('check disk space on /var/log');
  });
});
