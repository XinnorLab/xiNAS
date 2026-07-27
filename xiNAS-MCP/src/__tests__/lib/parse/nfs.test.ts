import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseListExports, parseListSessions } from '../../../lib/parse/nfs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDir = join(__dirname, '__fixtures__');

describe('parseListExports', () => {
  it('parses list_exports helper response into ObservedExportRule[]', () => {
    const raw = readFileSync(join(fixtureDir, 'nfs-helper-list-exports.json'), 'utf8');
    const rules = parseListExports(raw);
    expect(rules).toHaveLength(3); // 2 clients for share01 + 1 for share02

    const cidr = rules.find(
      (r) => r.host_pattern === '10.0.0.0/24' && r.export_path === '/srv/share01',
    );
    expect(cidr).toBeDefined();
    expect(cidr?.squash_mode).toBe('root_squash');
    expect(cidr?.anon_uid).toBe(65534);
    expect(cidr?.anon_gid).toBe(65534);

    const noSquash = rules.find(
      (r) => r.host_pattern === '10.0.1.5' && r.export_path === '/srv/share01',
    );
    expect(noSquash?.squash_mode).toBe('no_root_squash');
    expect(noSquash?.anon_uid).toBeUndefined();

    const allSquash = rules.find((r) => r.export_path === '/srv/share02');
    expect(allSquash?.squash_mode).toBe('all_squash');
    expect(allSquash?.anon_uid).toBe(1000);
    expect(allSquash?.anon_gid).toBe(1000);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseListExports('not json')).toThrow(/JSON/);
  });

  it('returns empty array when the helper result is absent or empty', () => {
    expect(parseListExports(JSON.stringify({ ok: true, result: [], request_id: 'x' }))).toEqual([]);
    expect(parseListExports(JSON.stringify({ ok: true, request_id: 'x' }))).toEqual([]);
  });

  it('throws on an ok:false helper error instead of returning empty', () => {
    // Returning [] here would let the collector reconcile-DELETE every observed
    // export on a transient helper failure — the error must propagate.
    const raw = JSON.stringify({ ok: false, error: 'boom', code: 'INTERNAL', request_id: 'x' });
    expect(() => parseListExports(raw)).toThrow(/boom/);
  });
});

describe('parseListSessions', () => {
  it('parses list_sessions helper response into ObservedNfsSession[]', () => {
    const raw = readFileSync(join(fixtureDir, 'nfs-helper-list-sessions.json'), 'utf8');
    const sessions = parseListSessions(raw);
    expect(sessions).toHaveLength(3);

    // The helper maps client_ip → client_addr, nfs_version → proto_version,
    // active_locks → locked_files, and does not resolve a hostname.
    const s1 = sessions.find((s) => s.spec.client_addr === '10.0.0.10');
    expect(s1).toBeDefined();
    expect(s1?.spec.client_hostname).toBeUndefined();
    expect(s1?.spec.export_path).toBe('/srv/share01');
    expect(s1?.status.proto_version).toBe('v4.1');
    expect(s1?.status.locked_files).toBe(3);
    expect(s1?.id).toBe('10.0.0.10:/srv/share01');

    const s3 = sessions.find((s) => s.spec.client_addr === '10.0.0.12');
    expect(s3?.status.locked_files).toBe(12);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseListSessions('not json')).toThrow(/JSON/);
  });

  it('returns empty array when the helper result is absent or empty', () => {
    expect(parseListSessions(JSON.stringify({ ok: true, result: [], request_id: 'x' }))).toEqual(
      [],
    );
    expect(parseListSessions(JSON.stringify({ ok: true, request_id: 'x' }))).toEqual([]);
  });

  it('throws on an ok:false helper error instead of returning empty', () => {
    const raw = JSON.stringify({ ok: false, error: 'boom', request_id: 'x' });
    expect(() => parseListSessions(raw)).toThrow(/boom/);
  });
});
