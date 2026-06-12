/**
 * config.diff RPC (S9 T3, ADR-0011) — the on-demand snapshot diff.
 *
 * The xinas_history store is root-only, so the api cannot diff
 * snapshots itself; this enumerated read-style method wraps the
 * bridge's `snapshot diff --format json`. Param validation rejects
 * malformed requests; bridge failures propagate as RPC errors (the
 * api route degrades them to EXECUTOR_UNAVAILABLE).
 */

import { createFixtureDiffSource, fixtureDir } from '../../probe/fixture.js';
import { XinasHistoryBridge } from '../../task/xinas-history-bridge.js';
import { execFileRunSubprocess } from '../../task/wiring.js';

export interface ConfigDiffDeps {
  snapshotDiff(from: string, to: string): Promise<unknown>;
}

/** Production/fixture deps: fixture mode reads config-diffs.json. */
export function makeConfigDiffDeps(): ConfigDiffDeps {
  const fdir = fixtureDir();
  if (fdir !== null) return createFixtureDiffSource(fdir);
  return new XinasHistoryBridge({ runSubprocess: execFileRunSubprocess });
}

export function makeConfigDiffHandler(deps: ConfigDiffDeps) {
  return async (params: unknown): Promise<unknown> => {
    const p = (params ?? {}) as { from?: unknown; to?: unknown };
    if (typeof p.from !== 'string' || p.from.length === 0) {
      throw new Error('config.diff: params.from must be a non-empty string');
    }
    if (typeof p.to !== 'string' || p.to.length === 0) {
      throw new Error('config.diff: params.to must be a non-empty string');
    }
    return deps.snapshotDiff(p.from, p.to);
  };
}
