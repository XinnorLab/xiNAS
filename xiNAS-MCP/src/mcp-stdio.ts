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
          message: `xinas-api unreachable at ${SOCKET}: ${err instanceof Error ? err.message : String(err)}`,
        },
        id: message.id ?? null,
      })}\n`,
    );
  }
}

// Serialize message handling: stdio MCP clients expect ordered replies.
let chain: Promise<void> = Promise.resolve();
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  chain = chain.then(() => bridge(line));
});
rl.on('close', () => {
  void chain.then(() => process.exit(0));
});
