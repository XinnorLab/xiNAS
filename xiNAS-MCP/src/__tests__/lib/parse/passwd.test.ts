import { describe, it, expect } from 'vitest';
import { parsePasswdLine } from '../../../lib/parse/passwd.js';

describe('parsePasswdLine', () => {
  it('parses a typical passwd line with all seven fields', () => {
    const result = parsePasswdLine(
      'xinas-api:x:999:997:xinas API service:/var/lib/xinas:/usr/sbin/nologin',
    );
    expect(result.name).toBe('xinas-api');
    expect(result.uid).toBe(999);
    expect(result.gid).toBe(997);
    expect(result.gecos).toBe('xinas API service');
    expect(result.home).toBe('/var/lib/xinas');
    expect(result.shell).toBe('/usr/sbin/nologin');
  });

  it('throws a clear error for lines with fewer than 7 colon-separated fields', () => {
    expect(() => parsePasswdLine('root:x:0:0')).toThrow(/7 fields/);
  });

  it('parses a root line with an empty gecos field', () => {
    const result = parsePasswdLine('root:x:0:0::/root:/bin/bash');
    expect(result.name).toBe('root');
    expect(result.uid).toBe(0);
    expect(result.gid).toBe(0);
    expect(result.gecos).toBe('');
    expect(result.home).toBe('/root');
    expect(result.shell).toBe('/bin/bash');
  });

  it('trims trailing CR (CRLF) so the last field is clean', () => {
    const result = parsePasswdLine(
      'xinas-api:x:999:997:xinas API:/var/lib/xinas:/usr/sbin/nologin\r',
    );
    expect(result.shell).toBe('/usr/sbin/nologin');
  });

  it('throws a clear error when uid is non-numeric', () => {
    expect(() => parsePasswdLine('bad:x:NaN:0:gecos:/home/bad:/bin/sh')).toThrow(/non-numeric uid/);
  });

  it('throws a clear error when gid is non-numeric', () => {
    expect(() => parsePasswdLine('bad:x:1000:NaN:gecos:/home/bad:/bin/sh')).toThrow(
      /non-numeric gid/,
    );
  });
});
