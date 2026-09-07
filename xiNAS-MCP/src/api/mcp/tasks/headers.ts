/**
 * Streamable HTTP request-metadata agreement for the task methods
 * (S16 §5.6; transport spec 2026-07-28 §Request Metadata / §Server
 * Validation; SEP-2663 puts params.taskId in Mcp-Name).
 */
import { McpProtocolError } from '../confirmation/errors.js';

export const TASK_METHODS: ReadonlySet<string> = new Set([
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
]);
export const HEADER_MISMATCH = -32020;
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SENTINEL_PREFIX = '=?base64?';
const SENTINEL_SUFFIX = '?=';

const isHeaderSafe = (v: string): boolean =>
  /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(v) &&
  !(v.startsWith(SENTINEL_PREFIX) && v.endsWith(SENTINEL_SUFFIX));

/** Encode per the transport's Value Encoding rule (plain when safe, else the base64 sentinel). */
export function encodeMcpHeaderValue(value: string): string {
  if (isHeaderSafe(value)) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${SENTINEL_SUFFIX}`;
}

/** Decode a possibly-sentinel value; null when the sentinel carries invalid base64. */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!(value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX))) return value;
  const inner = value.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);
  if (inner.length !== 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(inner)) return null;
  return Buffer.from(inner, 'base64').toString('utf8');
}

const mismatch = (detail: string): McpProtocolError =>
  new McpProtocolError(HEADER_MISMATCH, `Header mismatch: ${detail}`, {
    httpStatus: 400,
    reasonClass: 'header_mismatch',
  });

/**
 * Enforce Mcp-Method / Mcp-Name (and MCP-Protocol-Version when present)
 * for a task method. `header(name)` is the case-insensitive accessor
 * (express `req.header`). Non-task methods are untouched (S14 tolerance).
 */
export function validateTaskMethodHeaders(
  header: (name: string) => string | undefined,
  message: unknown,
): void {
  const msg = message as {
    method?: unknown;
    params?: { _meta?: Record<string, unknown>; taskId?: unknown };
  } | null;
  if (
    msg === null ||
    typeof msg !== 'object' ||
    typeof msg.method !== 'string' ||
    !TASK_METHODS.has(msg.method)
  )
    return;

  const method = header('mcp-method');
  if (method === undefined) throw mismatch('Mcp-Method header is required for task methods');
  if (method !== msg.method)
    throw mismatch(`Mcp-Method header value '${method}' does not match the request method`);

  const version = header('mcp-protocol-version');
  const declared = msg.params?._meta?.[PROTOCOL_VERSION_META];
  if (version !== undefined && version !== declared) {
    throw mismatch(
      `MCP-Protocol-Version header value '${version}' does not match the request body`,
    );
  }

  if (typeof msg.params?.taskId !== 'string') return; // the handler's -32602 speaks
  const name = header('mcp-name');
  if (name === undefined) throw mismatch('Mcp-Name header is required for task methods');
  const decoded = decodeMcpHeaderValue(name);
  if (decoded === null)
    throw mismatch('Mcp-Name header value is not valid base64 sentinel encoding');
  if (decoded !== msg.params.taskId)
    throw mismatch('Mcp-Name header value does not match params.taskId');
}
