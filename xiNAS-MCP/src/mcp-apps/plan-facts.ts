/**
 * Pure formatting for the S18 RAID Create View's plan panel (spec §7.1).
 *
 * Kept free of DOM and host-bridge imports so the unit suite can exercise it;
 * `raid-create.ts` owns the rendering and escapes whatever this returns.
 */

/** One entry of a plan's `affected_resources` (api-v1 `ResourceRef`). */
export interface AffectedResource {
  kind?: string;
  id?: string;
}

/**
 * Same shape as the S15 confirmation message renders — `kind id`, joined by
 * `; ` — so the operator reads one list in the App and in the MRTR prompt.
 */
export function affectedResourcesText(items: AffectedResource[] | undefined): string {
  if (items === undefined || items.length === 0) return '(none listed)';
  return items
    .map((item) => [item.kind, item.id].filter((part) => part !== undefined).join(' '))
    .join('; ');
}
