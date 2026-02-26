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
 */
export function parseResponse(response: { message?: string }): XRaidResponse {
  const raw = response.message ?? '';

  if (!raw) {
    return { raw, data: null, isEmpty: true };
  }

  try {
    return { raw, data: JSON.parse(raw), isEmpty: false };
  } catch {
    return { raw, data: raw, isEmpty: false };
  }
}

/**
 * Promisify a gRPC unary call and parse the response.
 */
export function callRpc<TRequest, TResponse extends { message?: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpcMethod: (req: TRequest, cb: (err: Error | null, res: TResponse) => void) => any,
  request: TRequest
): Promise<XRaidResponse> {
  return new Promise((resolve, reject) => {
    rpcMethod(request, (err: Error | null, response: TResponse) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(parseResponse(response));
    });
  });
}
