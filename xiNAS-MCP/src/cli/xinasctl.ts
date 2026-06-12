#!/usr/bin/env node
/**
 * xinasctl — the xiNAS control-path CLI (S8 T9, ADR-0010).
 *
 * The command tree is GENERATED from the client catalog: the tool
 * name's dot segments are the command path (`arrays.list` →
 * `xinasctl arrays list`), so CLI, MCP, and REST stay in parity by
 * construction. xinasctl is a plain REST client over the api UDS
 * (peer trust) or TCP (--url + --token / XINAS_TOKEN) — no MCP gate
 * applies (client_type stays 'rest').
 *
 * Flags:
 *   --socket <path>     api UDS (default /run/xinas/api.sock)
 *   --url <http://h:p>  TCP instead of the UDS
 *   --token <tok>       bearer (or XINAS_TOKEN)
 *   --json              raw envelope output
 *   --plan / --apply    sets mode for plan_apply commands
 *   --spec '<json>'     inline operation spec
 *   -f <file>           spec from a JSON file
 *   --wait              poll the returned task to a terminal state
 *   --<key> <value>     any input_schema property (e.g. --profile deep,
 *                       --plan-id p-1, --dangerous)
 *   positional          path parameters in catalog order
 *
 * Exit codes: 0 success, 1 API/task error, 2 usage.
 */

import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { CATALOG, type CatalogEntry } from '../api/mcp/catalog.js';
import { buildRequest } from '../api/mcp/dispatch.js';

export interface CliConnection {
  socket?: string;
  url?: string;
  token?: string;
}

export interface CliRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface CliResponse {
  status: number;
  body: {
    result?: unknown;
    warnings?: Array<{ code: string; message: string }>;
    errors?: Array<{ code?: string; message?: string }>;
  };
  raw?: Buffer;
  contentType?: string;
}

export type Requester = (conn: CliConnection, req: CliRequest) => Promise<CliResponse>;

/** Resolve argv tokens to a catalog entry + remaining tokens. */
export function resolveCommand(tokens: string[]): {
  entry?: CatalogEntry;
  rest: string[];
  candidates: string[];
} {
  // longest dotted-prefix match over catalog names
  for (let take = Math.min(tokens.length, 4); take >= 1; take -= 1) {
    const name = tokens.slice(0, take).join('.');
    const entry = CATALOG.find((e) => e.name === name);
    if (entry !== undefined) return { entry, rest: tokens.slice(take), candidates: [] };
  }
  const prefix = tokens.join('.');
  const candidates = CATALOG.map((e) => e.name)
    .filter((n) => n.startsWith(prefix))
    .slice(0, 12);
  return { rest: tokens, candidates };
}

interface ParsedArgs {
  args: Record<string, unknown>;
  conn: CliConnection;
  json: boolean;
  wait: boolean;
}

/** Parse flags + positionals against an entry's input schema. */
export function parseArgs(entry: CatalogEntry, rest: string[]): ParsedArgs {
  const args: Record<string, unknown> = {};
  const conn: CliConnection = {};
  let json = false;
  let wait = false;
  const positionals: string[] = [];

  const pathParams = [...entry.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);

  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i] as string;
    if (tok === '--json') json = true;
    else if (tok === '--wait') wait = true;
    else if (tok === '--plan') args.mode = 'plan';
    else if (tok === '--apply') args.mode = 'apply';
    else if (tok === '--dangerous') args.dangerous = true;
    else if (tok === '--socket') {
      const v = rest[(i += 1)];
      if (v !== undefined) conn.socket = v;
    } else if (tok === '--url') {
      const v = rest[(i += 1)];
      if (v !== undefined) conn.url = v;
    } else if (tok === '--token') {
      const v = rest[(i += 1)];
      if (v !== undefined) conn.token = v;
    } else if (tok === '--spec') args.spec = JSON.parse(rest[(i += 1)] as string);
    else if (tok === '-f') args.spec = JSON.parse(readFileSync(rest[(i += 1)] as string, 'utf8'));
    else if (tok.startsWith('--')) {
      // --plan-id → plan_id; --profile deep
      const key = tok.slice(2).replaceAll('-', '_');
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else positionals.push(tok);
  }

  for (const [idx, param] of pathParams.entries()) {
    if (positionals[idx] !== undefined) args[param] = positionals[idx];
  }
  return { args, conn, json, wait };
}

