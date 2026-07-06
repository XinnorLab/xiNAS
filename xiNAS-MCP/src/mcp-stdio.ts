#!/usr/bin/env node
/**
 * xinas-mcp-stdio — the stdio → Streamable-HTTP transport adapter
 * (S8 T7, ADR-0010 §transports).
 *
 * MCP stdio framing is newline-delimited JSON-RPC; the api's /mcp
 * endpoint runs in JSON response mode (one POST in, one JSON out).
 * The adapter is therefore a faithful per-message bridge:
 *
 *   stdin line → POST /mcp (+ mcp-session-id once initialized) →
 *   response JSON → stdout line
 *
 * It connects to the api's UNIX socket by default — the socket file
 * mode is the authentication gate (ADR-0001 local_admin); pass
 * XINAS_MCP_TOKEN to authenticate as a specific principal instead.
 * Notifications (no id) expect a 202/empty response and emit nothing.
 *
 * This is deliberately NOT a byte proxy and NOT an SDK client: tool
 * traffic is strictly request/response (the endpoint has no push
 * stream), so per-message bridging is the whole job.
 */

import * as http from 'node:http';
import { createInterface } from 'node:readline';

const SOCKET = process.env.XINAS_API_SOCKET ?? '/run/xinas/api.sock';
const TOKEN = process.env.XINAS_MCP_TOKEN;

let sessionId: string | undefined;

/**
 * Map a socket connect failure to an actionable one-liner. The api
 * socket is mode 0660 root:xinas-admin, so the common cause of a failed
 * tool call from a non-root operator is "not in the xinas-admin group"
 * (finding N4) — surface the fix rather than a bare `connect EACCES`.
 * Returns undefined for codes we have no specific guidance for (the raw
 * errno still travels in the base message).
 */
export function connectErrorHint(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'EACCES':
      return (
        'permission denied on the socket (mode 0660 root:xinas-admin). ' +
        'Add this account to the xinas-admin group — ' +
        '`sudo usermod -aG xinas-admin <user>`, then log out and back in — or run as root.'
      );
    case 'ENOENT':
      return (
        'the socket does not exist. xinas-api.service is likely not installed or ' +
        'not running — check `systemctl status xinas-api`.'
      );
    case 'ECONNREFUSED':
      return (
        'the socket exists but nothing is listening. xinas-api is likely stopped — ' +
        'check `systemctl status xinas-api`.'
      );
    default:
      return undefined;
  }
}

/** Compose the JSON-RPC error message for an unreachable api socket. */
export function unreachableMessage(socket: string, err: unknown): string {
  const base = `xinas-api unreachable at ${socket}: ${err instanceof Error ? err.message : String(err)}`;
  const hint = connectErrorHint(err);
  return hint === undefined ? base : `${base} — ${hint}`;
}

function post(message: unknown): Promise<{ status: number; body: string; session?: string }> {
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
          ...(TOKEN !== undefined ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const session = res.headers['mcp-session-id'];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(typeof session === 'string' ? { session } : {}),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function bridge(line: string): Promise<void> {
  if (line.trim().length === 0) return;
  let message: { id?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown };
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null })}\n`,
    );
    return;
  }
  try {
    const res = await post(message);
    if (res.session !== undefined) sessionId = res.session;
    if (message.id === undefined || message.id === null) return; // notification
    if (res.body.trim().length === 0) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: `empty response (HTTP ${res.status})` },
          id: message.id,
        })}\n`,
      );
      return;
    }
    process.stdout.write(`${res.body.trim()}\n`);
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: unreachableMessage(SOCKET, err),
        },
        id: message.id ?? null,
      })}\n`,
    );
  }
}

// Serialize message handling: stdio MCP clients expect ordered replies.
// Guarded so importing this module (unit tests) doesn't start the read
// loop or exit the process — mirrors the isMain pattern in cli/xinasctl.ts.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('mcp-stdio.js') ||
    process.argv[1].endsWith('mcp-stdio') ||
    process.argv[1].endsWith('xinas-mcp-stdio'));

if (isMain) {
  let chain: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    chain = chain.then(() => bridge(line));
  });
  rl.on('close', () => {
    void chain.then(() => process.exit(0));
  });
}
