/**
 * Safe response parser for xiRAID gRPC ResponseMessage.
 *
 * All RPCs return: ResponseMessage { optional string message = 1; }
 *
 * The message field is USUALLY a JSON string, but can also be:
 *   - Plain text (rare, e.g. informational messages)
 *   - Empty string / undefined (for void operations)
 *
 * References:
 *   gRPC/xraid_client.py:call_remote() — json.loads with JSONDecodeError fallback
 *   gRPC/response.py:fill_resp()
 */

export interface XRaidResponse {
  /** Raw message string from ResponseMessage.message */
  raw: string;
  /** Parsed JSON data, or null if message was not valid JSON */
  data: unknown;
  /** True if message was empty or absent */
  isEmpty: boolean;
}

/**
 * Parse a ResponseMessage returned by any xiRAID gRPC RPC.
 *
 * Mirrors the behaviour of XNRgRPCClient.call_remote() in xraid_client.py.
 */
export function parseResponse(response: { message?: string }): XRaidResponse {
  const raw = response.message ?? '';

  if (!raw) {
    return { raw, data: null, isEmpty: true };
  }

  try {
    return { raw, data: JSON.parse(raw), isEmpty: false };
  } catch {
    // Plain text response — return as-is in data field as a string
    return { raw, data: raw, isEmpty: false };
  }
}

/**
 * Promisify a gRPC unary call and parse the response.
 *
 * Usage:
 *   const result = await callRpc(client.raidShow.bind(client), { name: 'data' });
 */
export function callRpc<TRequest, TResponse extends { message?: string }>(
  rpcMethod: (req: TRequest, cb: (err: Error | null, res: TResponse) => void) => void,
  request: TRequest
): Promise<XRaidResponse> {
  return new Promise((resolve, reject) => {
    rpcMethod(request, (err, response) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(parseResponse(response));
    });
  });
}
