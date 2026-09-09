/**
 * Agent-side collection helper (S19a T1, spec §7.1 table).
 *
 * `collect()` runs one dep and folds its outcome into a typed
 * {@link Section}: it never throws, and it classifies Node/execFile
 * failures into the closed status set — `ENOENT` (the binary is absent)
 * is `not_supported`, `EACCES`/`EPERM` is `permission_denied`, a killed or
 * timed-out subprocess is `timeout`, everything else is `error`. A dep
 * that knows its own status throws {@link ProbeCollectionError} instead.
 */

import type { CollectionStatus, Section } from '../../lib/health/collection.js';

/** A dep that knows its own status throws this (e.g. HELPER_UNREACHABLE). */
export class ProbeCollectionError extends Error {
  constructor(
    readonly status: Exclude<CollectionStatus, 'success'>,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeCollectionError';
  }
}

export interface Classified {
  status: Exclude<CollectionStatus, 'success'>;
  code: string;
  message: string;
}

/** Node/execFile error → collection status. */
export function classifyNodeError(err: unknown): Classified {
  if (err instanceof ProbeCollectionError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (!(err instanceof Error)) return { status: 'error', code: 'ERROR', message: String(err) };
  const e = err as Error & { code?: unknown; killed?: unknown };
  if (e.code === 'ENOENT')
    return { status: 'not_supported', code: 'TOOL_ABSENT', message: e.message };
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return { status: 'permission_denied', code: String(e.code), message: e.message };
  }
  if (e.killed === true || e.code === 'ETIMEDOUT') {
    return { status: 'timeout', code: 'TIMEOUT', message: e.message };
  }
  return {
    status: 'error',
    code: typeof e.code === 'string' ? e.code : 'ERROR',
    message: e.message,
  };
}

/** Run one dep and fold its outcome into a Section. Never throws. */
export async function collect<T>(
  fn: () => Promise<T> | T,
  clock: () => number,
): Promise<Section<T>> {
  try {
    const value = await fn();
    return { status: 'success', observed_at: new Date(clock()).toISOString(), value };
  } catch (err) {
    const c = classifyNodeError(err);
    return {
      status: c.status,
      observed_at: new Date(clock()).toISOString(),
      error: { code: c.code, message: c.message },
    };
  }
}
