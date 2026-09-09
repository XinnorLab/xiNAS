import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEALTH_BASELINE_DEFAULTS,
  loadAgentConfig,
  resolveHealthBaselineConfig,
} from '../../agent/config.js';

/** S19c T1 — spec §12.2: the agent's `health_baseline` block and its defaults. */
describe('health_baseline agent config', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-agent-hb-'));
    writeFileSync(join(dir, 'controller-id'), '00000000-0000-0000-0000-0000000000aa\n');
    writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (extra: Record<string, unknown>): string => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        api_socket: '/run/xinas/api.sock',
        agent_socket: '/run/xinas/agent.sock',
        controller_id_path: join(dir, 'controller-id'),
        agent_token_path: join(dir, 'agent-token'),
        socket_group: 'xinas-api',
        ...extra,
      }),
    );
    return path;
  };

  it('defaults to the /opt/xiNAS venv engine when the file has no block', () => {
    const config = loadAgentConfig({ configPath: write({}) });
    expect(config.health_baseline).toEqual(HEALTH_BASELINE_DEFAULTS);
    expect(HEALTH_BASELINE_DEFAULTS).toEqual({
      python: '/opt/xiNAS/venv/bin/python3',
      module_root: '/opt/xiNAS',
      log_dir: '/var/log/xinas/healthcheck',
      profiles_dir: '/opt/xiNAS/healthcheck_profiles',
    });
  });

  it('overrides per key', () => {
    const config = loadAgentConfig({
      configPath: write({
        health_baseline: { python: '/usr/bin/python3', profiles_dir: '/srv/profiles' },
      }),
    });
    expect(config.health_baseline).toEqual({
      python: '/usr/bin/python3',
      module_root: '/opt/xiNAS',
      log_dir: '/var/log/xinas/healthcheck',
      profiles_dir: '/srv/profiles',
    });
  });

  it('an inline config without the block is resolved to the defaults too', () => {
    const config = loadAgentConfig({
      inline: {
        api_socket: '/run/a',
        agent_socket: '/run/b',
        socket_group: 'g',
        controller_id: 'c',
        agent_token: 't',
      },
    });
    expect(config.health_baseline).toEqual(HEALTH_BASELINE_DEFAULTS);
  });

  it.each([
    [{ python: 'relative/python3' }, /health_baseline\.python/],
    [{ module_root: 'opt' }, /health_baseline\.module_root/],
    [{ log_dir: '' }, /health_baseline\.log_dir/],
    [{ profiles_dir: 'profiles' }, /health_baseline\.profiles_dir/],
    [{ nope: '/x' }, /health_baseline: unknown key nope/],
    ['not an object', /health_baseline must be an object/],
  ])('rejects %j', (block, message) => {
    expect(() => resolveHealthBaselineConfig(block)).toThrow(message);
    expect(() => loadAgentConfig({ configPath: write({ health_baseline: block }) })).toThrow(
      message,
    );
  });
});
