import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createUsersProbe } from '../../../agent/probe/users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');
const passwdFixture = readFileSync(join(fixtureDir, 'getent-passwd.txt'), 'utf8');
const groupFixture = readFileSync(join(fixtureDir, 'getent-group.txt'), 'utf8');

function makeExecFile(passwdOut: string, groupOut: string) {
  return (
    file: string,
    args: string[],
    _opts: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (args[0] === 'passwd') cb(null, passwdOut, '');
    else if (args[0] === 'group') cb(null, groupOut, '');
    else cb(new Error(`unexpected getent db: ${args[0]}`), '', '');
  };
}

describe('UsersProbe', () => {
  it('getentPasswd() returns all parsed users', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const users = await probe.getentPasswd();
    expect(users).toHaveLength(4);
    const alice = users.find((u) => u.name === 'alice');
    expect(alice?.uid).toBe(1001);
    expect(alice?.shell).toBe('/bin/bash');
  });

  it('getentGroup() returns all parsed groups', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const groups = await probe.getentGroup();
    expect(groups).toHaveLength(5);
    const adminGroup = groups.find((g) => g.name === 'xinas-admin');
    expect(adminGroup?.gid).toBe(1000);
    expect(adminGroup?.members).toContain('alice');
  });

  it('snapshot() returns { users, groups } combined', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const { users, groups } = await probe.snapshot();
    expect(users.length).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('snapshot() throws on getent exec failure', async () => {
    const probe = createUsersProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => cb(new Error('getent: not found'), '', ''),
    });
    await expect(probe.snapshot()).rejects.toThrow(/getent/);
  });
});
