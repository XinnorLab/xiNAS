// @vitest-environment node
/**
 * Unit tests for the xinas-mcp-stdio adapter's connection-error mapping
 * (finding N4). The adapter turns a raw socket errno into an actionable
 * JSON-RPC error so a non-root operator who isn't in xinas-admin gets a
 * fix, not a bare `connect EACCES`.
 *
 * Importing the adapter module is safe: its read loop is guarded behind
 * an isMain check, so nothing is spawned and the process isn't exited.
 */
import { describe, expect, it } from 'vitest';
import { connectErrorHint, unreachableMessage } from '../mcp-stdio.js';

function errno(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('connectErrorHint', () => {
  it('points EACCES at xinas-admin group membership', () => {
    const hint = connectErrorHint(errno('EACCES', 'connect EACCES /run/xinas/api.sock'));
    expect(hint).toBeDefined();
    expect(hint).toMatch(/xinas-admin/);
    expect(hint).toMatch(/usermod -aG xinas-admin/);
  });

  it('points ENOENT at an absent/stopped service', () => {
    const hint = connectErrorHint(errno('ENOENT', 'connect ENOENT /run/xinas/api.sock'));
    expect(hint).toMatch(/systemctl status xinas-api/);
  });

  it('points ECONNREFUSED at a stopped service', () => {
    const hint = connectErrorHint(
      errno('ECONNREFUSED', 'connect ECONNREFUSED /run/xinas/api.sock'),
    );
    expect(hint).toMatch(/systemctl status xinas-api/);
  });

  it('returns undefined for codes without specific guidance', () => {
    expect(connectErrorHint(errno('ETIMEDOUT', 'connect ETIMEDOUT'))).toBeUndefined();
    expect(connectErrorHint(new Error('boom'))).toBeUndefined();
    expect(connectErrorHint('not-an-error')).toBeUndefined();
    expect(connectErrorHint(undefined)).toBeUndefined();
  });
});

describe('unreachableMessage', () => {
  it('keeps the socket path and raw errno, then appends the EACCES hint', () => {
    const msg = unreachableMessage(
      '/run/xinas/api.sock',
      errno('EACCES', 'connect EACCES /run/xinas/api.sock'),
    );
    expect(msg).toContain('xinas-api unreachable at /run/xinas/api.sock');
    expect(msg).toContain('connect EACCES /run/xinas/api.sock');
    expect(msg).toContain('xinas-admin');
    expect(msg).toContain(' — '); // hint is appended after an em dash
  });

  it('returns the base message unchanged when there is no specific hint', () => {
    const msg = unreachableMessage('/run/xinas/api.sock', errno('ETIMEDOUT', 'connect ETIMEDOUT'));
    expect(msg).toBe('xinas-api unreachable at /run/xinas/api.sock: connect ETIMEDOUT');
  });

  it('handles non-Error throwables via String()', () => {
    expect(unreachableMessage('/sock', 'weird')).toBe('xinas-api unreachable at /sock: weird');
  });
});
