import { describe, expect, it } from 'vitest';
import { parseNfsdPortlist, parseNfsdThreads, parseNfsdVersions } from '../../../lib/parse/nfsd.js';

describe('parseNfsdThreads', () => {
  it('parses a plain integer line', () => {
    expect(parseNfsdThreads('64\n')).toBe(64);
  });

  it('parses 0 (nfsd configured down but module loaded)', () => {
    expect(parseNfsdThreads('0\n')).toBe(0);
  });

  it('non-integer / junk → null', () => {
    expect(parseNfsdThreads('lots\n')).toBeNull();
    expect(parseNfsdThreads('6 4\n')).toBeNull();
    expect(parseNfsdThreads('64x\n')).toBeNull();
  });

  it('empty file → null', () => {
    expect(parseNfsdThreads('')).toBeNull();
    expect(parseNfsdThreads('\n')).toBeNull();
  });
});

describe('parseNfsdVersions', () => {
  it('classic Ubuntu 22.04 line: -2 +3 +4 +4.1 +4.2 (bare +4 implies 4.0)', () => {
    expect(parseNfsdVersions('-2 +3 +4 +4.1 +4.2\n')).toEqual(['3', '4.0', '4.1', '4.2']);
  });

  it('v2-less kernel line: +3 +4 +4.1 +4.2', () => {
    expect(parseNfsdVersions('+3 +4 +4.1 +4.2\n')).toEqual(['3', '4.0', '4.1', '4.2']);
  });

  it('explicit -4.0 overrides the bare +4 baseline', () => {
    // Kernel prints -4.0 only when minor 0 is disabled while v4 is available.
    expect(parseNfsdVersions('+3 +4 -4.0 +4.1 +4.2\n')).toEqual(['3', '4.1', '4.2']);
  });

  it('v4 disabled entirely: -4 -4.0 -4.1 -4.2', () => {
    expect(parseNfsdVersions('-2 +3 -4 -4.0 -4.1 -4.2\n')).toEqual(['3']);
  });

  it('v3 disabled, v4-only', () => {
    expect(parseNfsdVersions('-2 -3 +4 +4.1 +4.2\n')).toEqual(['4.0', '4.1', '4.2']);
  });

  it('ignores v2 and unknown junk tokens', () => {
    expect(parseNfsdVersions('+2 +3 garbage +4.1\n')).toEqual(['3', '4.1']);
  });

  it('empty file → empty list', () => {
    expect(parseNfsdVersions('')).toEqual([]);
    expect(parseNfsdVersions('\n')).toEqual([]);
  });
});

describe('parseNfsdPortlist', () => {
  it('tcp + rdma listeners → rdma_listening with the rdma port', () => {
    expect(parseNfsdPortlist('rdma 20049\nrdma6 20049\ntcp 2049\ntcp6 2049\n')).toEqual({
      rdma_listening: true,
      rdma_port: 20049,
    });
  });

  it('tcp/udp only → rdma off, port null', () => {
    expect(parseNfsdPortlist('tcp 2049\nudp 2049\n')).toEqual({
      rdma_listening: false,
      rdma_port: null,
    });
  });

  it('first rdma line wins when several are present', () => {
    expect(parseNfsdPortlist('rdma 20049\nrdma 20050\n')).toEqual({
      rdma_listening: true,
      rdma_port: 20049,
    });
  });

  it('rdma line with an unparsable port → listening true, port null', () => {
    expect(parseNfsdPortlist('rdma what\n')).toEqual({
      rdma_listening: true,
      rdma_port: null,
    });
  });

  it('empty file / junk lines → rdma off', () => {
    expect(parseNfsdPortlist('')).toEqual({ rdma_listening: false, rdma_port: null });
    expect(parseNfsdPortlist('???\n\n')).toEqual({ rdma_listening: false, rdma_port: null });
  });
});
