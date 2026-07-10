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

  // Captured verbatim from `xicli pool show -f json` on xiRAID 4.3.x. `state`
  // is a LIST; a string-only reader observed this ACTIVE pool as inactive.
  it('real daemon payload: state is a list of words', () => {
    expect(
      parsePoolShow({
        e: { devices: [], name: 'e', serials: [], sizes: [], state: ['active'] },
      }),
    ).toEqual([{ name: 'e', drives: [], active: true }]);

    expect(
      parsePoolShow({
        e: { devices: [], name: 'e', serials: [], sizes: [], state: ['inactive'] },
      }),
    ).toEqual([{ name: 'e', drives: [], active: false }]);
  });

  // Captured verbatim from `xicli pool show -f json` on xiRAID 4.3.x, pool with
  // members. `devices` are [idx, path, [state]] TRIPLES: a reader that takes the
  // tuple's LAST element gets `["ready"]`, drops every drive, and reports the
  // pool as empty — so the TUI drive picker offers drives the pool already owns.
  it('real daemon payload: populated pool, [idx, path, [state]] device triples', () => {
    expect(
      parsePoolShow({
        e: {
          devices: [
            [0, '/dev/nvme10n1', ['ready']],
            [1, '/dev/nvme10n2', ['ready']],
          ],
          name: 'e',
          serials: ['6030A00MTMYR_1', '6030A00MTMYR_2'],
          sizes: ['0 GiB', '3575 GiB'],
          state: ['active'],
        },
      }),
    ).toEqual([{ name: 'e', drives: ['/dev/nvme10n1', '/dev/nvme10n2'], active: true }]);
  });

  it('device tuples: the path is found, not the trailing element', () => {
    expect(
      parsePoolShow({
        spare4: {
          devices: [
            [0, '/dev/c', ['online']],
            [1, '/dev/d', 'SERIAL123'],
          ],
          state: [],
        },
      }),
    ).toEqual([{ name: 'spare4', drives: ['/dev/c', '/dev/d'], active: false }]);
  });

  it('garbage → []', () => {
    expect(parsePoolShow(null)).toEqual([]);
    expect(parsePoolShow('nope')).toEqual([]);
  });
});
