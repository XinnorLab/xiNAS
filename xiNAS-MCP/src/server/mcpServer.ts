/**
 * MCP Server instance.
 * Supports stdio transport (primary) and SSE transport (secondary).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/serverConfig.js';
import { registerAllTools } from '../registry/toolRegistry.js';

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();

  const server = new Server(
    {
      name: 'xinas-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerAllTools(server);

  if (config.sse_enabled) {
    // SSE transport — dynamic import to avoid requiring http module when unused
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('http');
    const port = config.sse_port ?? 8080;

    const httpServer = http.createServer();
    const transport = new SSEServerTransport('/sse', httpServer as never);

    await server.connect(transport);
    httpServer.listen(port, () => {
      process.stderr.write(`xiNAS-MCP SSE transport listening on :${port}\n`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`xiNAS-MCP stdio transport started (controller: ${config.controller_id})\n`);
  }
}
