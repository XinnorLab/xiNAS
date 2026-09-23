/**
 * S20 F-09 — the placement cycle is opt-in through `placement.enabled`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, resolvePlacementConfig } from '../../agent/config.js';

describe('agent placement config (S20 F-09)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-agent-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to disabled; accepts an explicit boolean; rejects other types', () => {
    expect(resolvePlacementConfig(undefined)).toEqual({ enabled: false });
    expect(resolvePlacementConfig({})).toEqual({ enabled: false });
    expect(resolvePlacementConfig({ enabled: true })).toEqual({ enabled: true });
    expect(() => resolvePlacementConfig({ enabled: 'yes' })).toThrow(
      /placement.enabled must be a boolean/,
    );
  });

  it('loads the block from the config file and from an inline config', () => {
    writeFileSync(join(dir, 'controller-id'), '00000000-0000-0000-0000-0000000000aa\n');
    writeFileSync(join(dir, 'agent-token'), 'tok\n');
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        api_socket: join(dir, 'api.sock'),
        agent_socket: join(dir, 'agent.sock'),
        controller_id_path: join(dir, 'controller-id'),
        agent_token_path: join(dir, 'agent-token'),
        socket_group: 'root',
        placement: { enabled: true },
      }),
    );
    expect(loadAgentConfig({ configPath: path }).placement).toEqual({ enabled: true });
    const inline = loadAgentConfig({
      inline: {
        api_socket: 'a',
        agent_socket: 'b',
        socket_group: 'root',
        controller_id: 'c',
        agent_token: 't',
      },
    });
    expect(inline.placement).toEqual({ enabled: false });
  });
});
