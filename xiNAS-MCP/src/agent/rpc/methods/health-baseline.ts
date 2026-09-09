/**
 * health.baseline RPC (S19c, spec §8.3, ADR-0018 §5) — the enumerated
 * ADR-0002 method behind the api's `GET /health/baseline`: runs one
 * baseline profile through the sandboxed {@link BaselineHost}, or (with
 * `sections: true`) asks the engine which sections it can check.
 *
 * The api resolves the profile name to a path inside the profiles dir and
 * caps the timeout (§8.4); this handler validates the shape and hands the
 * realpath allow-list, the process sandbox and the output caps to the host.
 * A failed, timed-out or unparseable engine run is a typed result, not an
 * RPC error.
 */

import type {
  BaselineHost,
  BaselineRunResult,
  BaselineSections,
} from '../../health/baseline-host.js';

export interface HealthBaselineDeps {
  host: BaselineHost;
  /** Default 30 s for `sections: true`. */
  defaultSectionsTimeoutS?: number;
}

export const BASELINE_TIMEOUT_MAX_S = 900;

const invalid = (msg: string): Error =>
  Object.assign(new Error(`health.baseline: ${msg}`), { code: 'INVALID_PARAMS' });

function timeoutSeconds(value: unknown, fallback: number | null): number {
  if (value === undefined) {
    if (fallback === null) throw invalid('params.timeout_s is required');
    return fallback;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > BASELINE_TIMEOUT_MAX_S
  ) {
    throw invalid(`params.timeout_s must be an integer between 1 and ${BASELINE_TIMEOUT_MAX_S}`);
  }
  return value;
}

export function makeHealthBaselineHandler(deps: HealthBaselineDeps) {
  const sectionsDefault = deps.defaultSectionsTimeoutS ?? 30;
  return async (params: unknown): Promise<BaselineRunResult | BaselineSections> => {
    const p = (params ?? {}) as { profile_path?: unknown; timeout_s?: unknown; sections?: unknown };
    if (p.sections !== undefined) {
      if (p.sections !== true) throw invalid('params.sections must be true when present');
      return deps.host.sections(timeoutSeconds(p.timeout_s, sectionsDefault) * 1000);
    }
    if (typeof p.profile_path !== 'string' || p.profile_path.length === 0) {
      throw invalid('params.profile_path is required');
    }
    if (!p.profile_path.startsWith('/') || /[\s\0]/.test(p.profile_path)) {
      throw invalid('params.profile_path must be an absolute path without whitespace');
    }
    return deps.host.run(p.profile_path, timeoutSeconds(p.timeout_s, null) * 1000);
  };
}
