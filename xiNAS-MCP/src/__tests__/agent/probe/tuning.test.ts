import { describe, expect, it } from 'vitest';
import { createTuningProbe } from '../../../agent/probe/tuning.js';

function deps(
  files: Record<string, string>,
  procSys: Record<string, string>,
): Parameters<typeof createTuningProbe>[0] {
  return {
    readdir: async (dir: string) => {
      if (dir !== '/etc/sysctl.d') throw new Error(`unexpected dir ${dir}`);
      return Object.keys(files).sort();
    },
    readFile: async (path: string) => {
      const name = path.split('/').pop() as string;
      if (path.startsWith('/etc/sysctl.d/')) {
        const text = files[name];
        if (text === undefined) throw new Error('ENOENT');
        return text;
      }
      if (path.startsWith('/proc/sys/')) {
        const key = path.slice('/proc/sys/'.length).replaceAll('/', '.');
        const v = procSys[key];
        if (v === undefined) throw new Error('ENOENT');
        return `${v}\n`;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

describe('createTuningProbe', () => {
  it('parses drop-ins (last file wins per key) and reads /proc/sys actuals', async () => {
    const probe = createTuningProbe(
      deps(
        {
          '90-perf-vm.conf': '# comment\nvm.dirty_ratio = 10\nvm.swappiness=1\n',
          '95-override.conf': 'vm.dirty_ratio = 20\n',
        },
        { 'vm.dirty_ratio': '20', 'vm.swappiness': '60' },
      ),
    );
    const snap = await probe.snapshot();
    expect(snap.entries).toEqual([
      { key: 'vm.dirty_ratio', expected: '20', actual: '20' },
      { key: 'vm.swappiness', expected: '1', actual: '60' },
    ]);
  });

  it('no drop-ins → empty entries; unreadable /proc value → actual null', async () => {
    const empty = createTuningProbe(deps({}, {}));
    expect((await empty.snapshot()).entries).toEqual([]);

    const probe = createTuningProbe(
      deps({ '90-x.conf': 'sunrpc.tcp_max_slot_table_entries=128\n' }, {}),
    );
    expect((await probe.snapshot()).entries).toEqual([
      { key: 'sunrpc.tcp_max_slot_table_entries', expected: '128', actual: null },
    ]);
  });

  it('unparsable lines and unreadable files are skipped, never thrown', async () => {
    const probe = createTuningProbe({
      readdir: async () => ['90-a.conf', '91-broken.conf'],
      readFile: async (path: string) => {
        if (path.endsWith('91-broken.conf')) throw new Error('EACCES');
        if (path.endsWith('90-a.conf')) return 'just garbage\nnet.core.somaxconn = 4096\n';
        if (path.startsWith('/proc/sys/')) return '4096\n';
        throw new Error('ENOENT');
      },
    });
    const snap = await probe.snapshot();
    expect(snap.entries).toEqual([{ key: 'net.core.somaxconn', expected: '4096', actual: '4096' }]);
  });
});
