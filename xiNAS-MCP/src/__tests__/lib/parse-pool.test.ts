import { describe, expect, it } from 'vitest';
import { parsePoolShow } from '../../lib/parse/pool.js';

describe('parsePoolShow (S9 T7)', () => {
  it('array shape: {name, drives, active}', () => {
    expect(
      parsePoolShow([
        { name: 'spare1', drives: ['/dev/a', '/dev/b'], active: true },
        { junk: true },
      ]),
    ).toEqual([{ name: 'spare1', drives: ['/dev/a', '/dev/b'], active: true }]);
  });

  it('dict shape: keyed by name, devices + state vocab, paired devices', () => {
    expect(
      parsePoolShow({
        spare2: { devices: [[0, '/dev/c'], '/dev/d'], state: 'Active' },
        spare3: { devices: [], state: 'inactive' },
      }),
    ).toEqual([
      { name: 'spare2', drives: ['/dev/c', '/dev/d'], active: true },
      { name: 'spare3', drives: [], active: false },
    ]);
  });

  it('garbage → []', () => {
    expect(parsePoolShow(null)).toEqual([]);
    expect(parsePoolShow('nope')).toEqual([]);
  });
});
