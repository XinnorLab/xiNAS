import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../api/mcp/catalog.js';
import {
  type CliResponse,
  type Requester,
  parseArgs,
  resolveCommand,
  runCli,
  waitForTask,
} from '../../cli/xinasctl.js';

const entry = (name: string) => CATALOG.find((e) => e.name === name) as NonNullable<
  ReturnType<typeof CATALOG.find>
>;

describe('resolveCommand', () => {
  it('maps dotted catalog names to command paths (longest match)', () => {
    expect(resolveCommand(['arrays', 'list']).entry?.name).toBe('arrays.list');
    expect(resolveCommand(['network', 'interfaces', 'update']).entry?.name).toBe(
      'network.interfaces.update',
    );
    expect(resolveCommand(['network', 'pool', 'apply']).entry?.name).toBe('network.pool.apply');
    expect(resolveCommand(['config_history', 'drift']).entry).toBeUndefined(); // drift.report
    const miss = resolveCommand(['arrays']);
    expect(miss.entry).toBeUndefined();
    expect(miss.candidates).toContain('arrays.list');
  });

  it('every catalog name resolves through its own tokens', () => {
    for (const e of CATALOG) {
      expect(resolveCommand(e.name.split('.')).entry?.name).toBe(e.name);
    }
  });
});

describe('parseArgs', () => {
  it('positionals fill path params; flags map to schema keys', () => {
    const { args, conn, json, wait } = parseArgs(entry('shares.update'), [
      's1',
      '--plan',
      '--spec',
      '{"path":"/mnt/a"}',
      '--json',
      '--wait',
      '--socket',
      '/tmp/x.sock',
    ]);
    expect(args.id).toBe('s1');
    expect(args.mode).toBe('plan');
    expect(args.spec).toEqual({ path: '/mnt/a' });
    expect(conn.socket).toBe('/tmp/x.sock');
    expect(json).toBe(true);
    expect(wait).toBe(true);
  });

  it('--plan-id and bare boolean flags', () => {
    const { args } = parseArgs(entry('shares.create'), [
      '--apply',
      '--plan-id',
      'p-9',
      '--dangerous',
    ]);
    expect(args).toMatchObject({ mode: 'apply', plan_id: 'p-9', dangerous: true });
  });
});

describe('runCli', () => {
  const respond =
    (map: Record<string, CliResponse>): Requester =>
    async (_conn, req) => {
      const key = `${req.method} ${req.path}`;
      const hit = map[key];
      if (hit === undefined) throw new Error(`unexpected request ${key}`);
      return hit;
    };

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      lines: { out, err },
    };
  };

  it('read command: GET + pretty result; exit 0', async () => {
    const o = io();
    const code = await runCli(['arrays', 'list'], {
      request: respond({
        'GET /api/v1/arrays': { status: 200, body: { result: [{ id: 'a1' }] } },
      }),
      ...o,
    });
    expect(code).toBe(0);
    expect(o.lines.out.join('\n')).toContain('a1');
  });

  it('plan_apply without --plan/--apply is a usage error', async () => {
    const o = io();
    const code = await runCli(['shares', 'create'], {
      request: respond({}),
      ...o,
    });
    expect(code).toBe(2);
    expect(o.lines.err.join('\n')).toContain('--plan or --apply');
  });

  it('API error → exit 1 with the error code; warnings surface on stderr', async () => {
    const o = io();
    const code = await runCli(['quotas', 'list'], {
      request: respond({
        'GET /api/v1/quotas': {
          status: 200,
          body: {
            result: { quotas: [] },
            warnings: [{ code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'no repquota' }],
          },
        },
      }),
      ...o,
    });
    expect(code).toBe(0);
    expect(o.lines.err.join('\n')).toContain('DEGRADED_BACKEND_UNAVAILABLE');

    const o2 = io();
    const code2 = await runCli(['arrays', 'get', 'missing'], {
      request: respond({
        'GET /api/v1/arrays/missing': {
          status: 404,
          body: { errors: [{ code: 'NOT_FOUND', message: 'no such array' }] },
        },
      }),
      ...o2,
    });
    expect(code2).toBe(1);
    expect(o2.lines.err.join('\n')).toContain('NOT_FOUND');
  });

  it('unknown command suggests candidates; exit 2', async () => {
    const o = io();
    const code = await runCli(['arrayz', 'list'], { request: respond({}), ...o });
    expect(code).toBe(2);
    expect(o.lines.err.join('\n')).toContain('unknown command');
  });
});

describe('waitForTask', () => {
  it('polls to terminal, logging transitions; failed → non-success state', async () => {
    const states = ['queued', 'running', 'running', 'failed'];
    let n = 0;
    const request: Requester = async () => ({
      status: 200,
      body: { result: { state: states[Math.min(n++, states.length - 1)], error_code: 'BOOM' } },
    });
    const log: string[] = [];
    const state = await waitForTask({}, 't-1', request, (l) => log.push(l), 1);
    expect(state).toBe('failed');
    expect(log.join('\n')).toContain('queued');
    expect(log.join('\n')).toContain('BOOM');
  });
});
