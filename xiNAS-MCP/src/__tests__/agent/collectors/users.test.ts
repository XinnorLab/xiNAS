import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { UsersCollector } from '../../../agent/collectors/users.js';

function makeFakeUsersProbe(
  options: {
    users?: Array<{ uid: number; name: string; gid: number; home: string; shell: string }>;
    groups?: Array<{ gid: number; name: string; members: string[] }>;
  } = {},
) {
  let _watchCallback: (() => void) | null = null;

  return {
    getentPasswd: vi.fn().mockResolvedValue(
      (
        options.users ?? [
          { uid: 1000, name: 'alice', gid: 1000, home: '/home/alice', shell: '/bin/bash' },
        ]
      ).map((u) => ({
        uid: u.uid,
        name: u.name,
        gid: u.gid,
        gecos: '',
        home: u.home,
        shell: u.shell,
        source: 'local' as const,
      })),
    ),
    getentGroup: vi.fn().mockResolvedValue(
      (options.groups ?? [{ gid: 1000, name: 'alice', members: [] }]).map((g) => ({
        gid: g.gid,
        name: g.name,
        members: g.members,
        source: 'local' as const,
      })),
    ),
    watchPasswdFiles: vi.fn().mockImplementation((cb: () => void) => {
      _watchCallback = cb;
      return { stop: vi.fn() };
    }),
    _fireWatch() {
      _watchCallback?.();
    },
  };
}

describe('UsersCollector', () => {
  it('initialSweep: emits User deltas + Group deltas from one sweep', async () => {
    const probe = makeFakeUsersProbe({
      users: [{ uid: 1000, name: 'alice', gid: 1000, home: '/home/alice', shell: '/bin/bash' }],
      groups: [
        { gid: 1000, name: 'alice', members: [] },
        { gid: 27, name: 'sudo', members: ['alice'] },
      ],
    });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    const userDeltas = deltas.filter((d) => d.kind === 'User');
    const groupDeltas = deltas.filter((d) => d.kind === 'Group');
    expect(userDeltas).toHaveLength(1);
    expect(groupDeltas).toHaveLength(2);
    expect(userDeltas[0]).toMatchObject({ kind: 'User', id: '1000', op: 'upsert' });
    expect((userDeltas[0]?.value?.spec as Record<string, unknown>)?.name).toBe('alice');
    expect(typeof (userDeltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe(
      'string',
    );
    expect(groupDeltas[0]).toMatchObject({ kind: 'Group', op: 'upsert' });
  });

  it('start: inotify /etc/passwd change → re-probe → emit User + Group deltas', async () => {
    const probe = makeFakeUsersProbe({
      users: [{ uid: 1001, name: 'bob', gid: 1001, home: '/home/bob', shell: '/bin/sh' }],
      groups: [{ gid: 1001, name: 'bob', members: [] }],
    });
    const col = new UsersCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatch();
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 500 });
    expect(received.some((d) => d.kind === 'User')).toBe(true);
    expect(received.some((d) => d.kind === 'Group')).toBe(true);
    await col.stop();
  });

  it('User id is the decimal uid string', async () => {
    const probe = makeFakeUsersProbe({
      users: [
        {
          uid: 65534,
          name: 'nobody',
          gid: 65534,
          home: '/nonexistent',
          shell: '/usr/sbin/nologin',
        },
      ],
      groups: [],
    });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas[0]?.id).toBe('65534');
  });

  it('Group id is the decimal gid string', async () => {
    const probe = makeFakeUsersProbe({
      users: [],
      groups: [{ gid: 27, name: 'sudo', members: ['alice'] }],
    });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas[0]?.id).toBe('27');
    expect((deltas[0]?.value?.spec as Record<string, unknown>)?.members).toEqual(['alice']);
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeUsersProbe();
    const col = new UsersCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 300000', () => {
    const probe = makeFakeUsersProbe();
    expect(new UsersCollector({ probe }).pollIntervalMs).toBe(300_000);
  });
});
