import { describe, expect, it, vi } from 'vitest';
import { CATALOG, mcpVisible } from '../../api/mcp/catalog.js';
import { McpProtocolError } from '../../api/mcp/confirmation/errors.js';
import {
  type DispatcherOptions,
  LEGACY_TOOL_MAP,
  buildRequest,
  gateVerdict,
  listTools,
  nextHint,
} from '../../api/mcp/dispatch.js';
import { buildCapabilities } from '../../api/mcp/discover.js';
import { handleModernRequest } from '../../api/mcp/modern.js';

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

describe('nextHint (2026-08-16 progress design §5)', () => {
  const running = { task_id: 'task-42', state: 'running', kind: 'fs.create' };

  it('points a running task at tasks.wait', () => {
    expect(nextHint(entry('filesystems.create'), running)).toEqual({
      tool: 'tasks.wait',
      args: { id: 'task-42', timeout_s: 25 },
      note: expect.stringContaining('until state is terminal'),
    });
  });

  it('covers support.bundle — a DIRECT tool that returns a Task envelope', () => {
    // Keying the hint off mutability would leave exactly this call handing a
    // client a task_id with no way to follow it.
    expect(
      nextHint(entry('support.bundle'), { task_id: 'task-77', state: 'queued' })?.args,
    ).toEqual({ id: 'task-77', timeout_s: 25 });
  });

  it('says nothing for a task that is already terminal', () => {
    expect(nextHint(entry('filesystems.create'), { ...running, state: 'success' })).toBeUndefined();
  });

  it('says nothing for a plain read, even when the result carries a task_id', () => {
    expect(nextHint(entry('tasks.get'), running)).toBeUndefined();
  });

  it('says nothing for a plan (no task_id in the result)', () => {
    expect(nextHint(entry('filesystems.create'), { plan_id: 'p-1', diff: [] })).toBeUndefined();
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

describe('S15: hidden catalog entries never surface over MCP', () => {
  it('listTools omits mcp_exposed:false and binary entries', () => {
    const names = listTools().map((t) => t.name);
    expect(names).not.toContain('mcp_confirmations.approve');
    expect(names).not.toContain('mcp_confirmations.list');
    expect(names).not.toContain('system.metrics');
    expect(names).toContain('shares.update');
  });

  it('Task 7 follow-up: discovery advertises tools from the SAME predicate listTools uses', () => {
    expect(CATALOG.filter(mcpVisible).map((e) => e.name)).toEqual(listTools().map((t) => t.name));
    expect(buildCapabilities({}).tools).toEqual({});
  });
});

/**
 * A8 (final review M5) — the modern-era catch block used to put
 * `err.message` straight on the JSON-RPC wire. Any unexpected throw (a
 * sqlite error, a filesystem path, a stack-derived message) then reached an
 * MCP client verbatim. Only `McpProtocolError` — whose message and `data`
 * are written for the wire on purpose — keeps its text.
 */
describe('A8: unexpected errors never put raw text on the modern wire', () => {
  const opts = (thrown: unknown): DispatcherOptions => ({
    loopback: async () => {
      throw thrown;
    },
    loopbackToken: () => 'unused',
    allowApply: () => true,
    identity: () => ({ principal: 'admin:test', role: 'admin' }),
    client: { era: 'modern', elicitation: new Set(['form', 'url']) },
  });

  const call = {
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      name: 'arrays.list',
      arguments: {},
    },
  };

  it('a plain Error becomes -32603 "internal error" with no data and no original text', async () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    try {
      const res = await handleModernRequest(call, opts(new Error('sqlite disk I/O')), 'corr-a8');
      expect(res.error?.code).toBe(-32603);
      expect(res.error?.message).toBe('internal error');
      expect(res.error?.data).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain('sqlite');
      // …but the operator can still find it, tied to the correlation id.
      const logged = errors.map((a) => a.join(' ')).join('\n');
      expect(logged).toContain('corr-a8');
      expect(logged).toContain('sqlite disk I/O');
    } finally {
      spy.mockRestore();
    }
  });

  it('a thrown non-Error is redacted the same way', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await handleModernRequest(call, opts('/etc/xinas-api/config.json'), 'corr-a8b');
      expect(res.error?.message).toBe('internal error');
      expect(JSON.stringify(res)).not.toContain('config.json');
    } finally {
      spy.mockRestore();
    }
  });

  it('an McpProtocolError keeps its own message and data (they are written for the wire)', async () => {
    const res = await handleModernRequest(
      call,
      opts(
        new McpProtocolError(-32021, 'Server requires the elicitation capability', {
          httpStatus: 400,
          data: { requiredCapabilities: { elicitation: { url: {} } } },
        }),
      ),
      'corr-a8c',
    );
    expect(res.error?.code).toBe(-32021);
    expect(res.error?.message).toBe('Server requires the elicitation capability');
    expect(res.error?.data).toEqual({ requiredCapabilities: { elicitation: { url: {} } } });
    expect(res.httpStatus).toBe(400);
  });
});
