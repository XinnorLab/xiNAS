/**
 * xiNAS-MCP entry point.
 * Starts the MCP server on stdio, with optional SSE and Streamable HTTP transports.
 */

import { startMcpServer } from './server/mcpServer.js';

startMcpServer().catch((err: unknown) => {
  process.stderr.write(`xiNAS-MCP fatal error: ${String(err)}\n`);
  process.exit(1);
});
