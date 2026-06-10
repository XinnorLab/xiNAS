import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../agent/config.js';

describe('loadAgentConfig', () => {
  it('reads config + agent-token + controller-id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-config-'));
    try {
      writeFileSync(join(dir, 'controller-id'), '00000000-0000-0000-0000-0000000000aa\n');
      writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          api_socket: '/run/xinas/api.sock',
          agent_socket: '/run/xinas/agent.sock',
          controller_id_path: join(dir, 'controller-id'),
          agent_token_path: join(dir, 'agent-token'),
          socket_group: 'xinas-api',
        }),
      );
      const config = loadAgentConfig({ configPath: join(dir, 'config.json') });
      expect(config.api_socket).toBe('/run/xinas/api.sock');
      expect(config.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
      expect(config.agent_token).toBe('agent-token-secret');
      // No nfs_helper_socket in the file → the field is ABSENT (wiring then
      // falls back to the production default /run/xinas-nfs-helper.sock).
      expect(config.nfs_helper_socket).toBeUndefined();
      expect('nfs_helper_socket' in config).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips the optional nfs_helper_socket override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-config-'));
    try {
      writeFileSync(join(dir, 'controller-id'), '00000000-0000-0000-0000-0000000000aa\n');
      writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          api_socket: '/run/xinas/api.sock',
          agent_socket: '/run/xinas/agent.sock',
          controller_id_path: join(dir, 'controller-id'),
          agent_token_path: join(dir, 'agent-token'),
          socket_group: 'xinas-api',
          nfs_helper_socket: '/tmp/test-nfs-helper.sock',
        }),
      );
      const config = loadAgentConfig({ configPath: join(dir, 'config.json') });
      expect(config.nfs_helper_socket).toBe('/tmp/test-nfs-helper.sock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast if controller-id is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-config-'));
    try {
      writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          api_socket: '/run/xinas/api.sock',
          agent_socket: '/run/xinas/agent.sock',
          controller_id_path: join(dir, 'controller-id'),
          agent_token_path: join(dir, 'agent-token'),
          socket_group: 'xinas-api',
        }),
      );
      expect(() => loadAgentConfig({ configPath: join(dir, 'config.json') })).toThrow(
        /controller-id/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
