import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiConfig, loadConfig } from '../../api/config.js';

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

  it("rejects a token principal starting with 'local:' — reserved for socket-peer identities (S15 Task 11 fix1, F6)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-local-reserved-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: { 'bad-token': { principal: 'local:uds', role: 'admin' } },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
        }),
      );
      expect(() => loadConfig({ configPath: join(dir, 'config.json') })).toThrow(/local:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a 'local:'-prefixed principal merged in from internal-tokens.json too", () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-local-reserved-merge-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: { 'admin-token-123': { principal: 'admin:bootstrap', role: 'admin' } },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
          internalTokensPath: join(dir, 'internal-tokens.json'),
        }),
      );
      writeFileSync(
        join(dir, 'internal-tokens.json'),
        JSON.stringify({
          'agent-token-456': { principal: 'local:sneaky', role: 'internal_agent' },
        }),
      );
      expect(() => loadConfig({ configPath: join(dir, 'config.json') })).toThrow(/local:/);
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

/**
 * A1 (S15 §3.5, §13) — `tokens[<token>].surface` scopes a bearer to one
 * endpoint family. Omitted means `any`, which is what every token minted
 * before this key existed keeps meaning.
 */
describe('loadConfig — tokens[].surface (S15 §3.5, final review C1)', () => {
  function write(dir: string, surface: unknown): string {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000aa',
        listen: { kind: 'unix', socket: '/tmp/x.sock' },
        tokens: {
          'tok-a': {
            principal: 'admin:a',
            role: 'admin',
            ...(surface === undefined ? {} : { surface }),
          },
        },
        state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
      }),
    );
    return path;
  }

  it.each(['mcp', 'rest', 'any'] as const)("accepts surface: '%s'", (surface) => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-surface-ok-'));
    try {
      const config = loadConfig({ configPath: write(dir, surface) });
      expect(config.tokens['tok-a']?.surface).toBe(surface);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an omitted surface stays undefined and is treated as any by the consumers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-surface-absent-'));
    try {
      const config = loadConfig({ configPath: write(dir, undefined) });
      expect(config.tokens['tok-a']).toBeDefined();
      expect(config.tokens['tok-a']?.surface).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['cli', '', 'MCP', 1, null])('rejects surface: %o', (surface) => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-surface-bad-'));
    try {
      expect(() => loadConfig({ configPath: write(dir, surface) })).toThrow(/surface/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid surface merged in from internal-tokens.json too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-surface-merge-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'unix', socket: '/tmp/x.sock' },
          tokens: { 'admin-token-123': { principal: 'admin:bootstrap', role: 'admin' } },
          state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
          internalTokensPath: join(dir, 'internal-tokens.json'),
        }),
      );
      writeFileSync(
        join(dir, 'internal-tokens.json'),
        JSON.stringify({
          'agent-token-456': { principal: 'agent:root', role: 'internal_agent', surface: 'cli' },
        }),
      );
      expect(() => loadConfig({ configPath: join(dir, 'config.json') })).toThrow(/surface/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * C1 (S15 closing round, §3.5/§13) — `mcp.allow_apply: true` plus any
 * unscoped (non-`mcp`-surface) non-agent token is a REST-bypass hazard:
 * the same bearer applies over `/api/v1` without ever touching the S15
 * confirmation gate. `validateTokensSection` warns at startup naming the
 * bypassable principals, and refuses to let an `internal_agent` token be
 * scoped to `mcp` at all — that role is refused on the mcp surface, so
 * scoping it there would leave the token usable on neither surface.
 */
describe('loadConfig — unscoped-token startup warning (S15 closing round, C1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function inline(tokens: Record<string, unknown>, allowApply?: boolean): ApiConfig {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {
      controller_id: '00000000-0000-0000-0000-0000000000aa',
      listen: { kind: 'unix', socket: '/tmp/x.sock' },
      tokens,
      state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
    };
    if (allowApply !== undefined) {
      result.mcp = { allow_apply: allowApply };
    }
    return result as ApiConfig;
  }

  it('allow_apply=true with one unscoped admin token warns exactly once, naming it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      inline: inline({ 'admin-token': { principal: 'admin:demo', role: 'admin' } }, true),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('admin:demo');
  });

  it("surface: 'mcp' on the same token silences the warning", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      inline: inline(
        { 'admin-token': { principal: 'admin:demo', role: 'admin', surface: 'mcp' } },
        true,
      ),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('mcp.allow_apply absent never warns, even with an unscoped token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      inline: inline({ 'admin-token': { principal: 'admin:demo', role: 'admin' } }),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an internal_agent token never counts as unscoped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      inline: inline({ 'agent-token': { principal: 'agent:root', role: 'internal_agent' } }, true),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('internal_agent scoped to surface: mcp is rejected at load — that role is refused on the mcp surface', () => {
    expect(() =>
      loadConfig({
        inline: inline(
          { 'agent-token': { principal: 'agent:root', role: 'internal_agent', surface: 'mcp' } },
          true,
        ),
      }),
    ).toThrow(/internal_agent/);
  });
});
