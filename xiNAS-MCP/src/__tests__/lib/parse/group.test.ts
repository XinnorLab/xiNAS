import { describe, it, expect } from 'vitest';
import { parseGroupLine } from '../../../lib/parse/group.js';

describe('parseGroupLine', () => {
  it('parses a group line with multiple members', () => {
    const result = parseGroupLine('xinas-admin:x:996:alice,bob,carol');
    expect(result.name).toBe('xinas-admin');
    expect(result.gid).toBe(996);
    expect(result.members).toEqual(['alice', 'bob', 'carol']);
  });

  it('parses a group line with no members', () => {
    const result = parseGroupLine('xinas-api:x:995:');
    expect(result.name).toBe('xinas-api');
    expect(result.gid).toBe(995);
    expect(result.members).toEqual([]);
  });

  it('throws a clear error for lines with fewer than 4 colon-separated fields', () => {
    expect(() => parseGroupLine('root:x:0')).toThrow(/4 fields/);
  });
});
