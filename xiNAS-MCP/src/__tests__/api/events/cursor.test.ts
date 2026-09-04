import { describe, expect, it } from 'vitest';
import { CursorError, decodeCursor, encodeCursor } from '../../../api/events/cursor.js';

const scope = { controllerId: '00000000-0000-0000-0000-0000000000aa', feed: 'raid' as const, last: 50 };

/** A cursor whose sequence field was edited after the tag was computed. */
function tamperedSequence(): string {
  const good = encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 1 });
  const text = Buffer.from(good, 'base64url').toString('utf8');
  // The sequence is the fourth field; bump it without recomputing the tag.
  const fields = text.split('\x1f');
  fields[3] = '2';
  return Buffer.from(fields.join('\x1f'), 'utf8').toString('base64url');
}

describe('feed cursor codec (S17 §7.4)', () => {
  it('round-trips and is base64url-safe', () => {
    const c = encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 42 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, scope)).toEqual({ sequence: 42 });
  });

  it('accepts sequence 0 and sequence == last', () => {
    expect(decodeCursor(encodeCursor({ ...scope, sequence: 0 }), scope)).toEqual({ sequence: 0 });
    expect(decodeCursor(encodeCursor({ ...scope, sequence: 50 }), scope)).toEqual({
      sequence: 50,
    });
  });

  it.each([
    ['another controller', encodeCursor({ controllerId: 'x', feed: 'raid', sequence: 1 })],
    ['another feed', encodeCursor({ controllerId: scope.controllerId, feed: 'nfs', sequence: 1 })],
    [
      'a sequence beyond the last allocated one',
      encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 51 }),
    ],
    [
      'a tampered tag',
      `${encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 1 }).slice(0, -2)}AA`,
    ],
    ['a tampered sequence with the original tag', tamperedSequence()],
    ['garbage', 'not*base64'],
    ['an empty string', ''],
    ['an over-long string', 'A'.repeat(300)],
  ])('rejects %s with the fixed message', (_label, cursor) => {
    expect(() => decodeCursor(cursor, scope)).toThrow(CursorError);
    expect(() => decodeCursor(cursor, scope)).toThrow('invalid cursor');
  });

  it('never exposes the scope in the error', () => {
    try {
      decodeCursor('AAAA', scope);
    } catch (err) {
      expect(String(err)).not.toContain(scope.controllerId);
    }
  });
});
