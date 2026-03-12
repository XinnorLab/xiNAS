/**
 * MCP Server instance.
 * Supports stdio (always), SSE (optional), and Streamable HTTP (optional) transports.
 * stdio runs alongside HTTP transports when enabled.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config/serverConfig.js';
import { registerAllTools } from '../registry/toolRegistry.js';
import { createHttpApp, type AuthenticatedRequest } from './httpApp.js';
import type { Request, Response } from 'express';
import type { Role } from '../types/common.js';

/** Active Streamable HTTP sessions. */
const sessions = new Map<string, StreamableHTTPServerTransport>();

function createServer(defaultRole?: Role): Server {
  const server = new Server(
    { name: 'xinas-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, defaultRole);
  return server;
}

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();

  // --- stdio transport (always active) ---
  const stdioServer = createServer('admin');
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);
  process.stderr.write(`xiNAS-MCP stdio transport started (controller: ${config.controller_id})\n`);

  // --- HTTP transports (SSE and/or Streamable HTTP) ---
  if (!config.sse_enabled && !config.http_enabled) return;

  const app = createHttpApp();
  const port = config.http_port ?? config.sse_port ?? 8080;

  // SSE transport
  if (config.sse_enabled) {
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const sseServer = createServer(); // will use token-based auth per-request
    const sseTransport = new SSEServerTransport('/sse', app as never);
    await sseServer.connect(sseTransport);
    process.stderr.write(`xiNAS-MCP SSE transport mounted at /sse\n`);
  }

  // Streamable HTTP transport
  if (config.http_enabled) {
    // POST /mcp — client-to-server messages (initialize, tool calls, etc.)
    app.post('/mcp', async (req: Request, res: Response) => {
      const authReq = req as AuthenticatedRequest;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — reuse transport
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        // New session — create transport + server
        const role: Role = authReq.mcpRole ?? 'viewer';
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const server = createServer(role);
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Invalid request — no session and not an initialize
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    });

    // GET /mcp — SSE stream for server-to-client notifications
    app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: null,
        });
        return;
      }
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // DELETE /mcp — session termination
    app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: null,
        });
        return;
      }
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    process.stderr.write(`xiNAS-MCP Streamable HTTP transport mounted at /mcp\n`);
  }

  // Create HTTP or HTTPS server
  let httpServer: http.Server | https.Server;

  if (config.tls) {
    const tlsOpts: https.ServerOptions = {
      cert: fs.readFileSync(config.tls.cert),
      key: fs.readFileSync(config.tls.key),
    };
    if (config.tls.ca) {
      tlsOpts.ca = fs.readFileSync(config.tls.ca);
      tlsOpts.requestCert = true;
      tlsOpts.rejectUnauthorized = true;
    }
    httpServer = https.createServer(tlsOpts, app);
    process.stderr.write(`xiNAS-MCP TLS enabled${config.tls.ca ? ' (mTLS)' : ''}\n`);
  } else {
    httpServer = http.createServer(app);
  }

  httpServer.listen(port, () => {
    process.stderr.write(`xiNAS-MCP HTTP transport listening on :${port}\n`);
  });
}
