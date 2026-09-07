/**
 * MCP Apps resources owned by xiNAS-MCP (S18).
 *
 * UI resources are immutable build artifacts. They have no access to the API
 * bearer: every operation goes through the host's authenticated MCP channel.
 */

import { readFileSync } from 'node:fs';
import type { ReadResourceResult, ResourceProvider } from './resources.js';

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
 * The built view. Prefer the Vite single-file bundle; the URL is stable from
 * both src/api/mcp/apps.ts (tsx development/tests) and dist/api/mcp/apps.js.
 * A source fallback keeps isolated unit tests useful before a build; the
 * dev:api script builds the bundle first, so an interactive dev host always
 * receives the self-contained artifact. Immutable per process, so read once.
 */
let cachedHtml: string | undefined;
function loadAppHtml(): string {
  if (cachedHtml !== undefined) return cachedHtml;
  try {
    cachedHtml = readFileSync(
      new URL('../../../dist/mcp-apps/raid-create.html', import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cachedHtml = readFileSync(new URL('../../mcp-apps/raid-create.html', import.meta.url), 'utf8');
  }
  return cachedHtml;
}

export interface McpAppContent {
  uri: string;
  mimeType: typeof MCP_APP_MIME_TYPE;
  text: string;
  _meta: {
    ui: {
      csp: { connectDomains: never[]; resourceDomains: never[] };
      prefersBorder: true;
    };
  };
}

/**
 * Resolve only a closed, declared URI. Never turn an attacker-controlled URI
 * into a path.
 */
function appContent(uri: string): McpAppContent {
  if (uri !== RAID_CREATE_APP_URI) {
    throw new TypeError(`unknown MCP App resource: ${uri}`);
  }
  return {
    uri,
    mimeType: MCP_APP_MIME_TYPE,
    text: loadAppHtml(),
    _meta: {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    },
  };
}

/** Legacy-era read (the SDK server's handler and the unit tests). */
export async function readAppResource(uri: string): Promise<{ contents: McpAppContent[] }> {
  return { contents: [appContent(uri)] };
}

/**
 * The modern-era provider: the S17 seam lists the view next to the event
 * feeds and answers `resources/read` for it; it is never subscribable, so a
 * `subscriptions/listen` filter naming it is dropped silently (S17 §5.3).
 */
export function appsProvider(): ResourceProvider {
  return {
    list: () => listAppResources(),
    templates: () => [],
    owns: (uri) => uri === RAID_CREATE_APP_URI,
    read: (uri): ReadResourceResult => ({
      resultType: 'complete',
      contents: [appContent(uri)],
      ttlMs: 0,
      cacheScope: 'private',
    }),
    subscribable: () => false,
  };
}

export function mcpUiExtensionCapability(): Record<string, unknown> {
  return { mimeTypes: [MCP_APP_MIME_TYPE] };
}
