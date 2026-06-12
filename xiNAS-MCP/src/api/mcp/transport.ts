/**
 * The /mcp Streamable HTTP transport (S8 T7, ADR-0010 §transports).
 *
 * Mounted on the api express app itself — every listener (primary UDS
 * or TCP, plus the optional dedicated `config.mcp.http` listener)
 * serves it. JSON response mode (`enableJsonResponse`) keeps the
 * protocol stdio-adapter-friendly: one POST in, one JSON out.
 *
 * Identity resolves ONCE per session at initialize:
 *   bearer → config.tokens (viewer/operator/admin; internal_agent is
 *   refused — the agent has no business on the MCP surface);
 *   no bearer over UDS → local_admin (ADR-0001: the socket mode is
 *   the gate); no bearer over TCP → 401.
 *
 * The session's tool calls then replay through the loopback with that
 * identity (dispatch.ts). `ctx.loopback_fn` is injected by server.ts
 * AFTER the primary listener binds; /mcp answers 503 until then.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { type McpIdentity, buildMcpServer } from './dispatch.js';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

function resolveIdentity(req: Request, ctx: ApiContext): McpIdentity | null {
  const authHeader = req.header('authorization');
  if (authHeader !== undefined && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const principal = ctx.config.tokens[token];
    if (principal === undefined) return null;
    if (
      principal.role !== 'viewer' &&
      principal.role !== 'operator' &&
      principal.role !== 'admin'
    ) {
      return null; // internal_agent etc. — not an MCP principal
    }
    return { principal: principal.principal, role: principal.role };
  }
  // UDS without a bearer: the socket file mode is the gate (ADR-0001).
  if (!req.socket.remoteAddress) {
    return { principal: 'mcp:local_admin', role: 'admin' };
  }
  return null;
}

export function mountMcpTransport(app: Express, ctx: ApiContext): void {
  const sessions = new Map<string, McpSession>();

  app.post('/mcp', (req: Request, res: Response) => {
    void (async () => {
      if (ctx.loopback_fn === undefined) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'MCP transport not ready (api still starting)' },
          id: null,
        });
        return;
      }

      const sessionId = req.header('mcp-session-id');
      if (sessionId !== undefined && sessions.has(sessionId)) {
        await (sessions.get(sessionId) as McpSession).transport.handleRequest(
          req,
          res,
          req.body,
        );
        return;
      }

      // New session: only an initialize request may open one.
      const identity = resolveIdentity(req, ctx);
      if (identity === null) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'unauthorized (unknown or missing bearer)' },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };

      const server = buildMcpServer({
        loopback: (r) => (ctx.loopback_fn as NonNullable<typeof ctx.loopback_fn>)(r),
        loopbackToken: () => ctx.loopback_token,
        allowApply: () => ctx.config.mcp?.allow_apply === true,
        identity: () => identity,
      });
      // exactOptionalPropertyTypes friction in the SDK's Transport
      // interface (same cast the legacy server used).
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
      }
    });
  });

  app.delete('/mcp', (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (session === undefined) {
      res.status(404).end();
      return;
    }
    void session.transport.close().finally(() => {
      if (sessionId !== undefined) sessions.delete(sessionId);
      res.status(200).end();
    });
  });

  // JSON response mode has no server-push stream.
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'GET stream unsupported (JSON response mode)' },
      id: null,
    });
  });
}
