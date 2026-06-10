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

// ---- S5 T6: enrichment (blkid + statfs + mountinfo cross-ref) ----

describe('snapshot enrichment', () => {
  const mountContent = readFileSync(join(fixtureDir, 'srv-share01.mount'), 'utf8');
  const MOUNTINFO_LINE =
    '36 25 0:32 / /srv/share01 rw,noatime shared:5 - xfs /dev/md/xinas-data rw,logdev=/dev/xi_log\n';

  function enrichedProbe(over: Partial<Parameters<typeof createFilesystemProbe>[0]> = {}) {
    return createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('enabled') as any,
      enrich: {
        blkid: async () => ({ fstype: 'xfs', label: 'share01', uuid: 'uuid-1' }),
        statfs: async () => ({ size_bytes: 1000, free_bytes: 900 }),
        readMountinfo: async () => MOUNTINFO_LINE,
      },
      ...over,
    });
  }

  it('mounted via mountinfo + uuid/label via blkid + sizes via statfs', async () => {
    const [fs] = await enrichedProbe().snapshot();
    expect(fs?.status.mounted).toBe(true);
    expect(fs?.status.effective_mount_options).toEqual(['rw', 'noatime']);
    expect(fs?.status.uuid).toBe('uuid-1');
    expect(fs?.status.label).toBe('share01');
    expect(fs?.status.size_bytes).toBe(1000);
    expect(fs?.status.free_bytes).toBe(900);
  });

  it('not in mountinfo → mounted false, no statfs call', async () => {
    const [fs] = await enrichedProbe({
      enrich: {
        blkid: async () => null,
        statfs: async () => {
          throw new Error('must not be called');
        },
        readMountinfo: async () => '',
      },
    }).snapshot();
    expect(fs?.status.mounted).toBe(false);
    expect(fs?.status.uuid).toBeUndefined();
    expect(fs?.status.size_bytes).toBeUndefined();
  });

  it('individual enrichment failures degrade the field, not the row', async () => {
    const [fs] = await enrichedProbe({
      enrich: {
        blkid: async () => {
          throw new Error('blkid exploded');
        },
        statfs: async () => {
          throw new Error('statfs exploded');
        },
        readMountinfo: async () => MOUNTINFO_LINE,
      },
    }).snapshot();
    expect(fs?.status.mounted).toBe(true); // mountinfo still worked
    expect(fs?.status.uuid).toBeUndefined();
    expect(fs?.status.size_bytes).toBeUndefined();
    expect(fs?.status.mountpoint).toBe('/srv/share01'); // row intact
  });
});
