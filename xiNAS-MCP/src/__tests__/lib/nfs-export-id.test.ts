import { describe, it, expect } from 'vitest';
import { isValidObservedId } from '../../api/internal/observed.js';
import { decExportId, encExportId } from '../../lib/nfs-export-id.js';

describe('encExportId', () => {
  it('strips the leading slash of a canonical absolute path', () => {
    expect(encExportId('/mnt/data')).toBe('mnt/data');
  });

  it('collapses // and drops a trailing slash before stripping', () => {
    expect(encExportId('/mnt//data/')).toBe('mnt/data');
  });

  it('drops a `.` segment', () => {
    expect(encExportId('/a/./b')).toBe('a/b');
  });

  it('encodes a typical share export path', () => {
    expect(encExportId('/srv/share01')).toBe('srv/share01');
  });

  it('throws on a `..` segment', () => {
    expect(() => encExportId('/a/../b')).toThrow(/\.\./);
  });

  it('throws on the bare root `/` (empty id)', () => {
    expect(() => encExportId('/')).toThrow();
  });

  it('throws on the empty string', () => {
    expect(() => encExportId('')).toThrow();
  });
});

describe('decExportId', () => {
  it('prepends a leading slash', () => {
    expect(decExportId('mnt/data')).toBe('/mnt/data');
  });
});

describe('round-trip', () => {
  const canonicalPaths = ['/mnt/data', '/srv/share01', '/export/home/user'];
  for (const p of canonicalPaths) {
    it(`decExportId(encExportId(${p})) === ${p}`, () => {
      expect(decExportId(encExportId(p))).toBe(p);
    });
  }
});

describe('validation invariant: every enc output is a valid observed id', () => {
  // The load-bearing property: encExportId MUST produce an id that
  // isValidObservedId accepts (no leading/trailing `/`, no `//`, no `.`/`..`
  // segment), otherwise the ExportRule upsert is rejected before it reaches KV.
  const paths = [
    '/mnt/data',
    '/mnt//data/',
    '/a/./b',
    '/srv/share01',
    '/export/home/user',
    '/a/b/c/d/e',
  ];
  for (const p of paths) {
    it(`isValidObservedId(encExportId(${p})) === true`, () => {
      expect(isValidObservedId(encExportId(p))).toBe(true);
    });
  }
});