export const httpRequester: Requester = (conn, req) =>
  new Promise((resolve, reject) => {
    const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    let base: http.RequestOptions;
    if (conn.url !== undefined) {
      const u = new URL(conn.url);
      base = { host: u.hostname, port: u.port !== '' ? Number(u.port) : 80 };
    } else {
      base = { socketPath: conn.socket ?? '/run/xinas/api.sock' };
    }
    const r = http.request(
      {
        ...base,
        path: req.path,
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(conn.token !== undefined ? { authorization: `Bearer ${conn.token}` } : {}),
          ...(payload !== undefined
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] ?? '';
          let body: CliResponse['body'] = {};
          if (contentType.includes('json')) {
            try {
              body = JSON.parse(raw.toString('utf8')) as CliResponse['body'];
            } catch {
              /* leave empty */
            }
          }
          resolve({ status: res.statusCode ?? 0, body, raw, contentType });
        });
      },
    );
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });

const TERMINAL_STATES = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

export async function waitForTask(
  conn: CliConnection,
  taskId: string,
  request: Requester,
  log: (line: string) => void,
  pollMs = 500,
  timeoutMs = 600_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  for (;;) {
    const res = await request(conn, { method: 'GET', path: `/api/v1/tasks/${taskId}` });
    const task = res.body.result as { state?: string; error_code?: string | null } | undefined;
    const state = task?.state ?? 'unknown';
    if (state !== lastState) {
      log(`task ${taskId}: ${state}`);
      lastState = state;
    }
    if (TERMINAL_STATES.includes(state)) {
      if (state !== 'success' && task?.error_code != null) {
        log(`error: ${task.error_code}`);
      }
      return state;
    }
    if (Date.now() > deadline) throw new Error(`task ${taskId} not terminal in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function usage(): string {
  const groups = new Map<string, string[]>();
  for (const e of CATALOG) {
    const [head, ...tail] = e.name.split('.');
    const list = groups.get(head as string) ?? [];
    list.push(tail.join(' '));
    groups.set(head as string, list);
  }
  const lines = ['usage: xinasctl <resource> <verb> [args] [flags]', '', 'commands:'];
  for (const [head, verbs] of [...groups.entries()].sort()) {
    lines.push(`  ${head} ${verbs.join(' | ')}`);
  }
  lines.push(
    '',
    'flags: --socket <path> | --url <http://h:p> --token <tok> | --json |',
    '       --plan | --apply | --spec <json> | -f <file> | --wait | --dangerous',
  );
  return lines.join('\n');
}

export async function runCli(
  argv: string[],
  io: { request: Requester; out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  // split command tokens (until the first flag) from the rest
  const cmdTokens: string[] = [];
  let i = 0;
  for (; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    if (tok.startsWith('-')) break;
    cmdTokens.push(tok);
    const probe = resolveCommand(cmdTokens);
    if (probe.entry !== undefined) {
      i += 1;
      break;
    }
  }
  if (cmdTokens.length === 0 || argv.includes('--help') || cmdTokens[0] === 'help') {
    io.out(usage());
    return cmdTokens.length === 0 && !argv.includes('--help') ? 2 : 0;
  }
  const { entry, candidates } = resolveCommand(cmdTokens);
  if (entry === undefined) {
    io.err(`unknown command: ${cmdTokens.join(' ')}`);
    if (candidates.length > 0) io.err(`did you mean: ${candidates.join(', ')}`);
    return 2;
  }

  const { args, conn, json, wait } = parseArgs(entry, argv.slice(i));
  if (conn.token === undefined && process.env.XINAS_TOKEN !== undefined) {
    conn.token = process.env.XINAS_TOKEN;
  }
  if (entry.mutability === 'plan_apply' && args.mode === undefined) {
    io.err(`${entry.name} requires --plan or --apply`);
    return 2;
  }

  let req: { path: string; body?: unknown };
  try {
    req = buildRequest(entry, args);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const res = await io.request(conn, {
    method: entry.method,
    path: req.path,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });

  if (entry.binary === true) {
    // binary downloads stream raw to stdout (callers redirect)
    if (res.status !== 200) {
      io.err(`HTTP ${res.status}`);
      return 1;
    }
    process.stdout.write(res.raw ?? Buffer.alloc(0));
    return 0;
  }

  if (json) {
    io.out(JSON.stringify(res.body, null, 2));
  } else {
    for (const w of res.body.warnings ?? []) io.err(`warning: ${w.code} — ${w.message}`);
    if (res.status >= 400) {
      const e = res.body.errors?.[0];
      io.err(`error: ${e?.code ?? res.status} — ${e?.message ?? 'request failed'}`);
      return 1;
    }
    io.out(JSON.stringify(res.body.result, null, 2));
  }
  if (res.status >= 400) return 1;

  if (wait) {
    const task = res.body.result as { task_id?: string } | undefined;
    if (task?.task_id === undefined) {
      io.err('--wait: no task_id in the response');
      return 1;
    }
    const state = await waitForTask(conn, task.task_id, io.request, io.err);
    return state === 'success' ? 0 : 1;
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('xinasctl.js') || process.argv[1].endsWith('xinasctl'));
if (isMain) {
  runCli(process.argv.slice(2), {
    request: httpRequester,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
