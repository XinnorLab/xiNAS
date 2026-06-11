import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../api/config.js';

/** Write a minimal valid config.json, optionally with a `tasks` section. */
function writeConfig(dir: string, tasks?: unknown): string {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      controller_id: '00000000-0000-0000-0000-0000000000aa',
      listen: { kind: 'unix', socket: '/tmp/x.sock' },
      tokens: { 'admin-token-123': { principal: 'admin:bootstrap', role: 'admin' } },
      state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
      ...(tasks !== undefined ? { tasks } : {}),
    }),
  );
  return path;
}

describe('loadConfig — tasks.max_inflight (s2-task-envelope-spec §5.3)', () => {
  it('loads fine with no tasks section (engine default 4 applies downstream)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-tasks-'));
    try {
      const config = loadConfig({ configPath: writeConfig(dir) });
      expect(config.tasks).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors an explicit integer >= 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-tasks-'));
    try {
      const config = loadConfig({ configPath: writeConfig(dir, { max_inflight: 8 }) });
      expect(config.tasks?.max_inflight).toBe(8);
      // max_inflight: 1 is the smallest legal cap.
      const one = loadConfig({ configPath: writeConfig(dir, { max_inflight: 1 }) });
      expect(one.tasks?.max_inflight).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, '4'])('rejects max_inflight = %j at load', (bad) => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-tasks-bad-'));
    try {
      expect(() => loadConfig({ configPath: writeConfig(dir, { max_inflight: bad }) })).toThrow(
        /max_inflight/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a bad max_inflight in an inline config too', () => {
    expect(() =>
      loadConfig({
        inline: {
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: {},
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
          tasks: { max_inflight: 0 },
        },
      }),
    ).toThrow(/max_inflight/);
  });
});
