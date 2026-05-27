export interface Warning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
}

export interface Envelope<T = unknown> {
  request_id: string;
  correlation_id: string;
  state_revision: number;
  operation_id?: string;
  warnings: Warning[];
  errors: ApiError[];
  links: Record<string, string>;
  result: T;
}

export interface BuildEnvelopeOptions<T> {
  request_id: string;
  correlation_id: string;
  state_revision: number;
  operation_id?: string;
  warnings?: Warning[];
  errors?: ApiError[];
  links?: Record<string, string>;
  result: T;
}

export function buildEnvelope<T>(opts: BuildEnvelopeOptions<T>): Envelope<T> {
  const env: Envelope<T> = {
    request_id: opts.request_id,
    correlation_id: opts.correlation_id,
    state_revision: opts.state_revision,
    warnings: opts.warnings ?? [],
    errors: opts.errors ?? [],
    links: opts.links ?? {},
    result: opts.result,
  };
  if (opts.operation_id !== undefined) env.operation_id = opts.operation_id;
  return env;
}
