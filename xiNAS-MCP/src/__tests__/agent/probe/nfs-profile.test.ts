import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NFS_PROFILE_EFFECTIVE_FILES,
  createNfsProfileProbe,
} from '../../../agent/probe/nfs-profile.js';

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
}

describe('nfs-profile probe', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nfs-profile-probe-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('exposes exactly the four ADR-0005 file paths', () => {
    expect([...NFS_PROFILE_EFFECTIVE_FILES]).toEqual([
      '/etc/nfs/nfsd.conf',
      '/etc/default/nfs-kernel-server',
      '/etc/modprobe.d/lockd.conf',
      '/etc/default/nfs-common',
    ]);
  });

  it('checksums only the present files, sha256-prefixed', async () => {
    const nfsdConf = '[nfsd]\nthreads=64\nrdma=on\n';
    const nfsCommon = 'STATDOPTS=\n';
    await mkdir(join(root, dirname('/etc/nfs/nfsd.conf')), { recursive: true });
    await writeFile(join(root, '/etc/nfs/nfsd.conf'), nfsdConf);
    await mkdir(join(root, dirname('/etc/default/nfs-common')), { recursive: true });
    await writeFile(join(root, '/etc/default/nfs-common'), nfsCommon);

    const probe = createNfsProfileProbe({ root });
    const snap = await probe.snapshot();

    expect(Object.keys(snap.effective_files).sort()).toEqual([
      '/etc/default/nfs-common',
      '/etc/nfs/nfsd.conf',
    ]);
    expect(snap.effective_files['/etc/nfs/nfsd.conf']).toBe(sha256(nfsdConf));
    expect(snap.effective_files['/etc/default/nfs-common']).toBe(sha256(nfsCommon));
    for (const v of Object.values(snap.effective_files)) {
      expect(v).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('empty root → empty effective_files', async () => {
    const probe = createNfsProfileProbe({ root });
    const snap = await probe.snapshot();
    expect(snap.effective_files).toEqual({});
  });
});
