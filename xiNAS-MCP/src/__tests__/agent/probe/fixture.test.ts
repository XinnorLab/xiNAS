import { describe, expect, it } from 'vitest';

// ---- S5 T6: nfs fixture passthrough (the e2e blocker seeds) ----

describe('createFixtureNfsProbe(dir)', () => {
  it('reads nfs-sessions.json + nfs-exports.json; defaults empty', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xinas-fixture-nfs-'));
    try {
      const { createFixtureNfsProbe } = await import('../../../agent/probe/fixture.js');
      const empty = createFixtureNfsProbe(dir);
      expect(await empty.listSessions()).toEqual([]);
      expect(await empty.listExports()).toEqual([]);

      writeFileSync(
        join(dir, 'nfs-sessions.json'),
        JSON.stringify([
          {
            kind: 'NfsSession',
            id: '10.0.0.1:/mnt/data/share',
            spec: { client_addr: '10.0.0.1', export_path: '/mnt/data/share' },
            status: { proto_version: 'v4.2', locked_files: 0 },
          },
        ]),
      );
      writeFileSync(
        join(dir, 'nfs-exports.json'),
        JSON.stringify([
          { export_path: '/mnt/data/share', host_pattern: '*', options: ['rw'] },
        ]),
      );
      const seeded = createFixtureNfsProbe(dir);
      expect((await seeded.listSessions())[0]?.spec.export_path).toBe('/mnt/data/share');
      expect((await seeded.listExports())[0]?.export_path).toBe('/mnt/data/share');
      // no-dir form stays empty (non-fixture callers unaffected)
      const bare = createFixtureNfsProbe();
      expect(await bare.listSessions()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
