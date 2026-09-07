/**
 * Per-request client capability parsing for the MCP Tasks extension
 * (S16 §3.1/§3.3). Read from THIS request's `_meta` only — never from a
 * session, an earlier discover, clientInfo or the transport.
 */
import {
  INVALID_PARAMS,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  McpProtocolError,
} from '../confirmation/errors.js';

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** True iff the request declares the extension; -32602 on a malformed declaration. */
export function parseTasksCapability(meta: unknown): boolean {
  if (!isPlainObject(meta)) return false;
  const caps = meta[CLIENT_CAPABILITIES_META];
  if (!isPlainObject(caps) || !('extensions' in caps)) return false;
  const extensions = caps.extensions;
  if (!isPlainObject(extensions)) {
    throw new McpProtocolError(
      INVALID_PARAMS,
      'invalid params: clientCapabilities.extensions must be an object',
    );
  }
  if (!(TASKS_EXTENSION_ID in extensions)) return false;
  if (!isPlainObject(extensions[TASKS_EXTENSION_ID])) {
    throw new McpProtocolError(
      INVALID_PARAMS,
      `invalid params: extensions["${TASKS_EXTENSION_ID}"] must be an object`,
    );
  }
  return true;
}

/** The -32021 answer to a task method from a client that did not declare the extension (§3.3). */
export function missingTasksCapability(): McpProtocolError {
  return new McpProtocolError(
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    'Missing required client capability',
    {
      httpStatus: 400,
      data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
      reasonClass: 'tasks_capability_missing',
    },
  );
}
