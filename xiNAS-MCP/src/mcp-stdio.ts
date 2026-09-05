#!/usr/bin/env node
/**
 * xinas-mcp-stdio — the stdio → Streamable-HTTP transport adapter
 * (S8 T7, ADR-0010 §transports; S17 §5.5 for subscriptions).
 *
 * MCP stdio framing is newline-delimited JSON-RPC; the api's /mcp
 * endpoint answers one JSON body per POST for every method but one.
 * The adapter is therefore a faithful per-message bridge:
 *
 *   stdin line → POST /mcp (+ mcp-session-id once initialized) →
 *   response JSON → stdout line
 *
 * `subscriptions/listen` (S17, decision D-19) is the exception: its
 * response is an SSE stream that stays open, so such a line runs OFF the
 * serial chain, every `data:` payload it carries is written to stdout as
 * its own line (ordering is per subscription, as the protocol requires),
 * an inbound `notifications/cancelled` naming a live listen id aborts that
 * HTTP request (the transport-level close is the cancel) instead of being
 * forwarded, and the graceful listen result is written like any message.
 *
 * It connects to the api's UNIX socket by default — the socket file
 * mode is the authentication gate (ADR-0001 local_admin); pass
 * XINAS_MCP_TOKEN to authenticate as a specific principal instead.
 * Notifications (no id) expect a 202/empty response and emit nothing.
 *
 * This is deliberately NOT a byte proxy and NOT an SDK client: tool
 * traffic is strictly request/response, so per-message bridging is the
 * whole job.
 */

import * as http from 'node:http';
import { createInterface } from 'node:readline';

const SOCKET = process.env.XINAS_API_SOCKET ?? '/run/xinas/api.sock';
const TOKEN = process.env.XINAS_MCP_TOKEN;

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

export interface BridgeOptions {
  socketPath: string;
  token?: string | undefined;
  /** One JSON-RPC message per call, already serialized (no trailing newline). */
  out: (line: string) => void;
}

export interface Bridge {
  /** Feed one stdin line. Never throws; malformed input becomes a parse-error line. */
  handleLine(line: string): void;
  /** Abort every live listen and let the serial chain drain. */
  close(): Promise<void>;
}

interface JsonRpcLine {
  id?: unknown;
  method?: unknown;
  params?: { requestId?: unknown } & Record<string, unknown>;
}

/** JSON-RPC ids may be strings or numbers; key them by their JSON text. */
const idKey = (id: unknown): string => JSON.stringify(id);

/**
 * Incremental SSE parser for one response body: `data:` lines accumulate
 * until a blank line; `event:` names and comment lines (keep-alives) are
 * ignored. The server emits one JSON-RPC message per frame.
 */
function sseFrames(onFrame: (data: string) => void): (chunk: string) => void {
  let buffer = '';
  let data: string[] = [];
  return (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) {
        if (data.length > 0) onFrame(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
      // `event:`, `id:`, `retry:` and `:comment` lines carry nothing we forward.
      nl = buffer.indexOf('\n');
    }
  };
}

export function createBridge(opts: BridgeOptions): Bridge {
  const { socketPath, token, out } = opts;
  let sessionId: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  const live = new Map<string, http.ClientRequest>();
  let closing = false;

  const headersFor = (payload: string, sse: boolean): http.OutgoingHttpHeaders => ({
    'content-type': 'application/json',
    accept: sse ? 'application/json, text/event-stream' : 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(payload),
    ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  });

  const errorLine = (id: unknown, code: number, message: string): void => {
    out(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: id ?? null }));
  };

  function post(message: unknown): Promise<{ status: number; body: string; session?: string }> {
    const payload = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path: '/mcp', method: 'POST', headers: headersFor(payload, false) },
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

  async function bridge(message: JsonRpcLine): Promise<void> {
    try {
      const res = await post(message);
      if (res.session !== undefined) sessionId = res.session;
      if (message.id === undefined || message.id === null) return; // notification
      if (res.body.trim().length === 0) {
        errorLine(message.id, -32603, `empty response (HTTP ${res.status})`);
        return;
      }
      out(res.body.trim());
    } catch (err) {
      errorLine(message.id, -32603, unreachableMessage(socketPath, err));
    }
  }

  /** A listen runs off the chain; its stream is demultiplexed line by line. */
  function openListen(message: JsonRpcLine): void {
    const key = idKey(message.id);
    const payload = JSON.stringify(message);
    let aborted = false;
    const req = http.request(
      { socketPath, path: '/mcp', method: 'POST', headers: headersFor(payload, true) },
      (res) => {
        const isSse = (res.headers['content-type'] ?? '').startsWith('text/event-stream');
        res.setEncoding('utf8');
        if (!isSse) {
          // The pre-acknowledgment rejection (or a legacy-era answer): one line.
          let body = '';
          res.on('data', (c: string) => {
            body += c;
          });
          res.on('end', () => {
            live.delete(key);
            if (body.trim().length === 0) {
              errorLine(message.id, -32603, `empty response (HTTP ${res.statusCode ?? 0})`);
            } else {
              out(body.trim());
            }
          });
          return;
        }
        const feed = sseFrames((data) => out(data));
        res.on('data', feed);
        res.on('end', () => live.delete(key));
        res.on('error', () => live.delete(key));
      },
    );
    req.on('error', (err) => {
      live.delete(key);
      if (aborted || closing) return; // our own cancel: the client asked for silence
      errorLine(message.id, -32603, unreachableMessage(socketPath, err));
    });
    req.on('close', () => live.delete(key));
    const previous = live.get(key);
    if (previous !== undefined) previous.destroy();
    live.set(key, req);
    // Expose the abort flag through the request object for cancellation.
    (req as http.ClientRequest & { __xinasAbort?: () => void }).__xinasAbort = () => {
      aborted = true;
      req.destroy();
    };
    req.write(payload);
    req.end();
  }

  function cancelListen(key: string): boolean {
    const req = live.get(key);
    if (req === undefined) return false;
    live.delete(key);
    (req as http.ClientRequest & { __xinasAbort?: () => void }).__xinasAbort?.();
    return true;
  }

  return {
    handleLine(line: string): void {
      if (line.trim().length === 0) return;
      let message: JsonRpcLine;
      try {
        message = JSON.parse(line) as JsonRpcLine;
      } catch {
        errorLine(null, -32700, 'parse error');
        return;
      }
      const hasId = message.id !== undefined && message.id !== null;
      if (message.method === 'subscriptions/listen' && hasId) {
        openListen(message);
        return;
      }
      if (
        message.method === 'notifications/cancelled' &&
        !hasId &&
        message.params !== undefined &&
        cancelListen(idKey(message.params.requestId))
      ) {
        return; // the HTTP close IS the cancel; nothing to forward
      }
      chain = chain.then(() => bridge(message));
    },
    async close(): Promise<void> {
      closing = true;
      for (const key of [...live.keys()]) cancelListen(key);
      await chain;
    },
  };
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
  const bridge = createBridge({
    socketPath: SOCKET,
    token: TOKEN,
    out: (line) => process.stdout.write(`${line}\n`),
  });
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => bridge.handleLine(line));
  rl.on('close', () => {
    void bridge.close().then(() => process.exit(0));
  });
}
