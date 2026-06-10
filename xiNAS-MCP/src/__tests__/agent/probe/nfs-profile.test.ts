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

  describe('status.running (/proc/fs/nfsd)', () => {
    async function seedNfsdProc(files: Record<string, string>): Promise<void> {
      await mkdir(join(root, 'proc/fs/nfsd'), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(root, 'proc/fs/nfsd', name), content);
      }
    }

    it('nfsd up: parses threads, versions, and portlist into running', async () => {
      await seedNfsdProc({
        threads: '64\n',
        versions: '-2 +3 +4 +4.1 +4.2\n',
        portlist: 'rdma 20049\ntcp 2049\nudp 2049\n',
      });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap.running).toEqual({
        thread_count: 64,
        rdma_listening: true,
        rdma_port: 20049,
        active_versions: ['3', '4.0', '4.1', '4.2'],
      });
    });

    it('no rdma listener: rdma_listening false, rdma_port omitted', async () => {
      await seedNfsdProc({
        threads: '8\n',
        versions: '+3 +4 +4.1 +4.2\n',
        portlist: 'tcp 2049\nudp 2049\n',
      });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap.running).toEqual({
        thread_count: 8,
        rdma_listening: false,
        active_versions: ['3', '4.0', '4.1', '4.2'],
      });
      expect(snap.running).not.toHaveProperty('rdma_port');
    });

    it('threads file absent (nfsd down) → running omitted entirely', async () => {
      // versions/portlist present without threads should still be treated
      // as down — threads is the anchor.
      await seedNfsdProc({ versions: '+3 +4\n', portlist: 'tcp 2049\n' });
      await rm(join(root, 'proc/fs/nfsd/threads'), { force: true });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap).not.toHaveProperty('running');
    });

    it('threads present with junk content → running omitted', async () => {
      await seedNfsdProc({ threads: 'garbage\n' });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap).not.toHaveProperty('running');
    });

    it('threads readable but versions/portlist absent → degraded running', async () => {
      await seedNfsdProc({ threads: '16\n' });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap.running).toEqual({
        thread_count: 16,
        rdma_listening: false,
        active_versions: [],
      });
    });

    it('conf files are still checksummed independently of running', async () => {
      const nfsdConf = '[nfsd]\nthreads=64\n';
      await mkdir(join(root, 'etc/nfs'), { recursive: true });
      await writeFile(join(root, '/etc/nfs/nfsd.conf'), nfsdConf);
      await seedNfsdProc({ threads: '64\n', versions: '+3\n', portlist: 'tcp 2049\n' });
      const snap = await createNfsProfileProbe({ root }).snapshot();
      expect(snap.effective_files['/etc/nfs/nfsd.conf']).toBe(sha256(nfsdConf));
      expect(snap.running?.thread_count).toBe(64);
    });
  });
});
