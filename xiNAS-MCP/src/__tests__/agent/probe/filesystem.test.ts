import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFilesystemProbe } from '../../../agent/probe/filesystem.js';
import { loadObservedSchemas } from '../../../api/observed-schemas.js';

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

// Fake systemctl that answers per verb (args[0]) — so `is-enabled` and
// `is-active` return DIFFERENT strings, which is the whole point of the
// mount_unit_enabled (enablement) vs mount_unit_state (ActiveState) split.
function fakeSystemctl(byVerb: Record<string, string>) {
  return (
    _f: string,
    a: string[],
    _o: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, `${byVerb[a[0] ?? ''] ?? ''}\n`, '');
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

  it('snapshot() sets mount_unit_state to the systemd ActiveState (is-active), NOT the is-enabled value', async () => {
    // The .mount unit is enabled AND active. mount_unit_enabled must reflect
    // enablement (is-enabled → 'enabled'); mount_unit_state must reflect the
    // ActiveState (is-active → 'active') — the schema enum the api enforces.
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeSystemctl({ 'is-enabled': 'enabled', 'is-active': 'active' }) as any,
    });
    const [fs] = await probe.snapshot();
    expect(fs?.status?.mount_unit_state).toBe('active');
    expect(fs?.status?.mount_unit_enabled).toBe(true);
  });

  it('snapshot() reports mount_unit_enabled=false when is-enabled returns disabled', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeSystemctl({ 'is-enabled': 'disabled', 'is-active': 'inactive' }) as any,
    });
    const [fs] = await probe.snapshot();
    expect(fs?.status?.mount_unit_enabled).toBe(false);
    expect(fs?.status?.mount_unit_state).toBe('inactive');
  });

  it('snapshot() omits mount_unit_state when is-active is not a valid ActiveState', async () => {
    // `systemctl is-active` prints 'unknown' for a masked/not-found unit — not
    // in the schema enum. Emitting it would 400 the whole batch at ingest, so
    // the probe omits the field instead (ingest strips `required`).
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeSystemctl({ 'is-enabled': 'static', 'is-active': 'unknown' }) as any,
    });
    const [fs] = await probe.snapshot();
    expect(fs?.status?.mount_unit_state).toBeUndefined();
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

// ---- Regression: probe output must satisfy the control-path Filesystem
//      schema, or the api's /internal/v1/observed ingest 400s the whole batch
//      and the publisher drops it silently — the "No XFS filesystems found"
//      bug where an enabled+active mount never reached the store because the
//      probe put an `is-enabled` value ('enabled') into the ActiveState field.
describe('probe output satisfies the observed Filesystem schema', () => {
  const mountContent = readFileSync(join(fixtureDir, 'srv-share01.mount'), 'utf8');
  const MOUNTINFO_LINE =
    '36 25 0:32 / /srv/share01 rw,noatime shared:5 - xfs /dev/md/xinas-data rw,logdev=/dev/xi_log\n';

  it('an enabled+active managed .mount validates against the Filesystem kind schema', async () => {
    const loaded = loadObservedSchemas();
    // The spec IS present in the repo (tests run from source); a null means the
    // path resolution is broken — surface it as a hard failure.
    if (!loaded) throw new Error('loadObservedSchemas() returned null — api-v1.yaml not found');
    const validate = loaded.schemas.Filesystem;
    if (!validate) throw new Error('Filesystem schema was not compiled from api-v1.yaml');

    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeSystemctl({ 'is-enabled': 'enabled', 'is-active': 'active' }) as any,
      enrich: {
        blkid: async () => ({ fstype: 'xfs', label: 'share01', uuid: 'uuid-1' }),
        statfs: async () => ({ size_bytes: 1000, free_bytes: 900 }),
        readMountinfo: async () => MOUNTINFO_LINE,
      },
    });
    const [fs] = await probe.snapshot();
    // Stamp observed_at as the convergence wrapper does before publishing.
    const observation = { ...fs, status: { ...fs?.status, observed_at: '2026-07-05T00:00:00Z' } };

    const ok = validate(observation);
    expect(ok, `schema errors: ${JSON.stringify((validate as { errors?: unknown }).errors)}`).toBe(
      true,
    );
  });
});
