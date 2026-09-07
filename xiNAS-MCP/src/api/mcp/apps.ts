/**
 * MCP Apps resources owned by xiNAS-MCP (S18).
 *
 * UI resources are immutable build artifacts. They have no access to the API
 * bearer: every operation goes through the host's authenticated MCP channel.
 */

import { readFile } from 'node:fs/promises';

export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const RAID_CREATE_APP_URI = 'ui://xinas/raid-create';

export interface McpAppResource {
  uri: string;
  name: string;
  description: string;
  mimeType: typeof MCP_APP_MIME_TYPE;
}

const RAID_CREATE_RESOURCE: McpAppResource = {
  uri: RAID_CREATE_APP_URI,
  name: 'xiNAS RAID Create',
  description: 'Interactive xiRAID array creation wizard',
  mimeType: MCP_APP_MIME_TYPE,
};

export function listAppResources(): McpAppResource[] {
  return [{ ...RAID_CREATE_RESOURCE }];
}

/**
 * Resolve only a closed, declared URI. Never turn an attacker-controlled URI
 * into a path. The same relative location works from src/ under tsx and from
 * dist/ after tsc + the Vite single-file build.
 */
export async function readAppResource(uri: string): Promise<{
  contents: Array<{
    uri: string;
    mimeType: typeof MCP_APP_MIME_TYPE;
    text: string;
    _meta: {
      ui: {
        csp: { connectDomains: never[]; resourceDomains: never[] };
        prefersBorder: true;
      };
    };
  }>;
}> {
  if (uri !== RAID_CREATE_APP_URI) {
    throw new TypeError(`unknown MCP App resource: ${uri}`);
  }
  // Prefer the Vite single-file bundle. The URL is stable from both
  // src/api/mcp/apps.ts (tsx development/tests) and dist/api/mcp/apps.js.
  // A source fallback keeps isolated unit tests useful before a build; the
  // dev:api script builds the bundle first, so an interactive dev host always
  // receives the self-contained artifact.
  let text: string;
  try {
    text = await readFile(
      new URL('../../../dist/mcp-apps/raid-create.html', import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = await readFile(new URL('../../mcp-apps/raid-create.html', import.meta.url), 'utf8');
  }
  return {
    contents: [
      {
        uri,
        mimeType: MCP_APP_MIME_TYPE,
        text,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [] },
            prefersBorder: true,
          },
        },
      },
    ],
  };
}

export function mcpUiExtensionCapability(): Record<string, unknown> {
  return { mimeTypes: [MCP_APP_MIME_TYPE] };
}
