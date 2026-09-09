/**
 * Typed collection status (S19 §7, D-05; ADR-0018 §3).
 *
 * One closed enum per data source. Only `not_supported` (the tool is not
 * installed on the node) may become a `skipped` check; the other failures
 * become `degraded` with this block in their evidence, so a failed query
 * never looks like an absent component and never vanishes from `overall`.
 *
 * Pure and shared: the agent folds its dep calls into a {@link Section},
 * the api's check builders read it. lib/ imports from neither side.
 */

export type CollectionStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'permission_denied'
  | 'not_supported';

export interface CollectionErrorInfo {
  code: string;
  message: string;
}

export interface Section<T> {
  status: CollectionStatus;
  /** The agent's clock at the end of the collection — never the api's request time. */
  observed_at: string;
  value?: T;
  error?: CollectionErrorInfo;
}

/** What a check carries under `evidence.collection`. */
export interface CollectionEvidence {
  status: CollectionStatus;
  observed_at: string | null;
  code?: string;
  message?: string;
  /** 'kv' for facts read from the state store (no per-fact time in S19a). */
  source?: string;
}

/** `error | timeout | permission_denied` — the statuses that make coverage partial. */
export function isCollectionFailure(status: CollectionStatus): boolean {
  return status === 'error' || status === 'timeout' || status === 'permission_denied';
}

export function collectionEvidence(section: Section<unknown>): CollectionEvidence {
  return {
    status: section.status,
    observed_at: section.observed_at,
    ...(section.error !== undefined
      ? { code: section.error.code, message: section.error.message }
      : {}),
  };
}
