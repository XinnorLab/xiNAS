import { describe, it, expect } from 'vitest';
import { compileShareToExportEntry, type ShareCompileInput } from '../../lib/nfs-exports.js';

describe('compileShareToExportEntry — Share-level fold order', () => {
  it('appends sync, sec=, no_subtree_check in the fixed order after client opts', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '10.0.0.0/24', options: ['rw'] }],
      sync: 'sync',
      security_mode: 'krb5',
    };
    const out = compileShareToExportEntry(share);
    expect(out.path).toBe('/mnt/data');
    expect(out.clients[0]?.host).toBe('10.0.0.0/24');
    // Exact ordering is load-bearing for plan_hash stability.
    expect(out.clients[0]?.options).toEqual(['rw', 'sync', 'sec=krb5', 'no_subtree_check']);
  });

  it("defaults sync to 'async' when Share-level sync is omitted", () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['ro'] }],
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['ro', 'async', 'no_subtree_check']);
  });
});

describe('compileShareToExportEntry — security_mode', () => {
  it("emits no sec= token when security_mode is 'sys'", () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw'] }],
      sync: 'sync',
      security_mode: 'sys',
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['rw', 'sync', 'no_subtree_check']);
    expect(out.clients[0]?.options.some((o) => o.startsWith('sec='))).toBe(false);
  });

  it('emits no sec= token when security_mode is omitted', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw'] }],
      sync: 'sync',
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options.some((o) => o.startsWith('sec='))).toBe(false);
  });

  it('emits sec= for krb5i / krb5p (any non-sys mode)', () => {
    for (const mode of ['krb5i', 'krb5p'] as const) {
      const out = compileShareToExportEntry({
        path: '/mnt/data',
        clients: [{ pattern: '*', options: ['rw'] }],
        security_mode: mode,
      });
      expect(out.clients[0]?.options).toContain(`sec=${mode}`);
    }
  });

  it('a client-supplied sec= wins — no conflicting second sec= folded in', () => {
    // The token detection is a `sec=` PREFIX match, so a client that already
    // pins a different sec value suppresses the Share-level one (no double sec=).
    const out = compileShareToExportEntry({
      path: '/mnt/data',
      clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sec=krb5i'] }],
      security_mode: 'krb5',
    });
    const opts = out.clients[0]?.options ?? [];
    expect(opts).toContain('sec=krb5i');
    expect(opts).not.toContain('sec=krb5');
    expect(opts.filter((o) => o.startsWith('sec='))).toHaveLength(1);
  });
});

describe('compileShareToExportEntry — client options are authoritative', () => {
  it('keeps a client-specified async and does NOT add sync (client wins, no dup)', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '10.0.0.0/24', options: ['rw', 'async'] }],
      sync: 'sync', // Share-level says sync, but the client already chose async.
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['rw', 'async', 'no_subtree_check']);
    // No sync token was folded in — the client's async wins.
    expect(out.clients[0]?.options).not.toContain('sync');
    // And async appears exactly once.
    expect(out.clients[0]?.options.filter((o) => o === 'async')).toHaveLength(1);
  });

  it('does not duplicate no_subtree_check when the client already carries it', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw', 'no_subtree_check'] }],
      sync: 'sync',
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['rw', 'no_subtree_check', 'sync']);
    expect(out.clients[0]?.options.filter((o) => o === 'no_subtree_check')).toHaveLength(1);
  });

  it('does not add no_subtree_check when the client opted for subtree_check', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw', 'subtree_check'] }],
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['rw', 'subtree_check', 'async']);
    expect(out.clients[0]?.options).not.toContain('no_subtree_check');
  });

  it('preserves an unknown/raw option (nothing is stripped)', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw', 'insecure'] }],
      sync: 'sync',
      security_mode: 'krb5',
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual([
      'rw',
      'insecure',
      'sync',
      'sec=krb5',
      'no_subtree_check',
    ]);
  });

  it('dedupes a duplicated client option preserving first-occurrence order', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [{ pattern: '*', options: ['rw', 'rw', 'root_squash'] }],
    };
    const out = compileShareToExportEntry(share);
    expect(out.clients[0]?.options).toEqual(['rw', 'root_squash', 'async', 'no_subtree_check']);
  });
});

describe('compileShareToExportEntry — multiple clients & determinism', () => {
  it('compiles each client independently, preserving client order', () => {
    const share: ShareCompileInput = {
      path: '/srv/share01',
      clients: [
        { pattern: '10.0.0.0/24', options: ['rw'] },
        { pattern: '10.0.1.0/24', options: ['ro', 'async'] },
      ],
      sync: 'sync',
      security_mode: 'krb5',
    };
    const out = compileShareToExportEntry(share);
    expect(out.path).toBe('/srv/share01');
    expect(out.clients).toHaveLength(2);
    expect(out.clients[0]?.host).toBe('10.0.0.0/24');
    expect(out.clients[0]?.options).toEqual(['rw', 'sync', 'sec=krb5', 'no_subtree_check']);
    expect(out.clients[1]?.host).toBe('10.0.1.0/24');
    // Client 1 already chose async → sync not folded in.
    expect(out.clients[1]?.options).toEqual(['ro', 'async', 'sec=krb5', 'no_subtree_check']);
  });

  it('is deterministic: two calls on the same input deep-equal', () => {
    const share: ShareCompileInput = {
      path: '/mnt/data',
      clients: [
        { pattern: '10.0.0.0/24', options: ['rw'] },
        { pattern: '*', options: ['ro', 'insecure'] },
      ],
      sync: 'sync',
      security_mode: 'krb5p',
    };
    const a = compileShareToExportEntry(share);
    const b = compileShareToExportEntry(share);
    expect(a).toEqual(b);
  });

  it('handles an empty clients list (path preserved, no clients)', () => {
    const out = compileShareToExportEntry({ path: '/mnt/data', clients: [] });
    expect(out).toEqual({ path: '/mnt/data', clients: [] });
  });
});
