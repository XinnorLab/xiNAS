import type { ApiError } from './envelope.js';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'INTERNAL';

/**
 * Phase 0 simplification: PERMISSION_DENIED maps to 401, not 403.
 * The api-v1.yaml ErrorCode enum has only one auth-failure code
 * (PERMISSION_DENIED); in Phase 0 every PERMISSION_DENIED comes from
 * the auth middleware (no/bad credentials), where 401 is correct
 * REST semantics. When role-based authorization lands in a later PR
 * and "authenticated but forbidden" becomes a real case, that handler
 * can override to 403 explicitly via res.status(403).json(...).
 */
const STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  PERMISSION_DENIED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  UNSUPPORTED: 422,
  INTERNAL: 500,
  TIMEOUT: 504,
};

export function errorStatus(code: ErrorCode): number {
  return STATUS_MAP[code];
}

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  remediation?: string,
): ApiError {
  const err: ApiError = { code, message };
  if (details !== undefined) err.details = details;
  if (remediation !== undefined) err.remediation = remediation;
  return err;
}

/**
 * Throwable error that the Express error handler unwraps into the
 * envelope error model. Use this from routes when you want to short-
 * circuit a request: `throw new ApiException('NOT_FOUND', 'no such share')`.
 */
export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    remediation?: string,
  ) {
    super(message);
    this.code = code;
    // Conditional assignment — exactOptionalPropertyTypes in tsconfig
    // refuses `this.details = details` when details is possibly
    // undefined and the field is declared `details?: ...`.
    if (details !== undefined) this.details = details;
    if (remediation !== undefined) this.remediation = remediation;
  }
}
