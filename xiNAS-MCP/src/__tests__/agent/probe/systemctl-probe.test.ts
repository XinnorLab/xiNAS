import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWLIST, createSystemctlProbe } from '../../../agent/probe/systemd.js';

function fakeExecFile(outputs: Record<string, string>) {
  const calls: string[] = [];
  const ef = (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const unit = args[args.length - 1] as string;
    calls.push(args.join(' '));
    const out = outputs[unit];
    if (out === undefined) {
      cb(Object.assign(new Error('exit 4'), { code: 4 }), '', 'No such unit');
      return;
    }
    cb(null, out, '');
  };
  return { calls, ef };
}

describe('createSystemctlProbe (S7 T1b promotion)', () => {
  it('parses systemctl show k=v into UnitState with exact argv', async () => {
    const { calls, ef } = fakeExecFile({
      'nfs-server.service':
        'ActiveState=active\nSubState=exited\nUnitFileState=enabled\nLoadState=loaded\n',
    });
    const probe = createSystemctlProbe({ execFile: ef as never });
    const state = await probe.getUnitState('nfs-server.service');
    expect(state).toEqual({
      load_state: 'loaded',
      active_state: 'active',
      sub_state: 'exited',
      unit_file_state: 'enabled',
    });
    expect(calls[0]).toBe(
      'show -p LoadState,ActiveState,SubState,UnitFileState nfs-server.service',
    );
  });

  it('absent unit degrades to unknown states, never throws', async () => {
    const { ef } = fakeExecFile({});
    const probe = createSystemctlProbe({ execFile: ef as never });
    const state = await probe.getUnitState('ghost.service');
    expect(state.active_state).toBe('unknown');
    expect(state.load_state).toBe('not-found');
  });

  it('allow-list includes the xinas units; subscription is a no-op handle', () => {
    const probe = createSystemctlProbe({ execFile: fakeExecFile({}).ef as never });
    expect(probe.allowList).toContain('xinas-api.service');
    expect(probe.allowList).toContain('xinas-agent.service');
    expect(probe.allowList).toEqual(expect.arrayContaining(DEFAULT_ALLOWLIST));
    const handle = probe.subscribeAllowListed([], () => {});
    expect(() => handle.stop()).not.toThrow();
  });
});
