/**
 * S20 F-07 — `mcp.http` transport validation: plain http off loopback is
 * refused unless explicitly allowed; TLS files must exist.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../api/config.js';

function writeConfig(dir: string, mcp: Record<string, unknown>): string {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      controller_id: '00000000-0000-0000-0000-0000000000aa',
      listen: { kind: 'unix', socket: join(dir, 'api.sock') },
      tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
      state: { databasePath: join(dir, 'xinas.db'), auditJsonlPath: join(dir, 'audit.jsonl') },
      mcp,
    }),
  );
  return path;
}

const load = (dir: string, mcp: Record<string, unknown>) =>
  loadConfig({ configPath: writeConfig(dir, mcp) });

describe('mcp.http transport validation (S20 F-07)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('plain http on a loopback host is fine', () => {
    const cfg = load(dir, { http: { host: '127.0.0.1', port: 8080 } });
    expect(cfg.mcp?.http).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('plain http on a routable host is refused without allow_insecure_http', () => {
    expect(() => load(dir, { http: { host: '192.168.64.51', port: 8080 } })).toThrow(
      /plain http on 192.168.64.51 is refused/,
    );
  });

  it('plain http on a routable host is accepted with allow_insecure_http, with a startup warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = load(dir, {
      http: { host: '192.168.64.51', port: 8080, allow_insecure_http: true },
    });
    expect(cfg.mcp?.http?.allow_insecure_http).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bearer tokens travel unencrypted'));
  });

  it('tls needs both files to exist', () => {
    const cert = join(dir, 'api.crt');
    const key = join(dir, 'api.key');
    writeFileSync(cert, 'x');
    const tls = { cert_file: cert, key_file: key };
    expect(() => load(dir, { http: { host: '192.168.64.51', port: 8443, tls } })).toThrow(
      /key_file: .* does not exist/,
    );
    writeFileSync(key, 'y');
    const cfg = load(dir, { http: { host: '192.168.64.51', port: 8443, tls } });
    expect(cfg.mcp?.http?.tls).toEqual(tls);
  });

  it('a bad port is refused', () => {
    expect(() => load(dir, { http: { host: '127.0.0.1', port: 70000 } })).toThrow(/mcp.http.port/);
  });
});
