/**
 * JSON-RPC 2.0 dispatcher over NDJSON.
 *
 * Takes a single line of text (one NDJSON record), validates the
 * JSON-RPC 2.0 envelope, looks up the method in an explicit allow-list
 * provided by the caller, invokes the handler, and returns a fully-formed
 * JSON-RPC 2.0 response line (no trailing newline — the server adds it).
 *
 * Error code mapping (per spec §Errors):
 *   -32600  Invalid Request  malformed envelope or missing `method`
 *   -32601  Method not found method absent from the allow-list
 *   -32602  Invalid params   handler throws with err.code === 'INVALID_PARAMS'
 *   -32603  Internal error   any other unhandled handler throw
 *   -32000  Custom           handler throws with err.code === 'EXECUTOR_UNSUPPORTED';
 *             data: { code: 'EXECUTOR_UNSUPPORTED', method: string }
 *
 * No side effects; safe to unit-test without a real socket.
 */

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcHandlerMap {
  [method: string]: RpcHandler;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

function errorEnvelope(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

export function createDispatcher(handlers: RpcHandlerMap): (line: string) => Promise<string> {
  return async function dispatch(line: string): Promise<string> {
    // 1. Parse JSON.
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return errorEnvelope(null, -32600, 'Parse error: input is not valid JSON');
    }

    // 2. Validate the envelope shape.
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return errorEnvelope(null, -32600, 'Invalid Request: envelope must be a JSON object');
    }

    const req = raw as Record<string, unknown>;
    const id: number | string | null =
      typeof req['id'] === 'number' || typeof req['id'] === 'string'
        ? (req['id'] as number | string)
        : null;

    if (typeof req['method'] !== 'string' || req['method'].length === 0) {
      return errorEnvelope(id, -32600, 'Invalid Request: missing or non-string "method" field');
    }
    const method = req['method'] as string;
    const params = req['params'] ?? {};

    // 3. Route.
    const handler = handlers[method];
    if (handler === undefined) {
      return errorEnvelope(
        id,
        -32601,
        `Method not found: "${method}" is not in the agent's RPC surface`,
      );
    }

    // 4. Invoke.
    try {
      const result = await handler(params);
      return JSON.stringify({ jsonrpc: '2.0', id, result });
    } catch (err: unknown) {
      if (!(err instanceof Error)) {
        return errorEnvelope(id, -32603, 'Internal error');
      }
      const typed = err as Error & { code?: string; rpcMethod?: string };
      if (typed.code === 'EXECUTOR_UNSUPPORTED') {
        return errorEnvelope(id, -32000, 'method not implemented in this build', {
          code: 'EXECUTOR_UNSUPPORTED',
          method: typed.rpcMethod ?? method,
        });
      }
      if (typed.code === 'INVALID_PARAMS') {
        return errorEnvelope(id, -32602, typed.message);
      }
      return errorEnvelope(id, -32603, `Internal error: ${typed.message}`);
    }
  };
}
