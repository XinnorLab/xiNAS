/**
 * A JSON-RPC protocol error raised on the modern path (S14 §5.1, S15 §11).
 * `httpStatus` is what transport.ts answers with (the 2026-07-28 schema
 * mandates 400 for -32021); `reasonClass` is for the audit trail only and
 * is never serialized to the client.
 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly data?: Record<string, unknown>;
  // `declare` suppresses the class-field emit (ES2022 target, fields
  // emitted): a normal field declaration would define this as an
  // enumerable own property on every instance, and JSON.stringify(err)
  // would then leak the audit-trail-only reason to the client. It is
  // instead defined via Object.defineProperty below, non-enumerable.
  declare readonly reasonClass?: string;

  constructor(
    code: number,
    message: string,
    opts: { httpStatus?: number; data?: Record<string, unknown>; reasonClass?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = opts.httpStatus ?? 200;
    if (opts.data !== undefined) this.data = opts.data;
    if (opts.reasonClass !== undefined) {
      Object.defineProperty(this, 'reasonClass', {
        value: opts.reasonClass,
        enumerable: false,
        writable: false,
      });
    }
  }
}

export const INVALID_PARAMS = -32602;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;

export function invalidRequestState(reasonClass: string): McpProtocolError {
  return new McpProtocolError(INVALID_PARAMS, 'invalid request state', { reasonClass });
}
