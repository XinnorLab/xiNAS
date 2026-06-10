import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFilesystemProbe } from '../../../agent/probe/filesystem.js';

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

// Fake readdir that lists one .mount file
function fakeReaddir(_unitContent: string) {
  return async (_path: string) =>
    ['srv-share01.mount'] as unknown as Awaited<
      ReturnType<typeof import('node:fs/promises').readdir>
    >;
}

// Fake readFile
function fakeReadFile(unitContent: string) {
  return async (_path: string, _enc: string): Promise<string> => unitContent;
}

// Fake execFile that returns 'enabled' for is-enabled
function fakeExecFile(result: string) {
  return (
    _f: string,
    _a: string[],
    _o: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, result + '\n', '');
  };
}

describe('FilesystemProbe', () => {
  const mountContent = readFileSync(join(fixtureDir, 'srv-share01.mount'), 'utf8');

  it('snapshot() returns a filesystem object for each .mount unit', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('enabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses).toHaveLength(1);
    expect(fses[0]?.id).toBe('srv-share01.mount');
    // S5 T1: status-only rows (ADR-0007 §Observation normalization)
    expect(fses[0]?.status?.mountpoint).toBe('/srv/share01');
    expect(fses[0]?.status?.fs_type).toBe('xfs');
    expect(fses[0]?.status?.mount_unit_name).toBe('srv-share01.mount');
  });

  it('snapshot() marks unit as disabled when is-enabled returns disabled', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('disabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses[0]?.status?.mount_unit_state).toBe('disabled');
  });

  it('snapshot() ignores non-.mount files', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: async (_p: string) => ['nfs-server.service', 'xinas-api.service'] as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('enabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses).toHaveLength(0);
  });
});
