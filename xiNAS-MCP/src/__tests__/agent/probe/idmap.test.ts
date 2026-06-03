import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createIdmapProbe } from '../../../agent/probe/idmap.js';

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

function fakeReadFile(content: string) {
  return async (_path: string, _enc: string): Promise<string> => content;
}

function fakeExecFile(result: string) {
  return (
    _f: string,
    _a: string[],
    _o: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, result + '\n', '');
  };
}

function fakeExecFileError(stderr: string) {
  return (
    _f: string,
    _a: string[],
    _o: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const e = Object.assign(new Error('systemctl failed'), { stdout: stderr });
    cb(e, stderr, '');
  };
}

describe('IdmapProbe', () => {
  const idmapdConf = readFileSync(join(fixtureDir, 'idmapd.conf'), 'utf8');

  it('snapshot() returns parsed idmapd conf + active status', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: fakeReadFile(idmapdConf) as any,
      execFile: fakeExecFile('active') as any,
    });
    const result = await probe.snapshot();
    expect(result.conf_present).toBe(true);
    expect(result.domain).toBe('xinas.local');
    expect(result.method).toBe('nsswitch');
    expect(result.idmapd_active).toBe(true);
    expect(result.idmapd_unit_state).toBe('active');
  });

  it('snapshot() reports inactive when systemctl says inactive', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: fakeReadFile(idmapdConf) as any,
      execFile: fakeExecFile('inactive') as any,
    });
    const result = await probe.snapshot();
    expect(result.idmapd_active).toBe(false);
  });

  it('snapshot() reports conf_present=false when readFile throws ENOENT', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: async (_p: string, _e: string) => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      execFile: fakeExecFile('inactive') as any,
    });
    const result = await probe.snapshot();
    expect(result.conf_present).toBe(false);
  });
});
