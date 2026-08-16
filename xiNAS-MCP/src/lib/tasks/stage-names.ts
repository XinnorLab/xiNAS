/**
 * Synthetic stage names minted by the agent's TaskRunner.
 *
 * The runner wraps every executor's own stages with rows that no executor
 * declares: the xinas_history snapshots either side of the change, and the
 * rollback it runs on failure. The api's progress rollup must count only the
 * REAL executor stages against `stage_total`, so both sides read the names
 * from here — a second copy would drift the moment a name changes.
 */

export const SNAPSHOT_BEFORE_STAGE = 'snapshot_before';
export const SNAPSHOT_AFTER_STAGE = 'snapshot_after';
export const ROLLBACK_STAGE = 'rollback';

export const SYNTHETIC_STAGE_NAMES: ReadonlySet<string> = new Set([
  SNAPSHOT_BEFORE_STAGE,
  SNAPSHOT_AFTER_STAGE,
  ROLLBACK_STAGE,
]);
