import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../api/mcp/catalog.js';
import { LEGACY_TOOL_MAP, buildRequest, gateVerdict } from '../../api/mcp/dispatch.js';

const entry = (name: string) => {
  const e = CATALOG.find((c) => c.name === name);
  if (e === undefined) throw new Error(`no catalog entry ${name}`);
  return e;
};

describe('gateVerdict (S8 T6 — the WS12 exit criterion)', () => {
  it('reads always pass', () => {
    expect(gateVerdict(entry('arrays.list'), {}, false).allowed).toBe(true);
    expect(gateVerdict(entry('health.check'), { profile: 'deep' }, false).allowed).toBe(true);
  });

  it('plan passes; apply is gated by mcp.allow_apply', () => {
    const shares = entry('shares.create');
    expect(gateVerdict(shares, { mode: 'plan', spec: {} }, false).allowed).toBe(true);
    const denied = gateVerdict(shares, { mode: 'apply', plan_id: 'p' }, false);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('mcp.allow_apply');
    expect(gateVerdict(shares, { mode: 'apply', plan_id: 'p' }, true).allowed).toBe(true);
  });

  it('direct exemptions: support.bundle + tasks.cancel pass without allow_apply', () => {
    expect(gateVerdict(entry('support.bundle'), {}, false).allowed).toBe(true);
    expect(gateVerdict(entry('tasks.cancel'), { id: 't1' }, false).allowed).toBe(true);
  });

  it('every other plan_apply mutator is gated (no silent holes)', () => {
    for (const e of CATALOG.filter((c) => c.mutability === 'plan_apply')) {
      expect(gateVerdict(e, { mode: 'apply' }, false).allowed, `${e.name} must gate apply`).toBe(
        false,
      );
    }
  });
});

describe('buildRequest', () => {
  it('substitutes path params, splits query vs body', () => {
    expect(buildRequest(entry('arrays.get'), { id: 'a 1' })).toEqual({
      path: '/api/v1/arrays/a%201',
    });
    expect(buildRequest(entry('health.check'), { profile: 'standard' })).toEqual({
      path: '/api/v1/health?profile=standard',
    });
    expect(
      buildRequest(entry('shares.update'), { id: 's1', mode: 'plan', spec: { path: '/mnt/a' } }),
    ).toEqual({
      path: '/api/v1/shares/s1',
      body: { mode: 'plan', spec: { path: '/mnt/a' } },
    });
  });

  it('missing path param is an INVALID_ARGUMENT-shaped throw', () => {
    expect(() => buildRequest(entry('arrays.get'), {})).toThrow(/path parameter 'id'/);
  });
});

describe('legacy name map', () => {
  it('points every retired read at its live replacement', () => {
    const names = new Set(CATALOG.map((e) => e.name));
    for (const [legacy, replacement] of Object.entries(LEGACY_TOOL_MAP)) {
      expect(names.has(replacement), `${legacy} -> ${replacement} must exist`).toBe(true);
    }
  });
});
