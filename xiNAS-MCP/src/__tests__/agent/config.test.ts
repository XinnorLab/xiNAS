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
