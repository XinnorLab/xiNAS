import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../api/config.js';

describe('loadConfig — internal-tokens.json merge', () => {
  it('merges internal-tokens.json into the tokens map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-internal-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: {
            'admin-token-123': { principal: 'admin:bootstrap', role: 'admin' },
          },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
          internalTokensPath: join(dir, 'internal-tokens.json'),
        }),
      );
      writeFileSync(
        join(dir, 'internal-tokens.json'),
        JSON.stringify({
          'agent-token-456': { principal: 'agent:root', role: 'internal_agent' },
        }),
      );
      const config = loadConfig({ configPath: join(dir, 'config.json') });
      expect(config.tokens['admin-token-123']?.role).toBe('admin');
      expect(config.tokens['agent-token-456']?.role).toBe('internal_agent');
      expect(config.tokens['agent-token-456']?.principal).toBe('agent:root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects token-key collisions between config.json and internal-tokens.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-collision-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: { 'shared-token': { principal: 'admin:a', role: 'admin' } },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
          internalTokensPath: join(dir, 'internal-tokens.json'),
        }),
      );
      writeFileSync(
        join(dir, 'internal-tokens.json'),
        JSON.stringify({
          'shared-token': { principal: 'agent:root', role: 'internal_agent' },
        }),
      );
      expect(() => loadConfig({ configPath: join(dir, 'config.json') })).toThrow(/key collision/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works when internal-tokens.json is absent (no internalTokensPath set)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-no-internal-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: { 'admin-token-only': { principal: 'admin:a', role: 'admin' } },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
        }),
      );
      const config = loadConfig({ configPath: join(dir, 'config.json') });
      expect(config.tokens['admin-token-only']?.role).toBe('admin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
