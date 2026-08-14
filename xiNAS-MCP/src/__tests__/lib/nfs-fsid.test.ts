import { describe, expect, it } from 'vitest';
import {
  allocateFsid,
  collectUsedFsids,
  SHARE_FSID_KIND,
  SHARE_FSID_PREFIX,
  shareFsidKey,
} from '../../lib/nfs-fsid.js';

describe('shareFsidKey', () => {
  it('builds a desired-space key under the marker prefix', () => {
    expect(shareFsidKey(4)).toBe('/xinas/v1/desired/ShareFsid/4');
  });

  it('does not collide with the desired Share list prefix', () => {
    // GET /shares lists '/xinas/v1/desired/Share/' — the trailing slash is what
    // keeps 'ShareFsid' out of it. If either constant loses its slash, marker
    // rows start rendering as shares.
    expect(shareFsidKey(4).startsWith('/xinas/v1/desired/Share/')).toBe(false);
    expect(SHARE_FSID_PREFIX).toBe('/xinas/v1/desired/ShareFsid/');
    expect(SHARE_FSID_KIND).toBe('ShareFsid');
  });
});

describe('collectUsedFsids', () => {
  it('maps each integer fsid to its owning share id', () => {
    const used = collectUsedFsids([
      { value: { id: 'mnt/data', spec: { fsid: 0 } } },
      { value: { id: 'mnt/logs', spec: { fsid: 3 } } },
    ]);
    expect([...used.entries()]).toEqual([
      [0, 'mnt/data'],
      [3, 'mnt/logs'],
    ]);
  });

  it('accepts an integer-valued string, matching the provider validator', () => {
    const used = collectUsedFsids([{ value: { id: 'mnt/data', spec: { fsid: '7' } } }]);
    expect(used.has(7)).toBe(true);
  });

  it('ignores rows with a missing, non-integer, or unparseable fsid', () => {
    const used = collectUsedFsids([
      { value: { id: 'a', spec: {} } },
      { value: { id: 'b', spec: { fsid: 1.5 } } },
      { value: { id: 'c', spec: { fsid: 'abc' } } },
      { value: { id: 'd' } },
    ]);
    expect(used.size).toBe(0);
  });
});

describe('allocateFsid', () => {
  it('starts at 1 on an empty store — never 0, which the installer reserves', () => {
    expect(allocateFsid([])).toBe(1);
  });

  it('returns one above the highest in use', () => {
    expect(allocateFsid([0, 1, 2])).toBe(3);
  });

  it('does NOT fill gaps left by deleted shares', () => {
    // {0,1,4} -> 5, not 2. Reusing a departed share's number is out of scope
    // (design §12); this asserts the choice so it cannot regress silently.
    expect(allocateFsid([0, 1, 4])).toBe(5);
  });

  it('accepts the key iterator of collectUsedFsids', () => {
    const used = collectUsedFsids([{ value: { id: 'a', spec: { fsid: 9 } } }]);
    expect(allocateFsid(used.keys())).toBe(10);
  });
});
